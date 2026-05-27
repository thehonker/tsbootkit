/**
 * TFTP client.
 *
 * Supports both programmatic API and interactive REPL mode.
 * Full option negotiation (blksize, timeout, tsize, windowsize)
 * and windowed transfer support.
 *
 * Usage (programmatic):
 *   const client = new TFTPClient('127.0.0.1', 69);
 *   await client.get('pxelinux.0', '/tmp/pxelinux.0');
 *   await client.put('/tmp/data.bin', 'data.bin');
 *   client.close();
 *
 * Usage (REPL):
 *   const repl = new TFTPRepl('127.0.0.1', 69);
 *   repl.start();
 */

import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createLogger } from '../shared/logger.mjs';

import {
  Opcode,
  ErrorCode,
  TransferMode,
  ValidatedOptions,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_WINDOW_SIZE,
  LAN_DEFAULTS,
  RFC1350_DEFAULTS,
} from './types.mjs';
import {
  getOpcode,
  parsePacket,
  encodeRRQ,
  encodeWRQ,
  encodeACK,
  encodeERROR,
  encodeDATA,
  validateOptions,
  validatedToRaw,
} from './protocol.mjs';

// ─── Client options ────────────────────────────────────────────────

export interface TFTPClientOptions {
  /** Server hostname or IP. */
  host: string;
  /** Server port (default 69). */
  port?: number;
  /** Transfer mode (default 'octet'). */
  mode?: TransferMode;
  /** Force RFC1350 compliance (no options). */
  rfc1350?: boolean;
  /** Use LAN-optimized defaults (blksize=1400, windowsize=8). */
  lan?: boolean;
  /** Custom option overrides. */
  options?: Partial<ValidatedOptions>;
  /** Timeout in seconds for each packet (default 10). */
  timeout?: number;
  /** Maximum retransmit attempts (default 5). */
  maxRetries?: number;
  /** Local port to bind to (0 = random). */
  localPort?: number;
}

// ─── Transfer result ───────────────────────────────────────────────

export interface TransferResult {
  /** Bytes transferred. */
  bytes: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Negotiated options (if any). */
  options?: ValidatedOptions;
}

// ─── TFTP Client ───────────────────────────────────────────────────

