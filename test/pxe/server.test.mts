import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PXEServer } from '../../src/pxe/server.mjs';
import { PXEMode } from '../../src/pxe/types.mjs';
import type { IPv4 } from '../../src/shared/types.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), 'tsbootkit-pxe-test');

// Explicit config for loopback (getInterfaceConfig skips internal interfaces)
const LO_CONFIG = {
  interface: 'lo',
  serverIP: '127.0.0.1' as IPv4,
  subnetMask: '255.0.0.0' as IPv4,
};

describe('PXEServer', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
  });

  it('creates a PXE server with DHCP mode (default)', () => {
    const pxe = new PXEServer({
      ...LO_CONFIG,
      bootFile: 'pxelinux.0',
      tftpRoot: TEST_ROOT,
    });

    expect(pxe).toBeDefined();
    expect(pxe.isRunning).toBe(false);
  });

  it('creates a PXE server with BOOTP mode', () => {
    const pxe = new PXEServer({
      ...LO_CONFIG,
      bootFile: 'pxelinux.0',
      tftpRoot: TEST_ROOT,
      mode: PXEMode.BOOTP,
    });

    expect(pxe).toBeDefined();
    expect(pxe.isRunning).toBe(false);
  });

  it('exposes inner servers as null before start', () => {
    const pxe = new PXEServer({
      ...LO_CONFIG,
      bootFile: 'pxelinux.0',
      tftpRoot: TEST_ROOT,
      tftpPort: 13750,
    });

    expect(pxe.activeTFTPServer).toBeNull();
    expect(pxe.activeIPServer).toBeNull();
  });

  it('has start/stop methods', () => {
    const pxe = new PXEServer({
      ...LO_CONFIG,
      bootFile: 'pxelinux.0',
      tftpRoot: TEST_ROOT,
      tftpPort: 13751,
    });

    expect(typeof pxe.start).toBe('function');
    expect(typeof pxe.stop).toBe('function');
  });

  it('throws if started twice', async () => {
    const pxe = new PXEServer({
      ...LO_CONFIG,
      bootFile: 'pxelinux.0',
      tftpRoot: TEST_ROOT,
      tftpPort: 13752,
    });

    (pxe as unknown as { running: boolean }).running = true;
    await expect(pxe.start()).rejects.toThrow('already running');
    (pxe as unknown as { running: boolean }).running = false;
  });

  it('stop is idempotent', async () => {
    const pxe = new PXEServer({
      ...LO_CONFIG,
      bootFile: 'pxelinux.0',
      tftpRoot: TEST_ROOT,
    });

    await pxe.stop();
    expect(pxe.isRunning).toBe(false);
  });

  it('event listeners can be registered before start', () => {
    const pxe = new PXEServer({
      ...LO_CONFIG,
      bootFile: 'pxelinux.0',
      tftpRoot: TEST_ROOT,
      tftpPort: 13753,
    });

    const startSpy = vi.fn();
    pxe.on('tftp-start', startSpy);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
