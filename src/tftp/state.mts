/**
 * TFTP transfer state machine.
 *
 * Manages the lifecycle of a single TFTP transfer (one RRQ or WRQ).
 * Tracks current state, options, packet numbers, windowing, and timeouts.
 *
 * Replaces pTFTPd's `TFTPState` class with an explicit state machine.
 * Key improvements over the original:
 *   - Enum-based states with a state transition table (no if/elif chains)
 *   - RFC2349 timeout interval support (missing from pTFTPd)
 *   - Retransmit tracking with configurable retry count
 *   - No recursive tuple-chasing (pTFTPd's `send_response` could stack overflow)
 *   - Proper separation: state machine produces packets, server handles I/O
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  Opcode,
  ErrorCode,
  TransferMode,
  ValidatedOptions,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_WINDOW_SIZE,
  BLOCKNUM_RESET,
} from './types.mjs';
import { encodeDATA, encodeACK, encodeERROR, encodeOACK, validatedToRaw } from './protocol.mjs';
import { IPv4 } from '../shared/types.mjs';

// ─── Transfer states ───────────────────────────────────────────────

/** Transfer states for the TFTP state machine. */
export enum TransferState {
  /** Sending DATA packets (RRQ response). */
  Send = 'SEND',
  /** Sending OACK before data (RRQ/WRQ with options). */
  SendOACK = 'SEND_OACK',
  /** Sent the last DATA packet, waiting for final ACK. */
  SendLast = 'SEND_LAST',
  /** Receiving DATA packets (WRQ response). */
  Recv = 'RECV',
  /** Sending initial ACK for WRQ (before receiving data). */
  RecvACK = 'RECV_ACK',
  /** Transfer errored, sending ERROR packet. */
  Error = 'ERROR',
  /** Transfer complete. */
  Done = 'DONE',
}

// ─── Default timeout ────────────────────────────────────────────────

/** Default retransmit timeout in seconds. */
export const DEFAULT_TIMEOUT_SECS = 10;

/** Default maximum retransmit attempts before giving up. */
export const DEFAULT_MAX_RETRIES = 5;

// ─── Transfer context ───────────────────────────────────────────────

/** Information about the peer making the request. */
export interface PeerInfo {
  address: IPv4;
  port: number;
}

/** Result of advancing the state machine: packets to send. */
export interface StateResult {
  /** Buffer(s) to send to the peer. Multiple buffers for windowed sends. */
  packets: Buffer[];
  /** Whether the transfer is now complete. */
  done: boolean;
}

// ─── Transfer state machine ────────────────────────────────────────

/**
 * Manages state for a single TFTP transfer.
 *
 * Usage:
 *   1. Create with the request info (opcode, filename, mode, options)
 *   2. Call `advance()` to get the next packet(s) to send
 *   3. Feed received packets via `handleACK()`, `handleDATA()`, etc.
 *   4. Repeat until `state === TransferState.Done`
 */
export class TFTPTransfer {
  // ── Peer info ───────────────────────────────────────────────────

  /** The peer making the request. */
  readonly peer: PeerInfo;
  /** The TFTP opcode that initiated this transfer (RRQ or WRQ). */
  readonly opcode: Opcode;
  /** The server root path. */
  readonly root: string;
  /** The requested filename (relative). */
  readonly filename: string;
  /** The absolute, resolved file path. */
  readonly filepath: string;
  /** The transfer mode. */
  readonly mode: TransferMode;
  /** Whether to follow symbolic links. */
  readonly followSymlinks: boolean;

  // ── State ───────────────────────────────────────────────────────

  /** Current transfer state. */
  state: TransferState = TransferState.Done;
  /** Error code if state is Error. */
  errorCode: ErrorCode = ErrorCode.NotDefined;
  /** Error message if state is Error. */
  errorMessage = '';

  // ── Options ─────────────────────────────────────────────────────

  /** Negotiated transfer options. */
  opts: ValidatedOptions = {
    blksize: DEFAULT_BLOCK_SIZE,
    windowsize: DEFAULT_WINDOW_SIZE,
  };

  // ── Transfer tracking ───────────────────────────────────────────

  /** Current DATA packet number. */
  blockNum = 0;
  /** Block number of the last ACK'd window boundary. */
  lastAcked = 0;
  /** Total DATA packets sent or received. */
  totalPackets = 0;
  /** Whether to wrap block numbers at 65536. */
  wrapBlockNum = true;
  /** File size in bytes (set when file is opened). */
  filesize = 0;

