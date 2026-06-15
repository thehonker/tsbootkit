/**
 * Log buffer transport — Winston transport that captures log messages
 * into an in-memory ring buffer for dashboard/API consumption.
 */

import Transport from 'winston-transport';

/** A single captured log entry. */
export interface BufferedLogEntry {
  /** ISO timestamp or formatted time string. */
  timestamp: string;
  /** Log level (error, warn, info, debug, trace). */
  level: string;
  /** Module label (e.g. 'tftpd', 'dhcpd', 'netconsole'). */
  label: string;
  /** Log message text. */
  message: string;
}

/**
 * Winston transport that buffers log entries in a fixed-size ring buffer.
 * Intended for dashboard/API consumption — not for persistent storage.
 */
export class LogBufferTransport extends Transport {
  private readonly buffer: BufferedLogEntry[] = [];
  private readonly maxSize: number;

  constructor(opts: { maxSize?: number; level?: string } = {}) {
    super({ level: opts.level ?? 'trace' });
    this.maxSize = opts.maxSize ?? 500;
  }

  override log(info: { timestamp?: string; level: string; label?: string; message: string } & Record<string, unknown>, callback: () => void): void {
    this.buffer.push({
      timestamp: info.timestamp ?? new Date().toISOString(),
      level: info.level,
      label: info.label ?? '',
      message: info.message,
    });

    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    callback();
  }

  /** Return a snapshot of the buffer (oldest first, newest last). */
  getEntries(): BufferedLogEntry[] {
    return [...this.buffer];
  }

  /** Current number of entries in the buffer. */
  get size(): number {
    return this.buffer.length;
  }

  /** Maximum buffer capacity. */
  get capacity(): number {
    return this.maxSize;
  }
}
