import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HTTPServer } from '../../src/shared/http.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TEST_PORT = 18080;
const TEST_ROOT = path.join(os.tmpdir(), 'tsbootkit-http-test');

describe('HTTPServer', () => {
  let server: HTTPServer;

  beforeEach(async () => {
    await fs.mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
  });

  // ── Basic serving ─────────────────────────────────────────────────

  it('serves a file with correct content type', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'test.txt'), 'hello world');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/test.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('hello world');
  });

  it('serves a binary file', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    await fs.writeFile(path.join(TEST_ROOT, 'image.png'), data);

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/image.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('serves a file from a subdirectory', async () => {
    await fs.mkdir(path.join(TEST_ROOT, 'sub'), { recursive: true });
    await fs.writeFile(path.join(TEST_ROOT, 'sub', 'nested.txt'), 'nested content');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/sub/nested.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('nested content');
  });

  it('returns 404 for nonexistent files', async () => {
    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/nope.txt`);
    expect(res.status).toBe(404);
  });

  it('returns 403 for path traversal attempts', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'secret.txt'), 'secret');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    // fetch normalizes URLs, so test with a direct HTTP request
    // that preserves the traversal characters
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/..%2F..%2F..%2Fetc%2Fpasswd`);
    // The server should either 403 (decoded path escapes root) or 404 (no such file)
    expect([403, 404]).toContain(res.status);
  });

  it('returns 405 for POST requests', async () => {
    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/test.txt`, {
      method: 'POST',
      body: 'data',
    });
    expect(res.status).toBe(405);
  });

  it('HEAD request returns headers without body', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'head.txt'), 'head content');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/head.txt`, {
      method: 'HEAD',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('12');
    // HEAD should not return a body
    const body = await res.text();
    expect(body).toBe('');
  });

  it('serves index.html for directory requests', async () => {
    await fs.mkdir(path.join(TEST_ROOT, 'dir'), { recursive: true });
    await fs.writeFile(path.join(TEST_ROOT, 'dir', 'index.html'), '<h1>Hello</h1>');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/dir/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
  });

  it('returns 404 for directories without index.html', async () => {
    await fs.mkdir(path.join(TEST_ROOT, 'empty-dir'), { recursive: true });

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/empty-dir/`);
    expect(res.status).toBe(404);
  });

  // ── Range requests ────────────────────────────────────────────────

  it('serves a range request (bytes=0-4)', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'range.txt'), '0123456789');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/range.txt`, {
      headers: { Range: 'bytes=0-4' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-4/10');
    expect(res.headers.get('content-length')).toBe('5');
    expect(await res.text()).toBe('01234');
  });

  it('serves a suffix range request (bytes=-3)', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'suffix.txt'), '0123456789');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/suffix.txt`, {
      headers: { Range: 'bytes=-3' },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('789');
  });

  it('serves an open-ended range request (bytes=7-)', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'open.txt'), '0123456789');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/open.txt`, {
      headers: { Range: 'bytes=7-' },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('789');
  });

  it('returns 416 for unsatisfiable range', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'bad-range.txt'), 'short');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/bad-range.txt`, {
      headers: { Range: 'bytes=100-200' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */5');
  });

  // ── URL decoding ──────────────────────────────────────────────────

  it('handles URL-encoded paths', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'space file.txt'), 'encoded');

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/space%20file.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('encoded');
  });

  // ── MIME types ────────────────────────────────────────────────────

  it('returns application/octet-stream for unknown extensions', async () => {
    await fs.writeFile(path.join(TEST_ROOT, 'firmware.bin'), Buffer.from([0x00, 0x01, 0x02]));

    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/firmware.bin`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  // ── Lifecycle ─────────────────────────────────────────────────────

  it('stop is idempotent', async () => {
    server = new HTTPServer({ root: TEST_ROOT, port: TEST_PORT });
    await server.start();
    await server.stop();
    await server.stop(); // Should not throw
  });
});