  // ── Send buffer (for netascii overflow across block boundaries) ─

  /** Leftover data from a previous read that didn't fit in a block. */
  sendBuffer = Buffer.alloc(0);

  // ── Receive tracking ────────────────────────────────────────────

  /** Data received in the current DATA packet (before writing to file). */
  recvData: Buffer = Buffer.alloc(0);
  /** Bytes received so far. */
  bytesReceived = 0;
  /** Bytes sent so far. */
  bytesSent = 0;
  /** Current file read offset for RRQ transfers. */
  fileOffset = 0;
  /** Open file handle for the current transfer (server side). */
  fileHandle: fs.FileHandle | null = null;

  // ── Timeout / retransmit ────────────────────────────────────────

  /** Last activity timestamp (ms since epoch). */
  lastSeen = Date.now();
  /** Number of retransmit attempts for the current packet. */
  retries = 0;
  /** Maximum retransmit attempts. */
  maxRetries = DEFAULT_MAX_RETRIES;

  /**
   * Transfer ID — the remote port used by the peer for this transfer.
   * Set when the first response packet is sent/received.
   */
  tid: number | undefined;

  constructor(
    peer: PeerInfo,
    opcode: Opcode,
    root: string,
    filename: string,
    mode: TransferMode,
    opts?: Partial<ValidatedOptions>,
    wrapBlockNum = true,
    followSymlinks = false,
  ) {
    this.peer = peer;
    this.opcode = opcode;
    this.root = root;
    this.filename = filename;
    this.mode = mode;
    this.wrapBlockNum = wrapBlockNum;
    this.followSymlinks = followSymlinks;

    // Resolve and validate the file path
    this.filepath = path.resolve(root, filename);

    // Apply options if provided
    if (opts) {
      this.opts = {
        blksize: opts.blksize ?? DEFAULT_BLOCK_SIZE,
        windowsize: opts.windowsize ?? DEFAULT_WINDOW_SIZE,
        timeout: opts.timeout,
        tsize: opts.tsize,
      };
    }
  }

  // ── Touch / timeout ─────────────────────────────────────────────

  /** Update the last-seen timestamp (resets the watchdog). */
  touch(): void {
    this.lastSeen = Date.now();
  }

  /** Get the retransmit timeout in milliseconds. */
  getTimeoutMs(): number {
    return (this.opts.timeout ?? DEFAULT_TIMEOUT_SECS) * 1000;
  }

  /** Check if this transfer has timed out. */
  isTimedOut(): boolean {
    const elapsed = Date.now() - this.lastSeen;
    return elapsed > this.getTimeoutMs() * (this.retries + 1);
  }

  /** Increment retry counter. Returns false if max retries exceeded. */
  incrementRetry(): boolean {
    this.retries++;
    return this.retries <= this.maxRetries;
  }

  // ── Option negotiation ──────────────────────────────────────────

  /**
   * Set negotiated options. Called after option validation.
   * If tsize is 0 (client asking for size), replaces with actual filesize.
   */
  setOptions(opts: ValidatedOptions): void {
    if (opts.tsize === 0) {
      opts.tsize = this.filesize;
    }
    this.opts = opts;
  }

  // ── State transitions ───────────────────────────────────────────

  /**
   * Transition to the Error state.
   */
  setError(code: ErrorCode, message = ''): void {
    this.state = TransferState.Error;
    this.errorCode = code;
    this.errorMessage = message;
  }

  /**
   * Initialize state for an RRQ (read request / download).
   * After calling this, `advanceSend()` will produce OACK or DATA packets.
   */
  initRRQ(hasOptions: boolean): void {
    this.blockNum = 0;
    this.state = hasOptions ? TransferState.SendOACK : TransferState.Send;
  }

  /**
   * Initialize state for a WRQ (write request / upload).
   * After calling this, `advanceSend()` will produce OACK or ACK(0).
   */
  initWRQ(hasOptions: boolean): void {
    this.blockNum = 1; // WRQ DATA packets start at 1
    this.state = hasOptions ? TransferState.SendOACK : TransferState.RecvACK;
  }

  // ── Advance: produce packets to send ────────────────────────────

