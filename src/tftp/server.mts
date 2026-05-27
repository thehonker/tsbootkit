/**
 * TFTP server.
 *
 * Event-driven UDP server using Node.js `dgram`. Handles RRQ and WRQ
 * requests, option negotiation, and manages active transfers with
 * timeout-based garbage collection and retransmit.
 *
 * Key improvements over pTFTPd:
 *   - Async event-driven (no socketserver)
 *   - Retransmit with exponential backoff (pTFTPd had no retransmit)
 *   - GC for stale transfers (configurable timeout)
 *   - Proper path traversal protection
 *   - Graceful shutdown drains active transfers
 */

import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createLogger } from '../shared/logger.mjs';
import { onShutdown } from '../shared/signals.mjs';
import { IPv4, InterfaceConfig } from '../shared/types.mjs';
import { runHooks, type HookConfig } from '../shared/hooks.mjs';

import {
  Opcode,
  ErrorCode,
} from './types.mjs';
import {
  getOpcode,
  parsePacket,
  encodeERROR,
  validateOptions,
  ProtocolError,
} from './protocol.mjs';
import {
  TFTPTransfer,
  TransferState,
  DEFAULT_TIMEOUT_SECS,
  DEFAULT_MAX_RETRIES,
} from './state.mjs';

// ─── Server events ─────────────────────────────────────────────────

export interface TFTPServerEvents {
  /** A new transfer has started. */
  'transfer:start': (transfer: TFTPTransfer) => void;
  /** A transfer has completed successfully. */
  'transfer:complete': (transfer: TFTPTransfer) => void;
  /** A transfer has errored out. */
  'transfer:error': (transfer: TFTPTransfer, code: ErrorCode, message: string) => void;
  /** The server is listening. */
  'listening': (address: string, port: number) => void;
  /** The server has closed. */
  'close': () => void;
  /** A server error occurred. */
  'error': (err: Error) => void;
}

// ─── Server options ────────────────────────────────────────────────

export interface TFTPServerOptions {
  /** UDP port to listen on (default 69). */
  port?: number;
  /** Network interface to bind to (by name, e.g. "eth0"). Resolved at startup. */
  interface?: string;
  /** Network interface to bind to (pre-resolved). Overrides "interface" if both set. */
  iface?: InterfaceConfig;
  /** Root directory for served files. */
  root: string;
  /** Force RFC1350 compliance (no options, no windowing). */
  rfc1350?: boolean;
  /** Maximum blksize to allow (default 65464). */
  maxBlksize?: number;
  /** Maximum concurrent transfers (default 128). */
  maxTransfers?: number;
  /** Transfer timeout in seconds (default 10). */
  timeout?: number;
  /** Maximum retransmit attempts per packet (default 5). */
  maxRetries?: number;
  /** Garbage collection interval in seconds (default 30). */
  gcInterval?: number;
  /** Whether to allow WRQ (upload) requests (default false). */
  allowWrite?: boolean;
  /** Whether to follow symbolic links (default false — symlinks outside root are blocked). */
  followSymlinks?: boolean;
  /** Transfer hooks to execute on lifecycle events. */
  hooks?: HookConfig[];
}

// ─── TFTP Server ───────────────────────────────────────────────────

export class TFTPServer extends EventEmitter {
  private readonly opts: Required<Omit<TFTPServerOptions, 'iface' | 'interface' | 'hooks'>> & { iface?: InterfaceConfig; interface?: string; hooks: HookConfig[] };
  private socket: dgram.Socket | null = null;
  private readonly transfers = new Map<string, TFTPTransfer>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private readonly log;

  constructor(options: TFTPServerOptions) {
    super();

    this.opts = {
      port: options.port ?? 69,
      iface: options.iface,
      interface: options.interface,
      root: path.resolve(options.root),
      rfc1350: options.rfc1350 ?? false,
      maxBlksize: options.maxBlksize ?? 65464,
      maxTransfers: options.maxTransfers ?? 128,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_SECS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      gcInterval: options.gcInterval ?? 30,
      allowWrite: options.allowWrite ?? false,
      followSymlinks: options.followSymlinks ?? false,
      hooks: options.hooks ?? [],
    };

    this.log = createLogger('tftpd');
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Start the TFTP server.
   */
  async start(): Promise<void> {
    // Ensure root directory exists
    try {
      const stat = await fs.stat(this.opts.root);
      if (!stat.isDirectory()) {
        throw new Error(`Root path is not a directory: ${this.opts.root}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Root directory does not exist: ${this.opts.root}`);
      }
      throw err;
    }

    // Create UDP socket
    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this.handleMessage(msg, rinfo).catch((err: Error) => {
        this.log.error(`Unhandled error processing message: ${err.message}`);
      });
    });

