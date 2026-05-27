import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { HealthCheckServer } from '../../src/shared/health.mjs';
import { registerDashboardRoutes, type DashboardStatus } from '../../src/shared/dashboard.mjs';

function fetchJSON(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
      });
    }).on('error', reject);
  });
}

function fetchRaw(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
      });
    }).on('error', reject);
  });
}

describe('Dashboard API', () => {
  let server: HealthCheckServer | null = null;
  let port = 19480;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    port++;
  });

  const mockStatus: DashboardStatus = {
    status: 'ok',
    uptime: 123.45,
    pid: 1234,
    version: '1.0.0',
    mode: 'dhcp',
    interface: 'eth0',
    bootFile: 'pxelinux.0',
    tftp: {
      activeTransfers: 2,
      transfers: [
        {
          filename: 'pxelinux.0',
          direction: 'rrq',
          clientIP: '192.168.1.50',
          clientPort: 54321,
          state: 'SEND',
          bytesSent: 8192,
          bytesReceived: 0,
          filesize: 16384,
          progress: 50,
        },
        {
          filename: 'vmlinuz',
          direction: 'rrq',
          clientIP: '192.168.1.51',
          clientPort: 54322,
          state: 'SEND_LAST',
          bytesSent: 65536,
          bytesReceived: 0,
          filesize: 65536,
          progress: 100,
        },
      ],
    },
    dhcp: {
      activeLeases: 1,
      leases: [
        { ip: '192.168.1.50', mac: 'aa:bb:cc:dd:ee:ff', expires: Date.now() + 900000, uuid: 'test-uuid' },
      ],
      reservations: [
        { mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.50', bootFile: 'custom.efi', hostname: 'test-box' },
      ],
    },
    bootp: null,
    http: { enabled: true },
    mdns: { enabled: true },
  };

  it('serves /api/status with dashboard data', async () => {
    server = new HealthCheckServer({
      port,
      getStatus: () => ({ status: 'ok' as const, uptime: 1, pid: 1, version: '0.0.0' }),
    });

    registerDashboardRoutes(server, () => mockStatus);

    await server.start();

    const result = await fetchJSON(port, '/api/status');
    expect(result.status).toBe(200);
    const body = result.body as DashboardStatus;
    expect(body.status).toBe('ok');
    expect(body.tftp).toBeDefined();
    expect(body.tftp!.activeTransfers).toBe(2);
    expect(body.tftp!.transfers.length).toBe(2);
    expect(body.tftp!.transfers[0]!.filename).toBe('pxelinux.0');
    expect(body.tftp!.transfers[0]!.progress).toBe(50);
    expect(body.dhcp).toBeDefined();
    expect(body.dhcp!.activeLeases).toBe(1);
    expect(body.dhcp!.leases.length).toBe(1);
    expect(body.dhcp!.reservations.length).toBe(1);
  });

  it('serves /ui/ with HTML dashboard', async () => {
    server = new HealthCheckServer({
      port,
      getStatus: () => ({ status: 'ok' as const, uptime: 1, pid: 1, version: '0.0.0' }),
    });

    registerDashboardRoutes(server, () => mockStatus);

    await server.start();

    const result = await fetchRaw(port, '/ui/');
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('text/html');
    expect(result.body).toContain('tsbootkit');
    expect(result.body).toContain('fetch');
    expect(result.body).toContain('/api/status');
  });

  it('redirects /ui to /ui/', async () => {
    server = new HealthCheckServer({
      port,
      getStatus: () => ({ status: 'ok' as const, uptime: 1, pid: 1, version: '0.0.0' }),
    });

    registerDashboardRoutes(server, () => mockStatus);

    await server.start();

    // http.get follows redirects, so check raw response
    const result = await fetchRaw(port, '/ui');
    // 302 redirect
    expect(result.status).toBe(302);
  });

  it('/health still works alongside dashboard routes', async () => {
    server = new HealthCheckServer({
      port,
      getStatus: () => ({ status: 'ok' as const, uptime: 1, pid: 1, version: '0.0.0' }),
    });

    registerDashboardRoutes(server, () => mockStatus);

    await server.start();

    const result = await fetchJSON(port, '/health');
    expect(result.status).toBe(200);
    expect((result.body as { status: string }).status).toBe('ok');
  });

  it('handles provider errors gracefully', async () => {
    server = new HealthCheckServer({
      port,
      getStatus: () => ({ status: 'ok' as const, uptime: 1, pid: 1, version: '0.0.0' }),
    });

    registerDashboardRoutes(server, () => {
      throw new Error('something broke');
    });

    await server.start();

    const result = await fetchJSON(port, '/api/status');
    expect(result.status).toBe(500);
    expect((result.body as { error: string }).error).toContain('something broke');
  });

  it('returns 404 for unknown routes', async () => {
    server = new HealthCheckServer({
      port,
      getStatus: () => ({ status: 'ok' as const, uptime: 1, pid: 1, version: '0.0.0' }),
    });

    registerDashboardRoutes(server, () => mockStatus);

    await server.start();

    const result = await fetchJSON(port, '/nonexistent');
    expect(result.status).toBe(404);
  });
});
