import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { TFTPServer } from '../../src/tftp/server.mjs';
import { TFTPClient } from '../../src/tftp/client.mjs';

// ── Helpers ────────────────────────────────────────────────────────

const TEST_PORT = 50010;
const LAN_TEST_PORT = 50011;
const RFC_TEST_PORT = 50012;
const PUT_TEST_PORT = 50013;
const TEST_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'tsbootkit-client-test-'));

// Create test files
const TEST_FILE = 'download-me.txt';
const TEST_CONTENT = 'Download this from tsbootkit!';
await fs.writeFile(path.join(TEST_ROOT, TEST_FILE), TEST_CONTENT);

const BIG_FILE = 'bigfile.bin';
const BIG_CONTENT = Buffer.alloc(2000, 0xcd); // > 512 bytes for multi-block
await fs.writeFile(path.join(TEST_ROOT, BIG_FILE), BIG_CONTENT);

describe('TFTPClient', () => {
  let server: TFTPServer;
  let client: TFTPClient;

  beforeEach(async () => {
    server = new TFTPServer({
      port: TEST_PORT,
      root: TEST_ROOT,
      allowWrite: true,
    });
    await server.start();

    client = new TFTPClient({
      host: '127.0.0.1',
      port: TEST_PORT,
    });
  });

  afterEach(async () => {
    client.close();
    await server.stop();
  });

  // ── Download ────────────────────────────────────────────────────

  describe('get', () => {
    it('downloads a small file', async () => {
      const downloadPath = path.join(TEST_ROOT, 'downloaded.txt');
      const result = await client.get(TEST_FILE, downloadPath);

      expect(result.bytes).toBe(Buffer.byteLength(TEST_CONTENT));
      expect(result.durationMs).toBeGreaterThan(0);

      const content = await fs.readFile(downloadPath, 'utf8');
      expect(content).toBe(TEST_CONTENT);

      // Cleanup
      await fs.rm(downloadPath, { force: true });
    });

    it('downloads a file with LAN options', 15000, async () => {
      const lanServer = new TFTPServer({
        port: LAN_TEST_PORT,
        root: TEST_ROOT,
      });
      await lanServer.start();

      const lanClient = new TFTPClient({
        host: '127.0.0.1',
        port: LAN_TEST_PORT,
        lan: true,
      });

      const downloadPath = path.join(TEST_ROOT, 'lan-download.bin');
      const result = await lanClient.get(BIG_FILE, downloadPath);

      expect(result.bytes).toBe(BIG_CONTENT.length);
      expect(result.options?.blksize).toBe(1400);

      const content = await fs.readFile(downloadPath);
      expect(content).toEqual(BIG_CONTENT);

      lanClient.close();
      await lanServer.stop();
      await fs.rm(downloadPath, { force: true });
    });

    it('fails with error for missing file', async () => {
      const downloadPath = path.join(TEST_ROOT, 'nope.txt');
      await expect(client.get('nonexistent.txt', downloadPath)).rejects.toThrow(/TFTP error/);

      // Cleanup
      await fs.rm(downloadPath, { force: true });
    });

    it('downloads a multi-block file (rfc1350 mode)', async () => {
      const rfcServer = new TFTPServer({
        port: RFC_TEST_PORT,
        root: TEST_ROOT,
      });
      await rfcServer.start();

      const rfcClient = new TFTPClient({
        host: '127.0.0.1',
        port: RFC_TEST_PORT,
        rfc1350: true,
      });

      const downloadPath = path.join(TEST_ROOT, 'rfc-download.bin');
      const result = await rfcClient.get(BIG_FILE, downloadPath);

      expect(result.bytes).toBe(BIG_CONTENT.length);

      const content = await fs.readFile(downloadPath);
      expect(content).toEqual(BIG_CONTENT);

      rfcClient.close();
      await rfcServer.stop();
      await fs.rm(downloadPath, { force: true });
    });
  });

  // ── Upload ──────────────────────────────────────────────────────

  describe('put', () => {
    it('uploads a file', async () => {
      const putServer = new TFTPServer({
        port: PUT_TEST_PORT,
        root: TEST_ROOT,
        allowWrite: true,
      });
      await putServer.start();

      const putClient = new TFTPClient({
        host: '127.0.0.1',
        port: PUT_TEST_PORT,
      });

      // Create a local file to upload
      const uploadSource = path.join(TEST_ROOT, 'source.txt');
      await fs.writeFile(uploadSource, 'Upload this!');

      const remoteName = `upload-${Date.now()}.txt`;
      const result = await putClient.put(uploadSource, remoteName);

      expect(result.bytes).toBe(Buffer.byteLength('Upload this!'));
      expect(result.durationMs).toBeGreaterThan(0);

      // Verify the file was created on the server root
      const uploadedPath = path.join(TEST_ROOT, remoteName);
      const content = await fs.readFile(uploadedPath, 'utf8');
      expect(content).toBe('Upload this!');

      putClient.close();
      await putServer.stop();

      // Cleanup
      await fs.rm(uploadSource, { force: true });
      await fs.rm(uploadedPath, { force: true });
    });
  });

  // ── Ping ────────────────────────────────────────────────────────

  describe('ping', () => {
    it('returns true when server is running', async () => {
      const result = await client.ping();
      expect(result).toBe(true);
    });

    it('returns false when no server', async () => {
      const deadClient = new TFTPClient({
        host: '127.0.0.1',
        port: 13999, // nobody there
      });

      const result = await deadClient.ping();
      expect(result).toBe(false);

      deadClient.close();
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('closes cleanly', () => {
      const c = new TFTPClient({ host: '127.0.0.1', port: TEST_PORT });
      c.close();
      // Should not throw on double close
      c.close();
    });
  });
});

// ── Cleanup ─────────────────────────────────────────────────────────

import { afterAll } from 'vitest';

afterAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});