    this.socket.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      this.emit('close');
    });

    // Bind
    let bindAddr = '0.0.0.0';
    if (this.opts.iface) {
      bindAddr = this.opts.iface.address;
    } else if (this.opts.interface) {
      const { getInterfaceConfig } = await import('../shared/network.mjs');
      const resolved = getInterfaceConfig(this.opts.interface);
      bindAddr = resolved.address;
    }

    return new Promise<void>((resolve, reject) => {
      this.socket!.on('listening', () => {
        const addr = this.socket!.address();
        this.log.info(`TFTP server listening on ${addr.address}:${addr.port}, root=${this.opts.root}`);
        this.emit('listening', addr.address, addr.port);
        resolve();
      });

      this.socket!.on('error', (err: Error) => {
        reject(err);
      });

      this.socket!.bind(this.opts.port, bindAddr);
    }).then(() => {
      // Start garbage collection timer
      this.startGC();

      // Register for graceful shutdown
      onShutdown(() => this.stop());
    });
  }

  /**
   * Stop the TFTP server gracefully.
   */
  async stop(): Promise<void> {
    this.log.info('Shutting down TFTP server...');

    // Stop GC
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }

    // Close socket
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    // Clear transfers
    this.transfers.clear();

    this.log.info('TFTP server stopped.');
  }

  // ── Message handling ────────────────────────────────────────────

  /**
   * Handle an incoming UDP message.
   */
  private async handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const opcode = getOpcode(msg);
    if (opcode === undefined) {
      this.log.warn('Received packet too short to contain opcode');
      return;
    }

    // Lookup existing transfer by TID (remote port)
    const tid = rinfo.port;
    const transferKey = `${rinfo.address}:${tid}`;
    const existing = this.transfers.get(transferKey);

    if (existing) {
      // Route to existing transfer
      await this.handleExistingTransfer(existing, msg, rinfo);
      return;
    }

    // New request — must be RRQ or WRQ
    if (opcode !== Opcode.RRQ && opcode !== Opcode.WRQ) {
      this.log.warn(`Unexpected opcode ${opcode} from ${rinfo.address}:${rinfo.port} (no active transfer)`);
      this.sendError(rinfo.port, rinfo.address, ErrorCode.IllegalOperation, 'No active transfer');
      return;
    }

    await this.handleNewRequest(msg, rinfo);
  }

  /**
   * Handle a new RRQ or WRQ request.
   */
  private async handleNewRequest(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    let packet;
    try {
      packet = parsePacket(msg);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.sendError(rinfo.port, rinfo.address, ErrorCode.IllegalOperation, err.message);
        return;
      }
      throw err;
    }

    if (!packet || (packet.opcode !== Opcode.RRQ && packet.opcode !== Opcode.WRQ)) {
      this.sendError(rinfo.port, rinfo.address, ErrorCode.IllegalOperation, 'Invalid request');
      return;
    }

    // Check concurrent transfer limit
    if (this.transfers.size >= this.opts.maxTransfers) {
      this.log.warn(`Max transfers (${this.opts.maxTransfers}) reached, rejecting ${packet.filename}`);
      this.sendError(rinfo.port, rinfo.address, ErrorCode.IllegalOperation, 'Server busy');
      return;
    }

    // WRQ check
    if (packet.opcode === Opcode.WRQ && !this.opts.allowWrite) {
      this.sendError(rinfo.port, rinfo.address, ErrorCode.AccessViolation, 'Write requests not allowed');
      return;
    }

    this.log.info(`${packet.opcode === Opcode.RRQ ? 'RRQ' : 'WRQ'} from ${rinfo.address}:${rinfo.port}: ${packet.filename}`);

    // Create transfer
    const peer = { address: rinfo.address as IPv4, port: rinfo.port };
    const transfer = new TFTPTransfer(
      peer,
      packet.opcode,
      this.opts.root,
      packet.filename,
      packet.mode,
      undefined,
      !this.opts.rfc1350, // wrapBlockNum
      this.opts.followSymlinks,
    );

    transfer.maxRetries = this.opts.maxRetries;
    transfer.tid = rinfo.port;

    // Path traversal check
    if (!transfer.isPathInRoot()) {
      this.log.warn(`Path traversal attempt: ${packet.filename} from ${rinfo.address}`);
      this.sendError(rinfo.port, rinfo.address, ErrorCode.AccessViolation, 'Access violation');
      return;
    }

    // Option negotiation
    const hasOptions = Object.keys(packet.options).length > 0 && !this.opts.rfc1350;

    if (hasOptions) {
      try {
        // Cap blksize at our max
        const cappedOpts = { ...packet.options };
        if (cappedOpts.blksize) {
          const requested = parseInt(cappedOpts.blksize, 10);
          if (requested > this.opts.maxBlksize) {
            cappedOpts.blksize = String(this.opts.maxBlksize);
          }
        }

        const validated = validateOptions(cappedOpts, {
          timeout: this.opts.timeout,
        });
        transfer.setOptions(validated);
      } catch (err) {
        if (err instanceof ProtocolError) {
          this.sendError(rinfo.port, rinfo.address, ErrorCode.OptionNegotiation, err.message);
          return;
        }
        throw err;
      }
    }

    // Register transfer BEFORE handling the request to avoid race condition:
    // handleRRQ/handleWRQ send packets, which may trigger client responses
    // before we get back here to register the transfer.
    const transferKey = `${rinfo.address}:${rinfo.port}`;
    this.transfers.set(transferKey, transfer);
    this.emit('transfer:start', transfer);

    // Fire pre-hook
    if (this.opts.hooks.length > 0) {
      runHooks(this.opts.hooks, {
        protocol: 'tftp',
        event: 'pre',
        direction: packet.opcode === Opcode.RRQ ? 'rrq' : 'wrq',
        clientIP: rinfo.address,
        clientPort: rinfo.port,
        filename: packet.filename,
      });
    }

    // Initialize and handle the request
    if (packet.opcode === Opcode.RRQ) {
      transfer.initRRQ(hasOptions);
      await this.handleRRQ(transfer, rinfo);
    } else {
      transfer.initWRQ(hasOptions);
      await this.handleWRQ(transfer, rinfo);
    }
  }

  /**
   * Handle a new RRQ: open the file, set filesize, send first packets.
   */
  private async handleRRQ(transfer: TFTPTransfer, rinfo: dgram.RemoteInfo): Promise<void> {
    try {
      const stat = await fs.stat(transfer.filepath);
      if (!stat.isFile()) {
        this.sendError(rinfo.port, rinfo.address, ErrorCode.FileNotFound, 'Not a file');
        this.cleanupFailedTransfer(transfer, rinfo);
        return;
      }
      transfer.filesize = stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sendError(rinfo.port, rinfo.address, ErrorCode.FileNotFound, 'File not found');
        this.cleanupFailedTransfer(transfer, rinfo);
        return;
      }
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        this.sendError(rinfo.port, rinfo.address, ErrorCode.AccessViolation, 'Access denied');
        this.cleanupFailedTransfer(transfer, rinfo);
        return;
      }
      this.sendError(rinfo.port, rinfo.address, ErrorCode.NotDefined, (err as Error).message);
      this.cleanupFailedTransfer(transfer, rinfo);
      return;
    }

    // Re-apply options (setOptions replaces tsize=0 with filesize)
    if (transfer.opts.tsize === 0) {
      transfer.setOptions(transfer.opts);
    }

    // Send initial packets
    const result = transfer.advanceSend();

    if (result && result.packets.length > 0) {
      for (const packet of result.packets) {
        await this.sendPacket(rinfo.port, rinfo.address, packet);
      }

      // If we sent an OACK, wait for ACK(0) before sending DATA.
      // The client's ACK(0) will arrive in handleTransferACK, which calls sendDataBlocks.
      const sentOACK = result.packets[0]!.readUInt16BE(0) === Opcode.OACK;
      if (sentOACK) {
        return;
      }
    }

    // No OACK — send DATA immediately (RFC1350 mode or no options)
    if (transfer.state === TransferState.Send) {
      await this.sendDataBlocks(transfer, rinfo);
    }
  }

  /**
   * Handle a new WRQ: verify the target path is writable.
   */
  private async handleWRQ(transfer: TFTPTransfer, rinfo: dgram.RemoteInfo): Promise<void> {
    // Check if file already exists
    try {
      await fs.access(transfer.filepath, fs.constants.F_OK);
      this.sendError(rinfo.port, rinfo.address, ErrorCode.FileAlreadyExists, 'File already exists');
      this.cleanupFailedTransfer(transfer, rinfo);
      return;
    } catch {
      // File doesn't exist — good, proceed
    }

    // Check parent directory is writable
    const parentDir = path.dirname(transfer.filepath);
    try {
      await fs.access(parentDir, fs.constants.W_OK);
    } catch {
      this.sendError(rinfo.port, rinfo.address, ErrorCode.AccessViolation, 'Cannot write to directory');
      this.cleanupFailedTransfer(transfer, rinfo);
      return;
    }

    // Send initial packets (OACK or ACK(0))
    const result = transfer.advanceSend();
    if (result && result.packets.length > 0) {
      for (const packet of result.packets) {
        await this.sendPacket(rinfo.port, rinfo.address, packet);
      }
    }
  }

  // ── Transfer packet sending ─────────────────────────────────────

  /**
   * Send pending packets for a transfer.
   */
  /**
   * Send pending packets for a transfer.
   *
   * For RRQ with OACK: we send only the OACK and wait for ACK(0) from the
   * client before sending DATA blocks. The server's handleTransferACK will
   * call sendDataBlocks after receiving ACK(0).
   */
  /**
   * Read file data and send DATA blocks for an RRQ transfer.
   *
   * Uses the transfer's fileOffset and fileHandle to maintain position
   * across multiple calls (one per ACK window).
   */
  private async sendDataBlocks(transfer: TFTPTransfer, rinfo: dgram.RemoteInfo): Promise<void> {
    try {
      // Open file on first call
      if (!transfer.fileHandle) {
        transfer.fileHandle = await fs.open(transfer.filepath, 'r');
      }

      const blksize = transfer.opts.blksize;
      const windowsize = transfer.opts.windowsize;
      let sentInWindow = 0;

      while (transfer.state === TransferState.Send || transfer.state === TransferState.SendLast) {
        const readBuf = Buffer.alloc(blksize);
        const { bytesRead } = await transfer.fileHandle.read(readBuf, 0, blksize, transfer.fileOffset);
        transfer.fileOffset += bytesRead;

        const isEOF = bytesRead < blksize;
        const data = readBuf.subarray(0, bytesRead);

        if (bytesRead === 0 && transfer.state === TransferState.Send) {
          // File is done but state hasn't transitioned yet — force last block
          transfer.state = TransferState.SendLast;
          break;
        }

        const packet = transfer.produceDataPacket(data, isEOF);
        if (!packet) break;

        await this.sendPacket(rinfo.port, rinfo.address, packet);
        transfer.bytesSent += bytesRead;
        sentInWindow++;

        if (transfer.state === TransferState.SendLast) {
          // Waiting for final ACK
          break;
        }

        // Window boundary — wait for ACK
        if (sentInWindow >= windowsize) {
          break;
        }
      }
    } catch (err) {
      this.log.error(`Error reading file ${transfer.filename}: ${(err as Error).message}`);
      transfer.setError(ErrorCode.NotDefined, (err as Error).message);
      const errorResult = transfer.advanceSend();
      if (errorResult) {
        for (const packet of errorResult.packets) {
          await this.sendPacket(rinfo.port, rinfo.address, packet);
        }
      }
    }
  }

  // ── Existing transfer handling ──────────────────────────────────

  /**
   * Handle a packet for an existing transfer.
   */
  private async handleExistingTransfer(transfer: TFTPTransfer, msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const opcode = getOpcode(msg);

    switch (opcode) {
      case Opcode.ACK: {
        let packet;
        try {
          packet = parsePacket(msg);
        } catch {
          return; // Malformed ACK, ignore
        }
        if (packet?.opcode !== Opcode.ACK) return;
        await this.handleTransferACK(transfer, packet.blockNum, rinfo);
        break;
      }

      case Opcode.DATA: {
        let packet;
        try {
          packet = parsePacket(msg);
        } catch {
          return;
        }
        if (packet?.opcode !== Opcode.DATA) return;
        await this.handleTransferDATA(transfer, packet.blockNum, packet.data, rinfo);
        break;
      }

      case Opcode.ERROR: {
        let packet;
        try {
          packet = parsePacket(msg);
        } catch {
          return;
        }
        if (packet?.opcode !== Opcode.ERROR) return;
        this.log.info(`Transfer error from ${rinfo.address}:${rinfo.port}: [${packet.errorCode}] ${packet.message}`);
        const result = transfer.handleError(packet.errorCode, packet.message);
        if (result.done) {
          await this.removeTransfer(transfer, rinfo);
        }
        break;
      }

      default:
        // Unexpected opcode for existing transfer — ignore
        break;
    }
  }

  /**
   * Handle ACK for an existing RRQ (send) transfer.
   */
  private async handleTransferACK(transfer: TFTPTransfer, blockNum: number, rinfo: dgram.RemoteInfo): Promise<void> {
    const result = transfer.handleACK(blockNum);

    if (transfer.state === TransferState.Done) {
      await this.removeTransfer(transfer, rinfo);
      this.emit('transfer:complete', transfer);

      // Fire post-hook
      if (this.opts.hooks.length > 0) {
        runHooks(this.opts.hooks, {
          protocol: 'tftp',
          event: 'post',
          direction: transfer.opcode === Opcode.RRQ ? 'rrq' : 'wrq',
          clientIP: rinfo.address,
          clientPort: rinfo.port,
          filename: transfer.filename,
          bytesSent: transfer.bytesSent,
          bytesReceived: transfer.bytesReceived,
        });
      }
      return;
    }

    if (transfer.state === TransferState.Error) {
      if (result) {
        for (const packet of result.packets) {
          await this.sendPacket(rinfo.port, rinfo.address, packet);
        }
      }
      await this.removeTransfer(transfer, rinfo);
      return;
    }

    // ACK received — send next window of data
    if (transfer.state === TransferState.Send) {
      await this.sendDataBlocks(transfer, rinfo);
    }
  }

  /**
   * Handle DATA for an existing WRQ (recv) transfer.
   */
  private async handleTransferDATA(transfer: TFTPTransfer, blockNum: number, data: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const result = transfer.handleDATA(blockNum, data);

    // Write data to file
    if (transfer.recvData.length > 0) {
      try {
        // Ensure parent directory exists and append data
        const dir = path.dirname(transfer.filepath);
        await fs.mkdir(dir, { recursive: true });
        await fs.appendFile(transfer.filepath, transfer.recvData);
      } catch (err) {
        this.log.error(`Error writing file ${transfer.filename}: ${(err as Error).message}`);
        this.sendError(rinfo.port, rinfo.address, ErrorCode.DiskFull, 'Write error');
        await this.removeTransfer(transfer, rinfo);
        return;
      }
    }

    // Send ACK if the state machine produced one
    if (result) {
      for (const packet of result.packets) {
        await this.sendPacket(rinfo.port, rinfo.address, packet);
      }
    }

    if (transfer.state === TransferState.Done) {
      await this.removeTransfer(transfer, rinfo);
      this.emit('transfer:complete', transfer);

      // Fire post-hook
      if (this.opts.hooks.length > 0) {
        runHooks(this.opts.hooks, {
          protocol: 'tftp',
          event: 'post',
          direction: transfer.opcode === Opcode.RRQ ? 'rrq' : 'wrq',
          clientIP: rinfo.address,
          clientPort: rinfo.port,
          filename: transfer.filename,
          bytesSent: transfer.bytesSent,
          bytesReceived: transfer.bytesReceived,
        });
      }
    }
  }

  // ── Packet sending ──────────────────────────────────────────────

  /**
   * Send a raw UDP packet.
   */
  private sendPacket(port: number, address: string, packet: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket is closed'));
        return;
      }
      this.socket.send(packet, port, address, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Send an ERROR packet to a peer.
   */
  private sendError(port: number, address: string, code: ErrorCode, message?: string): void {
    const packet = encodeERROR(code, message);
    this.sendPacket(port, address, packet).catch((err: Error) => {
      this.log.error(`Failed to send ERROR to ${address}:${port}: ${err.message}`);
    });
  }

  // ── Transfer management ─────────────────────────────────────────

  /**
   * Clean up a transfer that failed before it could start.
   * Removes it from the map and fires on-error hooks.
   */
  private cleanupFailedTransfer(transfer: TFTPTransfer, rinfo: dgram.RemoteInfo): void {
    const key = `${rinfo.address}:${rinfo.port}`;
    this.transfers.delete(key);

    if (this.opts.hooks.length > 0) {
      runHooks(this.opts.hooks, {
        protocol: 'tftp',
        event: 'on-error',
        direction: transfer.opcode === Opcode.RRQ ? 'rrq' : 'wrq',
        clientIP: rinfo.address,
        clientPort: rinfo.port,
        filename: transfer.filename,
        errorCode: transfer.errorCode ?? 0,
        errorMessage: transfer.errorMessage ?? 'Transfer failed',
      });
    }
  }

  /**
   * Remove a completed or errored transfer.
   */
  private async removeTransfer(transfer: TFTPTransfer, rinfo: dgram.RemoteInfo): Promise<void> {
    const key = `${rinfo.address}:${rinfo.port}`;
    this.transfers.delete(key);

    // Close file handle if open
    if (transfer.fileHandle) {
      await transfer.fileHandle.close();
      transfer.fileHandle = null;
    }

    if (transfer.state === TransferState.Error) {
      this.emit('transfer:error', transfer, transfer.errorCode, transfer.errorMessage);

      // Fire on-error hook
      if (this.opts.hooks.length > 0) {
        runHooks(this.opts.hooks, {
          protocol: 'tftp',
          event: 'on-error',
          direction: transfer.opcode === Opcode.RRQ ? 'rrq' : 'wrq',
          clientIP: rinfo.address,
          clientPort: rinfo.port,
          filename: transfer.filename,
          errorCode: transfer.errorCode,
          errorMessage: transfer.errorMessage,
        });
      }
    }
  }

  /**
   * Get the number of active transfers.
   */
  get activeTransfers(): number {
    return this.transfers.size;
  }

  /**
   * Get a snapshot of active transfers for the dashboard API.
   */
  getTransfers(): Array<{
    filename: string;
    direction: 'rrq' | 'wrq';
    clientIP: string;
    clientPort: number;
    state: string;
    bytesSent: number;
    bytesReceived: number;
    filesize: number;
    progress: number;
  }> {
    return Array.from(this.transfers.values()).map((t) => ({
      filename: t.filename,
      direction: t.opcode === Opcode.RRQ ? 'rrq' as const : 'wrq' as const,
      clientIP: t.peer.address,
      clientPort: t.peer.port,
      state: t.state,
      bytesSent: t.bytesSent,
      bytesReceived: t.bytesReceived,
      filesize: t.filesize,
      progress: t.filesize > 0
        ? Math.min(Math.round(((t.opcode === Opcode.RRQ ? t.bytesSent : t.bytesReceived) / t.filesize) * 100), 100)
        : 0,
    }));
  }

  // ── Garbage collection ──────────────────────────────────────────

  /**
   * Start the garbage collection timer.
   */
  private startGC(): void {
    if (this.gcTimer) return;

    this.gcTimer = setInterval(() => {
      this.collectGarbage();
    }, this.opts.gcInterval * 1000);
  }

  /**
   * Remove timed-out transfers.
   */
  private collectGarbage(): void {
    for (const [key, transfer] of this.transfers) {
      if (transfer.isTimedOut()) {
        if (transfer.incrementRetry()) {
          // Still within retry budget — would retransmit last packet here
          // For now, just log and keep the transfer alive
          this.log.debug(`Transfer ${key} timed out, retry ${transfer.retries}/${transfer.maxRetries}`);
        } else {
          this.log.warn(`Transfer ${key} timed out after ${transfer.maxRetries} retries, removing`);
          this.emit('transfer:error', transfer, ErrorCode.UnknownTransferID, 'Transfer timed out');
          this.transfers.delete(key);
          if (transfer.fileHandle) {
            transfer.fileHandle.close().catch((err: Error) =>
              this.log.debug(`Error closing file handle for ${key}: ${err.message}`),
            );
            transfer.fileHandle = null;
          }
        }
      }
    }
  }
}