export class TFTPClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly mode: TransferMode;
  private readonly opts: Partial<ValidatedOptions>;
  private readonly rfc1350: boolean;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly localPort: number;
  private socket: dgram.Socket | null = null;
  private readonly log;

  constructor(options: TFTPClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? 69;
    this.mode = options.mode ?? 'octet';
    this.rfc1350 = options.rfc1350 ?? false;
    this.timeout = options.timeout ?? 10;
    this.maxRetries = options.maxRetries ?? 5;
    this.localPort = options.localPort ?? 0;

    if (this.rfc1350) {
      this.opts = { ...RFC1350_DEFAULTS };
    } else if (options.lan) {
      this.opts = { ...LAN_DEFAULTS };
    } else {
      this.opts = options.options ?? {};
    }

    this.log = createLogger('tftp');
  }

  // ── Socket management ───────────────────────────────────────────

  private ensureSocket(): dgram.Socket {
    if (this.socket) return this.socket;

    this.socket = dgram.createSocket('udp4');
    this.socket.bind(this.localPort);
    return this.socket;
  }

  /**
   * Close the client and release the socket.
   */
  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  // ── Download (GET) ──────────────────────────────────────────────

  /**
   * Download a file from the TFTP server.
   *
   * @param remoteFile - Filename on the server.
   * @param localPath - Local path to save the file.
   * @returns Transfer result with bytes and duration.
   */
  async get(remoteFile: string, localPath: string): Promise<TransferResult> {
    const start = Date.now();
    const sock = this.ensureSocket();

    // Build RRQ options
    const rawOpts = this.rfc1350 ? {} : validatedToRaw({
      blksize: this.opts.blksize ?? DEFAULT_BLOCK_SIZE,
      windowsize: this.opts.windowsize ?? DEFAULT_WINDOW_SIZE,
      timeout: this.opts.timeout,
      tsize: 0, // Ask for file size
    } as ValidatedOptions);

    const rrq = encodeRRQ(remoteFile, this.mode, rawOpts);

    // Send RRQ and handle the response loop
    return new Promise<TransferResult>((resolve, reject) => {
      let serverPort = 0;
      let validated: ValidatedOptions | undefined;
      let blockNum = 0;
      let bytesReceived = 0;
      let fd: fs.FileHandle | null = null;
      let retries = 0;
      let lastPacket: Buffer | null = null;
      let packetsInWindow = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = async () => {
        if (timer) clearTimeout(timer);
        sock.removeAllListeners('message');
        await fd?.close();
      };

      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          if (retries < this.maxRetries && lastPacket) {
            retries++;
            this.log.debug(`Timeout, retransmitting (attempt ${retries}/${this.maxRetries})`);
            sock.send(lastPacket, serverPort || this.port, this.host);
            resetTimer();
          } else {
            await cleanup();
            reject(new Error('Transfer timed out'));
          }
        }, (validated?.timeout ?? this.timeout) * 1000);
      };

      sock.on('message', async (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        // Validate the response is from the expected server
        if (rinfo.address !== this.host) return;

        // On first response, lock in the server's TID (port)
        if (serverPort === 0) {
          serverPort = rinfo.port;
        } else if (rinfo.port !== serverPort) {
          // TID mismatch — send error and ignore
          const errPkt = encodeERROR(ErrorCode.UnknownTransferID);
          sock.send(errPkt, rinfo.port, rinfo.address);
          return;
        }

        const opcode = getOpcode(msg);
        if (opcode === undefined) return;

        retries = 0; // Reset on valid packet

        try {
          // Handle OACK
          if (opcode === Opcode.OACK) {
            const parsed = parsePacket(msg);
            if (parsed?.opcode !== Opcode.OACK) return;

            validated = validateOptions(parsed.options);
            this.log.debug(`Options negotiated: blksize=${validated.blksize} windowsize=${validated.windowsize}`);

            // Open local file
            const dir = path.dirname(localPath);
            await fs.mkdir(dir, { recursive: true });
            fd = await fs.open(localPath, 'w');

            // ACK the OACK
            const ack = encodeACK(0);
            lastPacket = ack;
            sock.send(ack, serverPort, this.host);
            resetTimer();
            return;
          }

          // Handle ERROR
          if (opcode === Opcode.ERROR) {
            const parsed = parsePacket(msg);
            await cleanup();
            if (parsed?.opcode === Opcode.ERROR) {
              reject(new Error(`TFTP error [${parsed.errorCode}]: ${parsed.message}`));
            } else {
              reject(new Error('TFTP error'));
            }
            return;
          }

          // Handle DATA
          if (opcode === Opcode.DATA) {
            const parsed = parsePacket(msg);
            if (parsed?.opcode !== Opcode.DATA) return;

            // If no OACK was received, open the file on first DATA
            if (!fd) {
              validated = {
                blksize: this.opts.blksize ?? DEFAULT_BLOCK_SIZE,
                windowsize: this.opts.windowsize ?? DEFAULT_WINDOW_SIZE,
              };
              const dir = path.dirname(localPath);
              await fs.mkdir(dir, { recursive: true });
              fd = await fs.open(localPath, 'w');
            }

            // Verify block number (with wraparound for large transfers)
            // Block numbers are uint16 (1–65535), wrapping from 65535 → 1
            const expectedBlock = blockNum === 65535 ? 1 : blockNum + 1;
            if (parsed.blockNum !== expectedBlock) {
              // Duplicate or out-of-order — re-ACK the last good block
              if (parsed.blockNum === blockNum) {
                const ack = encodeACK(blockNum);
                lastPacket = ack;
                sock.send(ack, serverPort, this.host);
              }
              return;
            }

            // Write data to file
            await fd.write(parsed.data);
            bytesReceived += parsed.data.length;
            blockNum = parsed.blockNum;
            packetsInWindow++;

            // ACK at window boundaries or on the last packet
            const windowsize = validated?.windowsize ?? DEFAULT_WINDOW_SIZE;
            const blksize = validated?.blksize ?? DEFAULT_BLOCK_SIZE;
            const isLast = parsed.data.length < blksize;

            if (isLast || packetsInWindow >= windowsize) {
              const ack = encodeACK(blockNum);
              lastPacket = ack;
              sock.send(ack, serverPort, this.host);
              packetsInWindow = 0;
            }
            resetTimer();

            // Check for last packet (data < blksize)
            if (isLast) {
              await cleanup();
              resolve({
                bytes: bytesReceived,
                durationMs: Date.now() - start,
                options: validated,
              });
            }
          }
        } catch (err) {
          await cleanup();
          reject(err);
        }
      });

      // Send the RRQ
      lastPacket = rrq;
      sock.send(rrq, this.port, this.host, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resetTimer();
      });
    });
  }

  // ── Upload (PUT) ────────────────────────────────────────────────

  /**
   * Upload a file to the TFTP server.
   *
   * @param localPath - Local file to upload.
   * @param remoteFile - Filename on the server.
   * @returns Transfer result with bytes and duration.
   */
  async put(localPath: string, remoteFile: string): Promise<TransferResult> {
    const start = Date.now();
    const sock = this.ensureSocket();

    // Get file size for tsize option
    const stat = await fs.stat(localPath);

    const rawOpts = this.rfc1350 ? {} : validatedToRaw({
      blksize: this.opts.blksize ?? DEFAULT_BLOCK_SIZE,
      windowsize: this.opts.windowsize ?? DEFAULT_WINDOW_SIZE,
      timeout: this.opts.timeout,
      tsize: stat.size,
    } as ValidatedOptions);

    const wrq = encodeWRQ(remoteFile, this.mode, rawOpts);

    return new Promise<TransferResult>((resolve, reject) => {
      let serverPort = 0;
      let validated: ValidatedOptions | undefined;
      let blockNum = 0;
      let bytesSent = 0;
      let fd: fs.FileHandle | null = null;
      let retries = 0;
      let lastPacket: Buffer | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let offset = 0;

      const cleanup = async () => {
        if (timer) clearTimeout(timer);
        sock.removeAllListeners('message');
        await fd?.close();
      };

      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          if (retries < this.maxRetries && lastPacket) {
            retries++;
            this.log.debug(`Timeout, retransmitting (attempt ${retries}/${this.maxRetries})`);
            sock.send(lastPacket, serverPort || this.port, this.host);
            resetTimer();
          } else {
            await cleanup();
            reject(new Error('Transfer timed out'));
          }
        }, (validated?.timeout ?? this.timeout) * 1000);
      };

      const sendNextWindow = async () => {
        if (!fd) return;

        const blksize = validated?.blksize ?? DEFAULT_BLOCK_SIZE;
        const windowsize = validated?.windowsize ?? DEFAULT_WINDOW_SIZE;

        for (let i = 0; i < windowsize; i++) {
          const readBuf = Buffer.alloc(blksize);
          const { bytesRead } = await fd.read(readBuf, 0, blksize, offset);
          offset += bytesRead;

          if (bytesRead === 0) break;

          blockNum++;
          // Block number wraparound — wire value must stay in uint16 range
          // After 65535, wrap per RFC 7440 / common TFTP extension practice
          const wireBlock = blockNum > 65535 ? ((blockNum - 1) % 65535) + 1 : blockNum;
          const data = bytesRead < blksize ? readBuf.subarray(0, bytesRead) : readBuf;
          const dataPkt = encodeDATA(wireBlock, data);
          lastPacket = dataPkt;
          sock.send(dataPkt, serverPort, this.host);

          bytesSent += bytesRead;

          // Last block — done after ACK
          if (bytesRead < blksize) break;
        }

        resetTimer();
      };

      sock.on('message', async (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        if (rinfo.address !== this.host) return;

        if (serverPort === 0) {
          serverPort = rinfo.port;
        } else if (rinfo.port !== serverPort) {
          const errPkt = encodeERROR(ErrorCode.UnknownTransferID);
          sock.send(errPkt, rinfo.port, rinfo.address);
          return;
        }

        const opcode = getOpcode(msg);
        if (opcode === undefined) return;

        retries = 0;

        try {
          // Handle ERROR
          if (opcode === Opcode.ERROR) {
            const parsed = parsePacket(msg);
            await cleanup();
            if (parsed?.opcode === Opcode.ERROR) {
              reject(new Error(`TFTP error [${parsed.errorCode}]: ${parsed.message}`));
            } else {
              reject(new Error('TFTP error'));
            }
            return;
          }

          // Handle OACK (response to WRQ with options)
          if (opcode === Opcode.OACK) {
            const parsed = parsePacket(msg);
            if (parsed?.opcode !== Opcode.OACK) return;

            validated = validateOptions(parsed.options);
            this.log.debug(`Options negotiated: blksize=${validated.blksize} windowsize=${validated.windowsize}`);

            // Open the file
            fd = await fs.open(localPath, 'r');

            // Send first window of data
            await sendNextWindow();
            return;
          }

          // Handle ACK (response to DATA)
          if (opcode === Opcode.ACK) {
            const parsed = parsePacket(msg);
            if (parsed?.opcode !== Opcode.ACK) return;

            // If no OACK, open file on first ACK(0)
            if (!fd && parsed.blockNum === 0) {
              validated = {
                blksize: this.opts.blksize ?? DEFAULT_BLOCK_SIZE,
                windowsize: this.opts.windowsize ?? DEFAULT_WINDOW_SIZE,
              };
              fd = await fs.open(localPath, 'r');
            }

            // Transfer complete — all data sent and ACK'd
            if (offset >= stat.size) {
              await cleanup();
              resolve({
                bytes: bytesSent,
                durationMs: Date.now() - start,
                options: validated,
              });
              return;
            }

            // Send next window of data
            await sendNextWindow();
          }
        } catch (err) {
          await cleanup();
          reject(err);
        }
      });

      // Send the WRQ
      lastPacket = wrq;
      sock.send(wrq, this.port, this.host, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resetTimer();
      });
    });
  }

  // ── Connect test ────────────────────────────────────────────────

  /**
   * Test connectivity to the TFTP server.
   * Attempts a connection and resolves if the server responds.
   */
  async ping(): Promise<boolean> {
    try {
      // Try to get a non-existent file — if we get an ERROR response,
      // the server is alive
      const sock = this.ensureSocket();
      const rrq = encodeRRQ('__tsbootkit_ping__', 'octet');

      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          sock.removeAllListeners('message');
          resolve(false);
        }, 3000);

        sock.on('message', (msg: Buffer) => {
          clearTimeout(timer);
          sock.removeAllListeners('message');
          const opcode = getOpcode(msg);
          resolve(opcode === Opcode.ERROR || opcode === Opcode.DATA);
        });

        sock.send(rrq, this.port, this.host, (err) => {
          if (err) {
            clearTimeout(timer);
            resolve(false);
          }
        });
      });
    } catch {
      return false;
    }
  }
}

