import { describe, it, expect, afterEach } from 'vitest';
import { HealthCheckServer, HealthStatus } from '../../src/shared/health.mjs';

const TEST_PORT = 19470;

describe('HealthCheckServer', () => {
  let server: HealthCheckServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('serves /health with JSON status', async () => {
    const status: HealthStatus = {
      status: 'ok',
      uptime: 42,
      pid: 1234,
      version: '1.0.0',
      tftp: { activeTransfers: 2, totalBytes: 1024 },
    };

    server = new HealthCheckServer({
      port: TEST_PORT,
      getStatus: () => status,
    });

    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.uptime).toBe(42);
    expect(body.pid).toBe(1234);
    expect(body.tftp.activeTransfers).toBe(2);
  });

  it('returns 503 when status is "down"', async () => {
    server = new HealthCheckServer({
      port: TEST_PORT + 1,
      getStatus: () => ({
        status: 'down',
        uptime: 0,
        pid: process.pid,
        version: '0.0.0',
      }),
    });

    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT + 1}/health`);
    expect(res.status).toBe(503);
  });

  it('supports async getStatus', async () => {
    server = new HealthCheckServer({
      port: TEST_PORT + 2,
      getStatus: async () => ({
        status: 'ok',
        uptime: process.uptime(),
        pid: process.pid,
        version: '0.0.0',
      }),
    });

    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT + 2}/health`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown paths', async () => {
    server = new HealthCheckServer({
      port: TEST_PORT + 3,
      getStatus: () => ({
        status: 'ok',
        uptime: 0,
        pid: process.pid,
        version: '0.0.0',
      }),
    });

    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT + 3}/metrics`);
    expect(res.status).toBe(404);
  });

  it('returns 500 if getStatus throws', async () => {
    server = new HealthCheckServer({
      port: TEST_PORT + 4,
      getStatus: () => {
        throw new Error('something broke');
      },
    });

    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT + 4}/health`);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.status).toBe('down');
    expect(body.error).toBe('something broke');
  });

  it('exposes uptime accessor', async () => {
    server = new HealthCheckServer({
      port: TEST_PORT + 5,
      getStatus: () => ({
        status: 'ok',
        uptime: 0,
        pid: process.pid,
        version: '0.0.0',
      }),
    });

    await server.start();
  });

  it('stop is idempotent', async () => {
    server = new HealthCheckServer({
      port: TEST_PORT + 6,
      getStatus: () => ({
        status: 'ok',
        uptime: 0,
        pid: process.pid,
        version: '0.0.0',
      }),
    });

    await server.start();
    await server.stop();
    // Second stop should not throw
    await server.stop();
  });
});
