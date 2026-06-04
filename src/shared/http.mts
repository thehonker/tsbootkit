/**
 * HTTP fallback server for PXE boot.
 *
 * Some UEFI firmware prefers HTTP over TFTP for boot file downloads.
 * This serves the same root directory as the TFTP server over HTTP,
 * supporting range requests for large firmware images.
 *
 * Deliberately minimal: no middleware, no body parsing, no sessions.
 * Just `GET /path` → file from the TFTP root.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import { lookup } from 'mime-types';
import { createLogger } from './logger.mjs';
import { onShutdown } from './signals.mjs';

// ─── Transfer tracking ───────────────────────────────────────────────

/** Tracks a single HTTP request from start to finish. */
export interface HTTPTransfer {
  /** Monotonically increasing transfer ID. */
  id: number;
  /** HTTP method (GET, HEAD). */
  method: string;
  /** Decoded URL path. */
  path: string;
  /** Client IP address. */
  clientIP: string;
  /** Current transfer state. */
  state: 'active' | 'complete' | 'error';
  /** Bytes sent to the client (content-length or range size). */
  bytesSent: number;
  /** Total file size in bytes. */
  fileSize: number;
  /** Timestamp when the request started. */
  startedAt: number;
  /** HTTP response status code. */
  statusCode?: number;
}

// ─── Server events ────────────────────────────────────────────────────

export interface HTTPServerEvents {
  'transfer:start': (transfer: HTTPTransfer) => void;
  'transfer:complete': (transfer: HTTPTransfer) => void;
  'transfer:error': (transfer: HTTPTransfer) => void;
}

// ─── Config ────────────────────────────────────────────────────────

export interface HTTPServerConfig {
  /** Root directory to serve files from (same as TFTP root). */
  root: string;
  /** Port to listen on (default 80). */
  port?: number;
  /** Host to bind (default '0.0.0.0' — must be reachable by PXE clients). */
  host?: string;
  /** Maximum file size to serve in bytes (default 1GB). */
  maxFileSize?: number;
  /** Whether to follow symbolic links (default false — symlinks outside root are blocked). */
  followSymlinks?: boolean;
}

// ─── Server ────────────────────────────────────────────────────────

export class HTTPServer extends EventEmitter {
  private readonly root: string;
  private readonly port: number;
  private readonly host: string;
  private readonly maxFileSize: number;
  private readonly followSymlinks: boolean;
  private server: http.Server | null = null;
  private readonly log;

