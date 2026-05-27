/**
 * Health check HTTP endpoint.
 *
 * Tiny HTTP server that serves a single `/health` endpoint with JSON status.
 * Designed for Docker HEALTHCHECK, init system probes, and `curl localhost:9470/health`.
 *
 * No dependencies — just Node's built-in `http` module.
 * One endpoint. One job. No routing library needed.
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createLogger } from './logger.mjs';
import { onShutdown } from './signals.mjs';

// ─── Types ─────────────────────────────────────────────────────────

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  uptime: number;
  pid: number;
  version: string;
  tftp?: {
    activeTransfers: number;
    totalBytes: number;
  };
  dhcp?: {
    activeLeases: number;
    reservations: number;
  };
  bootp?: {
    allocated: number;
  };
  http?: {
    enabled: boolean;
  };
}

export interface HealthCheckOptions {
  /** Port to listen on (default 9470). */
  port?: number;
  /** Host to bind (default '127.0.0.1'). */
  host?: string;
  /** Function to gather current health status. */
  getStatus: () => HealthStatus | Promise<HealthStatus>;
}

// ─── Health check server ───────────────────────────────────────────

export class HealthCheckServer {
  private readonly port: number;
  private readonly host: string;
  private readonly getStatus: () => HealthStatus | Promise<HealthStatus>;
  private server: http.Server | null = null;
  private readonly routes: Route[] = [];
  private readonly log;

  constructor(options: HealthCheckOptions) {
    this.port = options.port ?? 9470;
    this.host = options.host ?? '127.0.0.1';
    this.getStatus = options.getStatus;
    this.log = createLogger('health');
  }

  /**
   * Register a custom route on the HTTP server.
   * Must be called before `start()`.
   */
  addRoute(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), path, handler });
  }

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const method = (req.method ?? 'GET').toUpperCase();

      // Check custom routes first
      for (const route of this.routes) {
        if (route.method === method && route.path === url.pathname) {
          try {
            await route.handler(req, res);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }
      }

      // Default: /health endpoint
      if (url.pathname === '/health') {
        try {
          const status = await this.getStatus();
          const statusCode = status.status === 'down' ? 503 : 200;

          res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
          });
          res.end(JSON.stringify(status, null, 2));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'down',
            error: (err as Error).message,
          }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.log.info(`Health check listening on ${this.host}:${this.port}`);
        resolve();
      });
    }).then(() => {
      onShutdown(() => this.stop());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}
