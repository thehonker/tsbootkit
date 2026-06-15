/**
 * Netconsole listener — receives kernel netconsole UDP messages.
 *
 * Binds a dgram.Socket and logs each incoming UDP datagram as a
 * kernel log line. Integrates with the existing Winston logger and
 * the hook system.
 *
 * Kernel netconsole sends one plaintext log line per UDP datagram.
 * No protocol framing beyond standard UDP.
 */

import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';

import { createLogger, type TsbootkitLevel } from '../shared/logger.mjs';
import { runHooks } from '../shared/hooks.mjs';
import type { NetconsoleConfig } from './types.mjs';

/** A received netconsole message. */
export interface NetconsoleMessage {
  /** Source IP address. */
  source: string;
  /** Source port. */
  sourcePort: number;
  /** Log line text (stripped of trailing newline). */
  text: string;
}

/** Netconsole server — UDP listener for kernel netconsole messages. */
export class NetconsoleServer extends EventEmitter {
  private readonly port: number;
  private readonly address: string;
  private readonly level: TsbootkitLevel;
  private readonly hooks?: import('../shared/hooks.mjs').HookConfig[];
  private socket: dgram.Socket | null = null;
  private _messageCount = 0;
  private readonly log;

  constructor(config: NetconsoleConfig & { hooks?: import('../shared/hooks.mjs').HookConfig[] }) {
    super();
    this.port = config.port ?? 6666;
    this.address = config.address ?? '0.0.0.0';
    this.level = (config.level as TsbootkitLevel) ?? 'info';
    this.hooks = config.hooks;
    this.log = createLogger('netconsole');
  }

  /** Number of messages received since start. */
  get messageCount(): number {
    return this._messageCount;
  }

  /** UDP port the listener is bound to. */
  get listeningPort(): number {
    return this.port;
  }

  /** Whether the listener is currently running. */
  get isRunning(): boolean {
    return this.socket !== null;
  }

  /**
   * Start the netconsole listener.
   */
  async start(): Promise<void> {
    if (this.socket) {
      throw new Error('Netconsole server is already running');
    }

    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (buf: Buffer, rinfo: dgram.RemoteInfo) => {
      this._messageCount++;

      // Decode and strip trailing newline/carriage-return
      const text = buf.toString('utf-8').replace(/\r?\n$/, '');

      const msg: NetconsoleMessage = {
        source: rinfo.address,
        sourcePort: rinfo.port,
        text,
      };

      this.log.log(this.level, `<${msg.source}> ${text}`);

      this.emit('message', msg);

      // Run matching hooks
      if (this.hooks && this.hooks.length > 0) {
        runHooks(this.hooks, {
          protocol: 'netconsole',
          event: 'message',
          source: `${msg.source}:${msg.sourcePort}`,
          message: msg.text,
        });
      }
    });

    this.socket.on('error', (err: Error) => {
      this.log.error(`Socket error: ${err.message}`);
      this.emit('error', err);
    });

    return new Promise((resolve, reject) => {
      this.socket!.once('error', reject);

      this.socket!.bind(this.port, this.address, () => {
        this.socket!.removeListener('error', reject);
        this.log.info(`Listening on ${this.address}:${this.port}`);
        this.emit('ready');
        resolve();
      });
    });
  }

  /**
   * Stop the netconsole listener gracefully.
   */
  async stop(): Promise<void> {
    if (!this.socket) return;

    this.log.info('Shutting down netconsole listener...');

    return new Promise((resolve) => {
      this.socket!.once('close', () => {
        this.log.info('Netconsole listener stopped.');
        this.socket = null;
        resolve();
      });

      this.socket!.close();
    });
  }
}