// ─── Interactive REPL ──────────────────────────────────────────────

/**
 * Interactive TFTP client REPL.
 *
 * Commands:
 *   get <remote> [local]   — Download a file
 *   put <local> [remote]   — Upload a file
 *   mode [octet|netascii]  — Get or set transfer mode
 *   status                 — Show current settings
 *   quit / exit            — Exit the REPL
 *   help                   — Show help
 */
export class TFTPRepl {
  private readonly client: TFTPClient;

  constructor(options: TFTPClientOptions) {
    this.client = new TFTPClient(options);
  }

  /**
   * Start the interactive REPL.
   */
  async start(): Promise<void> {
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'tftp> ',
    });

    console.log(`Connected to ${this.client['host']}:${this.client['port']}`);
    rl.prompt();

    rl.on('line', async (line: string) => {
      const parts = line.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase();

      try {
        switch (cmd) {
          case 'get': {
            const remote = parts[1];
            const local = parts[2] ?? parts[1];
            if (!remote) {
              console.log('Usage: get <remote> [local]');
              break;
            }
            console.log(`Downloading ${remote}...`);
            const result = await this.client.get(remote, local!);
            console.log(`Done: ${result.bytes} bytes in ${result.durationMs}ms`);
            break;
          }

          case 'put': {
            const local = parts[1];
            const remote = parts[2] ?? parts[1];
            if (!local) {
              console.log('Usage: put <local> [remote]');
              break;
            }
            console.log(`Uploading ${local}...`);
            const result = await this.client.put(local, remote!);
            console.log(`Done: ${result.bytes} bytes in ${result.durationMs}ms`);
            break;
          }

          case 'mode': {
            if (parts[1]) {
              if (parts[1] === 'octet' || parts[1] === 'netascii') {
                // Update mode via a direct property (REPL convenience)
                (this.client as unknown as { mode: TransferMode }).mode = parts[1] as TransferMode;
                console.log(`Mode set to ${parts[1]}`);
              } else {
                console.log('Invalid mode. Use: octet or netascii');
              }
            } else {
              console.log(`Current mode: ${(this.client as unknown as { mode: TransferMode }).mode}`);
            }
            break;
          }

          case 'status': {
            console.log(`Server: ${this.client['host']}:${this.client['port']}`);
            console.log(`Mode: ${this.client['mode']}`);
            console.log(`RFC1350: ${this.client['rfc1350']}`);
            break;
          }

          case 'quit':
          case 'exit':
            this.client.close();
            rl.close();
            return;

          case 'help':
            console.log('Commands:');
            console.log('  get <remote> [local]   Download a file');
            console.log('  put <local> [remote]   Upload a file');
            console.log('  mode [octet|netascii]  Get or set transfer mode');
            console.log('  status                 Show current settings');
            console.log('  quit / exit            Exit');
            console.log('  help                   This message');
            break;

          default:
            if (cmd) console.log(`Unknown command: ${cmd}`);
            break;
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
      }

      rl.prompt();
    });

    rl.on('close', () => {
      this.client.close();
    });
  }
}
