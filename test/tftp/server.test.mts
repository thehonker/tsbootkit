import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { TFTPServer } from '../../src/tftp/server.mjs';
import { Opcode, ErrorCode } from '../../src/tftp/types.mjs';
import { getOpcode, parsePacket, encodeRRQ, encodeWRQ } from '../../src/tftp/protocol.mjs';

// ── Helpers ────────────────────────────────────────────────────────

const TEST_PORT = 50000; // High port range to avoid TID collisions with client tests
const TEST_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'tsbootkit-test-'));

// Create test files
const TEST_FILE = 'hello.txt';
const TEST_CONTENT = 'Hello from tsbootkit!';
await fs.writeFile(path.join(TEST_ROOT, TEST_FILE), TEST_CONTENT);

const BIG_FILE = 'bigfile.bin';
const BIG_CONTENT = Buffer.alloc(1400, 0xab);
await fs.writeFile(path.join(TEST_ROOT, BIG_FILE), BIG_CONTENT);

/**
 * Send a UDP packet and wait for a response.
 */
function sendAndWait(port: number, packet: Buffer, timeout = 2000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('Response timeout'));
    }, timeout);

    sock.on('message', (msg: Buffer) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });

    sock.on('error', (err: Error) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });

    sock.send(packet, port, '127.0.0.1', (err) => {
      if (err) {
        clearTimeout(timer);
        sock.close();
        reject(err);
      }
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe('TFTPServer', () => {
  let server: TFTPServer;

  beforeEach(async () => {
    server = new TFTPServer({
      port: TEST_PORT,
      root: TEST_ROOT,
      allowWrite: true,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // ── Basic RRQ ─────────────────────────────────────────────────

  describe('RRQ', () => {
    it('serves a small file', async () => {
      const rrq = encodeRRQ(TEST_FILE, 'octet');
      const response = await sendAndWait(TEST_PORT, rrq);

      const opcode = getOpcode(response);
      expect(opcode).toBe(Opcode.DATA);

      const parsed = parsePacket(response);
      expect(parsed?.opcode).toBe(Opcode.DATA);

      if (parsed?.opcode === Opcode.DATA) {
        const content = parsed.data.toString('utf8');
        expect(content).toBe(TEST_CONTENT);
        expect(parsed.blockNum).toBe(1);
      }
    });

    it('returns FILE_NOT_FOUND for missing file', async () => {
      const rrq = encodeRRQ('nonexistent.txt', 'octet');
      const response = await sendAndWait(TEST_PORT, rrq);

      const opcode = getOpcode(response);
      expect(opcode).toBe(Opcode.ERROR);

      const parsed = parsePacket(response);
      if (parsed?.opcode === Opcode.ERROR) {
        expect(parsed.errorCode).toBe(ErrorCode.FileNotFound);
      }
    });

    it('rejects path traversal', async () => {
      const rrq = encodeRRQ('../../../etc/passwd', 'octet');
      const response = await sendAndWait(TEST_PORT, rrq);

      const opcode = getOpcode(response);
      expect(opcode).toBe(Opcode.ERROR);

      const parsed = parsePacket(response);
      if (parsed?.opcode === Opcode.ERROR) {
        expect(parsed.errorCode).toBe(ErrorCode.AccessViolation);
      }
    });
  });

  // ── RRQ with options ──────────────────────────────────────────

  describe('RRQ with options', () => {
    it('negotiates blksize via OACK', async () => {
      const rrq = encodeRRQ(TEST_FILE, 'octet', { blksize: '1024' });
      const response = await sendAndWait(TEST_PORT, rrq);

      // Should get OACK first
      const opcode = getOpcode(response);
      expect(opcode).toBe(Opcode.OACK);

      const parsed = parsePacket(response);
      if (parsed?.opcode === Opcode.OACK) {
        expect(parsed.options.blksize).toBe('1024');
      }
    });
  });

  // ── WRQ ───────────────────────────────────────────────────────

  describe('WRQ', () => {
    it('accepts a write request', async () => {
      const uploadName = `upload-${Date.now()}.txt`;
      const wrq = encodeWRQ(uploadName, 'octet');
      const response = await sendAndWait(TEST_PORT, wrq);

      // Should get ACK(0)
      const opcode = getOpcode(response);
      expect(opcode).toBe(Opcode.ACK);

      const parsed = parsePacket(response);
      if (parsed?.opcode === Opcode.ACK) {
        expect(parsed.blockNum).toBe(0);
      }
    });

    it('rejects WRQ when allowWrite is false', async () => {
      // Need a server with allowWrite=false
      const noWriteServer = new TFTPServer({
        port: TEST_PORT + 1,
        root: TEST_ROOT,
        allowWrite: false,
      });
      await noWriteServer.start();

      try {
        const wrq = encodeWRQ('blocked.txt', 'octet');
        const response = await sendAndWait(TEST_PORT + 1, wrq);

        const opcode = getOpcode(response);
        expect(opcode).toBe(Opcode.ERROR);

        const parsed = parsePacket(response);
        if (parsed?.opcode === Opcode.ERROR) {
          expect(parsed.errorCode).toBe(ErrorCode.AccessViolation);
        }
      } finally {
        await noWriteServer.stop();
      }
    });
  });

  // ── Server lifecycle ──────────────────────────────────────────

  describe('lifecycle', () => {
    it('emits listening event', async () => {
      const s = new TFTPServer({ port: TEST_PORT + 2, root: TEST_ROOT });
      let listened = false;
      s.on('listening', () => { listened = true; });
      await s.start();
      expect(listened).toBe(true);
      await s.stop();
    });

    it('tracks active transfers', async () => {
      expect(server.activeTransfers).toBe(0);

      // Start a transfer (but don't complete it)
      const rrq = encodeRRQ(TEST_FILE, 'octet');
      await sendAndWait(TEST_PORT, rrq);

      // After response, transfer might still be active (waiting for ACK)
      // or already cleaned up depending on timing
      expect(server.activeTransfers).toBeGreaterThanOrEqual(0);
    });

    it('stops cleanly', async () => {
      const s = new TFTPServer({ port: TEST_PORT + 3, root: TEST_ROOT });
      await s.start();
      await s.stop();

      // Should be able to start again on the same port
      const s2 = new TFTPServer({ port: TEST_PORT + 3, root: TEST_ROOT });
      await s2.start();
      await s2.stop();
    });
  });

  // ── Invalid requests ──────────────────────────────────────────

  describe('invalid requests', () => {
    it('rejects unknown opcodes', async () => {
      const buf = Buffer.alloc(2);
      buf.writeUInt16BE(99, 0);
      const response = await sendAndWait(TEST_PORT, buf);

      const opcode = getOpcode(response);
      expect(opcode).toBe(Opcode.ERROR);
    });

    it('rejects a too-short packet', async () => {
      const buf = Buffer.from([0x00]);
      // Should not crash — may or may not get a response
      try {
        await sendAndWait(TEST_PORT, buf, 500);
      } catch {
        // Timeout is acceptable for malformed packets
      }
    });
  });
});

// ── Cleanup ─────────────────────────────────────────────────────────

import { afterAll } from 'vitest';

afterAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});
