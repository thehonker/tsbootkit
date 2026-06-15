import { describe, it, expect, afterEach } from 'vitest';
import dgram from 'node:dgram';
import { NetconsoleServer } from '../../src/netconsole/server.mjs';
import type { NetconsoleMessage } from '../../src/netconsole/server.mjs';
import { buildHookArgs } from '../../src/shared/hooks.mjs';
import type { NetconsoleHookContext } from '../../src/shared/hooks.mjs';

const TEST_PORT = 16666;
const TEST_ADDRESS = '127.0.0.1';

// ─── Server lifecycle ──────────────────────────────────────────────

describe('NetconsoleServer', () => {
  let server: NetconsoleServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('starts and stops cleanly', async () => {
    server = new NetconsoleServer({ port: TEST_PORT, address: TEST_ADDRESS });
    expect(server.isRunning).toBe(false);

    await server.start();
    expect(server.isRunning).toBe(true);
    expect(server.listeningPort).toBe(TEST_PORT);

    await server.stop();
    expect(server.isRunning).toBe(false);
  });

  it('throws if started twice', async () => {
    server = new NetconsoleServer({ port: TEST_PORT + 1, address: TEST_ADDRESS });
    await server.start();

    await expect(server.start()).rejects.toThrow('already running');

    await server.stop();
  });

  it('stop is idempotent', async () => {
    server = new NetconsoleServer({ port: TEST_PORT + 2, address: TEST_ADDRESS });
    await server.start();
    await server.stop();
    await server.stop(); // second stop should be a no-op
  });

  it('defaults port to 6666 and address to 0.0.0.0', () => {
    server = new NetconsoleServer({});
    expect(server.listeningPort).toBe(6666);
  });
});

// ─── Message reception ─────────────────────────────────────────────

describe('NetconsoleServer message reception', () => {
  let server: NetconsoleServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  /** Send a UDP message to the netconsole listener. */
  function sendUdp(port: number, address: string, message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const buf = Buffer.from(message, 'utf-8');
      socket.send(buf, 0, buf.length, port, address, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  it('receives a UDP message and emits a message event', async () => {
    server = new NetconsoleServer({ port: TEST_PORT + 10, address: TEST_ADDRESS });
    await server.start();

    const received: NetconsoleMessage[] = [];
    server.on('message', (msg: NetconsoleMessage) => {
      received.push(msg);
    });

    await sendUdp(TEST_PORT + 10, TEST_ADDRESS, 'Hello from kernel\n');

    // Give the event loop a tick to process
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('Hello from kernel');
    expect(received[0]!.source).toBe('127.0.0.1');
  });

  it('strips trailing newline and carriage return', async () => {
    server = new NetconsoleServer({ port: TEST_PORT + 11, address: TEST_ADDRESS });
    await server.start();

    const received: NetconsoleMessage[] = [];
    server.on('message', (msg: NetconsoleMessage) => {
      received.push(msg);
    });

    // \r\n (Windows-style)
    await sendUdp(TEST_PORT + 11, TEST_ADDRESS, 'kernel message\r\n');

    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('kernel message');
  });

  it('handles messages without trailing newline', async () => {
    server = new NetconsoleServer({ port: TEST_PORT + 12, address: TEST_ADDRESS });
    await server.start();

    const received: NetconsoleMessage[] = [];
    server.on('message', (msg: NetconsoleMessage) => {
      received.push(msg);
    });

    await sendUdp(TEST_PORT + 12, TEST_ADDRESS, 'no newline here');

    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('no newline here');
  });

  it('tracks message count', async () => {
    server = new NetconsoleServer({ port: TEST_PORT + 13, address: TEST_ADDRESS });
    await server.start();

    expect(server.messageCount).toBe(0);

    await sendUdp(TEST_PORT + 13, TEST_ADDRESS, 'msg1\n');
    await sendUdp(TEST_PORT + 13, TEST_ADDRESS, 'msg2\n');
    await sendUdp(TEST_PORT + 13, TEST_ADDRESS, 'msg3\n');

    await new Promise((r) => setTimeout(r, 200));

    expect(server.messageCount).toBe(3);
  });

  it('receives multiple messages in sequence', async () => {
    server = new NetconsoleServer({ port: TEST_PORT + 14, address: TEST_ADDRESS });
    await server.start();

    const received: NetconsoleMessage[] = [];
    server.on('message', (msg: NetconsoleMessage) => {
      received.push(msg);
    });

    for (let i = 0; i < 5; i++) {
      await sendUdp(TEST_PORT + 14, TEST_ADDRESS, `message ${i}\n`);
    }

    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(received[i]!.text).toBe(`message ${i}`);
    }
  });

  it('handles non-ASCII UTF-8 messages', async () => {
    server = new NetconsoleServer({ port: TEST_PORT + 15, address: TEST_ADDRESS });
    await server.start();

    const received: NetconsoleMessage[] = [];
    server.on('message', (msg: NetconsoleMessage) => {
      received.push(msg);
    });

    await sendUdp(TEST_PORT + 15, TEST_ADDRESS, 'kernel: Fußpilz ✓\n');

    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('kernel: Fußpilz ✓');
  });

  it('emits ready event on start', async () => {
    server = new NetconsoleServer({ port: TEST_PORT + 16, address: TEST_ADDRESS });

    let readyFired = false;
    server.on('ready', () => {
      readyFired = true;
    });

    await server.start();
    expect(readyFired).toBe(true);
  });
});

// ─── Hook integration ───────────────────────────────────────────────

describe('NetconsoleServer hooks', () => {
  it('builds correct hook args for netconsole context', () => {
    const ctx: NetconsoleHookContext = {
      protocol: 'netconsole',
      event: 'message',
      source: '192.168.1.50:6666',
      message: 'Kernel panic - not syncing',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['message', '192.168.1.50:6666', 'Kernel panic - not syncing']);
  });

  it('executes a hook script with netconsole context', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');

    const marker = path.join(os.tmpdir(), `tsbootkit-netconsole-hook-test-${Date.now()}`);
    const script = path.join(os.tmpdir(), `tsbootkit-netconsole-hook-script-${Date.now()}.sh`);

    await fs.writeFile(script, `#!/bin/sh\necho "$1 $2 $3" > "${marker}"\n`, { mode: 0o755 });

    const hook: import('../../src/shared/hooks.mjs').HookConfig = { exec: script, events: ['message'] };

    const server = new NetconsoleServer({
      port: TEST_PORT + 20,
      address: TEST_ADDRESS,
      hooks: [hook],
    });

    await server.start();

    const socket = dgram.createSocket('udp4');
    const buf = Buffer.from('Kernel panic\n', 'utf-8');
    socket.send(buf, 0, buf.length, TEST_PORT + 20, TEST_ADDRESS);
    await new Promise((r) => setTimeout(r, 500));
    socket.close();

    await server.stop();

    const content = await fs.readFile(marker, 'utf-8');
    const parts = content.trim().split(' ');
    expect(parts[0]).toBe('message');
    expect(parts[1]).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(parts.slice(2).join(' ')).toBe('Kernel panic');

    await fs.unlink(marker);
    await fs.unlink(script);
  });
});