  /**
   * Advance the state machine and produce the next packet(s) to send.
   *
   * For windowed sends, this may return multiple DATA packets.
   * Returns null if no packets need to be sent (waiting for peer).
   */
  advanceSend(): StateResult | null {
    this.touch();

    switch (this.state) {
      case TransferState.SendOACK:
        return this.advanceSendOACK();
      case TransferState.Send:
        // The server drives DATA production via produceDataPacket() in a loop.
        // The state machine has nothing to send here.
        return null;
      case TransferState.SendLast:
        // Waiting for final ACK, nothing to send
        return null;
      case TransferState.RecvACK:
        return this.advanceRecvACK();
      case TransferState.Recv:
        // Waiting for DATA from peer, nothing to send
        return null;
      case TransferState.Error:
        return this.advanceError();
      case TransferState.Done:
        return null;
      default:
        return null;
    }
  }

  /**
   * OACK state: send option acknowledgment, then transition to
   * Send (for RRQ) or Recv (for WRQ).
   *
   * Per RFC2347, the OACK flow is:
   *   - RRQ: Server sends OACK → Client ACKs(0) → Server sends DATA
   *   - WRQ: Server sends OACK → Client sends DATA → Server ACKs
   *
   * We do NOT send DATA immediately after OACK — we wait for the client's
   * ACK(0) first. This avoids the race condition where the server advances
   * blockNum past 0 before the ACK(0) arrives.
   */
  private advanceSendOACK(): StateResult {
    const rawOpts = validatedToRaw(this.opts);
    const packet = encodeOACK(rawOpts);

    // Transition based on whether this is a read or write
    this.state = this.opcode === Opcode.RRQ ? TransferState.Send : TransferState.Recv;

    // Return just the OACK — the server will send DATA after receiving ACK(0)
    return { packets: [packet], done: false };
  }

  /**
   * Send state: produce DATA packets for windowed transfer.
   * Returns one or more DATA packets depending on window size.
   */
  /**
   * Produce a single DATA packet from the given file data.
   * Handles block numbering, windowing, and netascii conversion.
   *
   * @param fileData - Data read from the file (may be more or less than blksize).
   * @param isEOF - Whether the file has been fully read.
   * @returns The DATA packet buffer, or null if no packet to send.
   */
  produceDataPacket(fileData: Buffer, isEOF: boolean): Buffer | null {
    // Combine with any leftover from previous read
    let data = Buffer.concat([this.sendBuffer, fileData]);
    this.sendBuffer = Buffer.alloc(0);

    // Increment block number
    this.blockNum++;
    this.totalPackets++;

    // Block number wraparound — must happen before encoding
    // (blockNum is uint16, max valid value is 65535)
    if (this.blockNum > 65535 && this.wrapBlockNum) {
      this.blockNum = BLOCKNUM_RESET;
    }

    const blksize = this.opts.blksize;

    // Split if data exceeds block size
    if (data.length > blksize) {
      this.sendBuffer = data.subarray(blksize);
      data = data.subarray(0, blksize);
    }

    // If we got less than blksize, this is the last packet
    if (data.length < blksize || isEOF) {
      if (data.length < blksize) {
        this.state = TransferState.SendLast;
      }
    }

    return encodeDATA(this.blockNum, data);
  }

  /**
   * Check if we should send more DATA packets within the current window.
   * Returns true if the current blockNum hasn't reached the window boundary.
   */
  shouldSendMoreInWindow(): boolean {
    if (this.state !== TransferState.Send) return false;
    const windowEnd = this.lastAcked + this.opts.windowsize;
    return this.blockNum < windowEnd;
  }

  /**
   * RecvACK state: send ACK(0) to acknowledge the WRQ, then transition
   * to Recv to start accepting DATA packets.
   */
  private advanceRecvACK(): StateResult {
    this.state = TransferState.Recv;
    return { packets: [encodeACK(0)], done: false };
  }

  /**
   * Error state: send ERROR packet.
   */
  private advanceError(): StateResult {
    const packet = encodeERROR(this.errorCode, this.errorMessage || undefined);
    this.state = TransferState.Done;
    return { packets: [packet], done: true };
  }

  // ── Handle incoming packets ─────────────────────────────────────