  // Transfer tracking
  private nextTransferId = 1;
  private readonly transfers = new Map<number, HTTPTransfer>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: HTTPServerConfig) {
    super();
    this.root = path.resolve(config.root);
    this.port = config.port ?? 80;
    this.host = config.host ?? '0.0.0.0';
    this.maxFileSize = config.maxFileSize ?? 1024 * 1024 * 1024; // 1GB
    this.followSymlinks = config.followSymlinks ?? false;
    this.log = createLogger('httpd');
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err: Error) => {
        this.log.error(`Unhandled error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end('Internal Server Error');
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.log.info(`HTTP server listening on ${this.host}:${this.port}, root=${this.root}`);
        resolve();
      });
    }).then(() => {
      // Start transfer garbage collection
      this.startGC();
      onShutdown(() => this.stop());
    });
  }

  async stop(): Promise<void> {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }

    if (!this.server) return;

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.log.info('HTTP server stopped.');
        this.server = null;
        this.transfers.clear();
        resolve();
      });
    });
  }

  // ── Request handling ─────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const decodedPath = decodeURIComponent(url.pathname);
    const clientIP = req.socket.remoteAddress ?? 'unknown';

    // Create transfer record
    const transfer: HTTPTransfer = {
      id: this.nextTransferId++,
      method: req.method ?? 'GET',
      path: decodedPath,
      clientIP,
      state: 'active',
      bytesSent: 0,
      fileSize: 0,
      startedAt: Date.now(),
    };
    this.transfers.set(transfer.id, transfer);
    this.emit('transfer:start', transfer);
    this.log.info(`HTTP ${transfer.method} ${decodedPath} ← ${clientIP}`);

    // Track response completion
    res.on('finish', () => {
      transfer.statusCode = res.statusCode;
      transfer.state = (res.statusCode && res.statusCode >= 400) ? 'error' : 'complete';
      this.emit(transfer.state === 'error' ? 'transfer:error' : 'transfer:complete', transfer);

      if (transfer.state === 'error') {
        this.log.warn(`HTTP ${transfer.method} ${transfer.path} → ${transfer.clientIP} (${transfer.statusCode})`);
      } else {
        this.log.info(`HTTP ${transfer.method} ${transfer.path} → ${transfer.clientIP} (${formatBytes(transfer.bytesSent)}, ${transfer.statusCode})`);
      }
    });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // Path traversal protection
    // Normalize root without trailing separator to avoid double-sep edge case
    const normalizedRoot = this.root.endsWith(path.sep) ? this.root.slice(0, -1) : this.root;
    const filePath = path.normalize(path.join(this.root, decodedPath));
    if (!filePath.startsWith(normalizedRoot + path.sep) && filePath !== normalizedRoot) {
      this.log.warn(`Path traversal blocked: ${decodedPath}`);
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // If symlinks are not allowed, resolve the real path and check again
    if (!this.followSymlinks) {
      let realPath: string;
      try {
        realPath = await fs.promises.realpath(filePath);
      } catch {
        // File doesn't exist yet — can't resolve, but it also can't serve a symlink
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const realRoot = await fs.promises.realpath(this.root);
      if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
        this.log.warn(`Symlink traversal blocked: ${decodedPath} → ${realPath}`);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
    }

    // Serve the file
    await this.serveFile(filePath, req, res, transfer);
  }

  // ── File serving ─────────────────────────────────────────────────

  private async serveFile(
    filePath: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    transfer: HTTPTransfer,
  ): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      return;
    }

    // Don't serve directories — could serve index.html but this is a PXE file server
    if (stat.isDirectory()) {
      // Try index.html
      const indexPath = path.join(filePath, 'index.html');
      try {
        const indexStat = await fs.promises.stat(indexPath);
        if (indexStat.isFile()) {
          await this.serveFile(indexPath, req, res, transfer);
          return;
        }
      } catch {
        // No index.html, fall through to 404
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // File too large
    if (stat.size > this.maxFileSize) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Payload Too Large');
      return;
    }

    const mimeType = lookup(filePath) || 'application/octet-stream';
    const isHead = req.method === 'HEAD';
    transfer.fileSize = stat.size;

    // Range request support (for large firmware images, resumable downloads)
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const range = this.parseRange(rangeHeader, stat.size);
      if (!range) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stat.size}`,
        });
        res.end('Range Not Satisfiable');
        return;
      }

      const { start, end } = range;
      const contentLength = end - start + 1;
      transfer.bytesSent = contentLength;

      res.writeHead(206, {
        'Content-Type': mimeType,
        'Content-Length': contentLength,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });

      if (!isHead) {
        const stream = fs.createReadStream(filePath, { start, end });
        stream.pipe(res);
      } else {
        res.end();
      }

      this.log.debug(`Range: ${start}-${end}/${stat.size} ${decodedPath(req)}, ${mimeType})`);
      return;
    }

    // Full response
    transfer.bytesSent = stat.size;
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });

    if (!isHead) {
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } else {
      res.end();
    }

    this.log.debug(`${stat.size} bytes, ${mimeType}`);
  }

  // ── Transfer GC ──────────────────────────────────────────────────

  /** Maximum age of completed/error transfers before GC removes them (ms). */
  private static readonly TRANSFER_GC_MS = 60_000;

  private startGC(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gcTransfers(), HTTPServer.TRANSFER_GC_MS);
  }

  private gcTransfers(): void {
    const cutoff = Date.now() - HTTPServer.TRANSFER_GC_MS;
    let cleaned = 0;
    for (const [id, transfer] of this.transfers) {
      if (transfer.state !== 'active' && transfer.startedAt < cutoff) {
        this.transfers.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.log.debug(`Garbage collected ${cleaned} completed HTTP transfer(s)`);
    }
  }

  // ── Accessors ────────────────────────────────────────────────────

  /** Number of currently active transfers. */
  get activeTransfers(): number {
    let count = 0;
    for (const t of this.transfers.values()) {
      if (t.state === 'active') count++;
    }
    return count;
  }

  /** Get a snapshot of all tracked transfers. */
  getTransfers(): ReadonlyArray<Readonly<HTTPTransfer>> {
    return Array.from(this.transfers.values());
  }

  /** Get a serializable snapshot of transfers for the dashboard API. */
  getTransfersJSON(): Array<{
    id: number;
    method: string;
    path: string;
    clientIP: string;
    state: string;
    bytesSent: number;
    fileSize: number;
    startedAt: number;
    statusCode?: number;
  }> {
    return Array.from(this.transfers.values()).map((t) => ({
      id: t.id,
      method: t.method,
      path: t.path,
      clientIP: t.clientIP,
      state: t.state,
      bytesSent: t.bytesSent,
      fileSize: t.fileSize,
      startedAt: t.startedAt,
      statusCode: t.statusCode,
    }));
  }

  // ── Range parsing ────────────────────────────────────────────────

  /**
   * Parse a Range header value.
   * Only supports `bytes=start-end` (single range, per HTTP/1.1 spec for simple cases).
   */
  private parseRange(header: string, fileSize: number): { start: number; end: number } | null {
    const match = header.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) return null;

    const [, startStr, endStr] = match;

    let start: number;
    let end: number;

    if (!startStr && endStr) {
      // Suffix range: bytes=-500 (last 500 bytes)
      const suffix = parseInt(endStr, 10);
      start = Math.max(0, fileSize - suffix);
      end = fileSize - 1;
    } else if (startStr && !endStr) {
      // Open-ended range: bytes=500- (from byte 500 to end)
      start = parseInt(startStr, 10);
      end = fileSize - 1;
    } else if (startStr && endStr) {
      // Explicit range: bytes=500-999
      start = parseInt(startStr, 10);
      end = parseInt(endStr, 10);
    } else {
      return null;
    }

    // Validate
    if (isNaN(start) || isNaN(end) || start > end || start >= fileSize) {
      return null;
    }

    // Clamp end to file size
    end = Math.min(end, fileSize - 1);

    return { start, end };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function decodedPath(req: http.IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
  } catch {
    return req.url ?? '/';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