  /**
   * Handle an ACK packet (received during a send/RRQ transfer).
   *
   * @param blockNum - The block number being acknowledged.
   * @returns State result with any packets to send, or null.
   */
  handleACK(blockNum: number): StateResult | null {
    this.touch();
    this.retries = 0; // Reset retry counter on successful ACK

    if (this.state === TransferState.SendLast) {
      // Final ACK received — transfer complete
      this.state = TransferState.Done;
      return { packets: [], done: true };
    }

    if (this.state === TransferState.Send) {
      // ACK(0) is the OACK acknowledgment — start sending data
      if (blockNum === 0 && this.totalPackets === 0) {
        // OACK ACK — signal the server to start sending data
        return { packets: [], done: false };
      }

      // Check for block number mismatch
      if (blockNum !== this.blockNum) {
        // Duplicate ACK of previous window — ignore
        if (blockNum === this.blockNum - 1) {
          return null;
        }
        // Allow ACK of last sent block when window > 1
        if (blockNum === this.blockNum) {
          // Already acked, ignore
          return null;
        }
        this.setError(ErrorCode.IllegalOperation, 'ACK block number mismatch');
        return this.advanceError();
      }

      // Update the last acked boundary
      this.lastAcked = blockNum;

      // Server will call produceDataPacket() in a loop to send the next window
      return null;
    }

    return null;
  }

  /**
   * Handle a DATA packet (received during a recv/WRQ transfer).
   *
   * @param blockNum - The block number of the received data.
   * @param data - The data payload.
   * @returns State result with ACK packet(s) to send, or error.
   */
  handleDATA(blockNum: number, data: Buffer): StateResult | null {
    this.touch();
    this.retries = 0;

    if (this.state !== TransferState.Recv) {
      return null;
    }

    // Check block number
    if (blockNum !== this.blockNum) {
      if (blockNum === this.blockNum - 1) {
        // Duplicate DATA — re-ACK the previous block
        return { packets: [encodeACK(this.blockNum - 1)], done: false };
      }
      this.setError(ErrorCode.IllegalOperation, 'DATA block number mismatch');
      return this.advanceError();
    }

    // Check data size against blksize
    if (data.length > this.opts.blksize) {
      this.setError(ErrorCode.IllegalOperation, 'DATA exceeds negotiated blksize');
      return this.advanceError();
    }

    // Store data for the caller to write to file
    this.recvData = data;
    this.bytesReceived += data.length;

    const isLast = data.length < this.opts.blksize;

    // Advance block number
    const currentBlock = this.blockNum;
    if (!isLast) {
      this.blockNum++;
      this.totalPackets++;

      // Block number wraparound
      if (this.blockNum > 65535 && this.wrapBlockNum) {
        this.blockNum = BLOCKNUM_RESET;
      }
    }

    // ACK when window boundary reached or transfer complete
    const windowEnd = this.lastAcked + this.opts.windowsize;
    if (isLast || currentBlock >= windowEnd) {
      this.lastAcked = currentBlock;

      if (isLast) {
        this.state = TransferState.Done;
        return { packets: [encodeACK(currentBlock)], done: true };
      }

      return { packets: [encodeACK(currentBlock)], done: false };
    }

    // Within window, don't ACK yet
    return null;
  }

  /**
   * Handle an ERROR packet from the peer.
   * Transitions to Done state.
   */
  handleError(_errorCode: ErrorCode, _message: string): StateResult {
    this.state = TransferState.Done;
    return { packets: [], done: true };
  }

  // ── Utility ─────────────────────────────────────────────────────

  /**
   * Check if the resolved filepath is within the server root.
   * Prevents path traversal attacks.
   */
  isPathInRoot(): boolean {
    // Normalize root without trailing separator to avoid double-sep edge case
    const normalizedRoot = this.root.endsWith(path.sep) ? this.root.slice(0, -1) : this.root;
    const normalized = path.normalize(this.filepath);
    if (!normalized.startsWith(normalizedRoot + path.sep) && normalized !== normalizedRoot) {
      return false;
    }

    // If symlinks are not allowed, resolve the real path and verify it's still within root
    if (!this.followSymlinks) {
      try {
        const realPath = fsSync.realpathSync(this.filepath);
        const realRoot = fsSync.realpathSync(this.root);
        if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
          return false;
        }
      } catch {
        // File doesn't exist — can't be a symlink target, path traversal check already passed
      }
    }

    return true;
  }

  /**
   * Get a log-friendly summary of this transfer.
   */
  toString(): string {
    return `TFTPTransfer(${this.state}) peer=${this.peer.address}:${this.peer.port} file=${this.filename} blksize=${this.opts.blksize} window=${this.opts.windowsize}`;
  }
}
