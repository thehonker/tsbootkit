import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateConfig,
  loadConfig,
  findReservation,
  resolveBootFile,
  ConfigError,
} from '../src/config.mjs';
import { PXEMode } from '../src/pxe/types.mjs';
import { ClientArchitecture } from '../src/dhcp/types.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ── validateConfig ──────────────────────────────────────────────────

describe('validateConfig', () => {
  it('validates a minimal valid config', () => {
    const config = validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
    });

    expect(config.interface).toBe('eth0');
    expect(config.bootFile).toBe('pxelinux.0');
    expect(config.tftpRoot).toBe('/tftpboot');
    expect(config.mode).toBe(PXEMode.DHCP); // default
    expect(config.reservations).toEqual([]);
  });

  it('validates a full config with all fields', () => {
    const config = validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      mode: 'bootp',
      serverIP: '192.168.1.1',
      subnetMask: '255.255.255.0',
      router: '192.168.1.1',
      tftpServer: '192.168.1.1',
      dnsServers: ['8.8.8.8', '8.8.4.4'],
      dhcp: { leaseTime: 300, answerAll: true },
      tftp: { port: 6969, maxTransfers: 32, allowWrite: true },
      logging: { level: 'debug', file: '/tmp/tsbootkit.log' },
    });

    expect(config.mode).toBe(PXEMode.BOOTP);
    expect(config.serverIP).toBe('192.168.1.1');
    expect(config.dnsServers).toEqual(['8.8.8.8', '8.8.4.4']);
  });

  it('rejects missing required fields', () => {
    expect(() => validateConfig({})).toThrow(ConfigError);
    expect(() => validateConfig({ interface: 'eth0' })).toThrow(ConfigError);
    expect(() => validateConfig({ interface: 'eth0', bootFile: 'pxelinux.0' })).toThrow(ConfigError);
  });

  it('rejects invalid mode', () => {
    expect(() => validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      mode: 'invalid',
    })).toThrow(ConfigError);
  });

  it('rejects invalid IP addresses', () => {
    expect(() => validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      serverIP: 'not-an-ip',
    })).toThrow(ConfigError);
  });

  it('rejects invalid DNS servers', () => {
    expect(() => validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      dnsServers: ['8.8.8.8', 'not-a-dns'],
    })).toThrow(ConfigError);
  });
});

// ── Reservations ────────────────────────────────────────────────────

describe('reservations', () => {
  it('parses valid reservations', () => {
    const config = validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      reservations: [
        { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.50', bootFile: 'custom.efi' },
        { mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.1.51' },
      ],
    });

    expect(config.reservations).toHaveLength(2);
    expect(config.reservations[0]).toEqual({
      mac: 'aa:bb:cc:dd:ee:01',
      ip: '192.168.1.50',
      bootFile: 'custom.efi',
      hostname: undefined,
    });
    expect(config.reservations[1]).toEqual({
      mac: 'aa:bb:cc:dd:ee:02',
      ip: '192.168.1.51',
      bootFile: undefined,
      hostname: undefined,
    });
  });

  it('rejects reservation with missing MAC', () => {
    expect(() => validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      reservations: [{ ip: '192.168.1.50' }],
    })).toThrow(ConfigError);
  });

  it('rejects reservation with missing IP', () => {
    expect(() => validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      reservations: [{ mac: 'aa:bb:cc:dd:ee:01' }],
    })).toThrow(ConfigError);
  });

  it('rejects reservation with invalid MAC', () => {
    expect(() => validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      reservations: [{ mac: 'invalid', ip: '192.168.1.50' }],
    })).toThrow(ConfigError);
  });

  it('rejects reservation with invalid IP', () => {
    expect(() => validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      reservations: [{ mac: 'aa:bb:cc:dd:ee:01', ip: 'invalid' }],
    })).toThrow(ConfigError);
  });

  it('rejects duplicate MAC in reservations', () => {
    expect(() => validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      reservations: [
        { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.50' },
        { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.51' },
      ],
    })).toThrow(/duplicate MAC/);
  });

  it('rejects duplicate IP in reservations', () => {
    expect(() => validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      reservations: [
        { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.50' },
        { mac: 'aa:bb:cc:dd:ee:02', ip: '192.168.1.50' },
      ],
    })).toThrow(/duplicate IP/);
  });
});

// ── findReservation ─────────────────────────────────────────────────

describe('findReservation', () => {
  it('finds a reservation by MAC', () => {
    const config = validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      reservations: [
        { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.50', bootFile: 'custom.efi' },
      ],
    });

    const r = findReservation(config, 'aa:bb:cc:dd:ee:01');
    expect(r).toBeDefined();
    expect(r!.ip).toBe('192.168.1.50');
    expect(r!.bootFile).toBe('custom.efi');
  });

  it('returns undefined for unknown MAC', () => {
    const config = validateConfig({
      interface: 'eth0',
      bootFile: 'pxelinux.0',
      tftpRoot: '/tftpboot',
      reservations: [
        { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.50' },
      ],
    });

    expect(findReservation(config, 'ff:ff:ff:ff:ff:ff')).toBeUndefined();
  });
});

// ── loadConfig (file) ───────────────────────────────────────────────

describe('loadConfig', () => {
  const tmpDir = path.join(os.tmpdir(), 'tsbootkit-config-test');

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid YAML config file', async () => {
    const configPath = path.join(tmpDir, 'valid.yaml');
    await fs.writeFile(configPath, `
interface: eth0
bootFile: pxelinux.0
tftpRoot: /tftpboot
mode: bootp
reservations:
  - mac: aa:bb:cc:dd:ee:01
    ip: 192.168.1.50
    hostname: testbox
`);

    const config = await loadConfig(configPath);
    expect(config.interface).toBe('eth0');
    expect(config.mode).toBe(PXEMode.BOOTP);
    expect(config.reservations).toHaveLength(1);
    expect(config.reservations[0]!.hostname).toBe('testbox');
  });

  it('rejects a nonexistent file', async () => {
    await expect(loadConfig('/nonexistent/path.yaml')).rejects.toThrow(ConfigError);
  });

  it('rejects invalid YAML', async () => {
    const configPath = path.join(tmpDir, 'invalid.yaml');
    await fs.writeFile(configPath, `
interface: eth0
  bad indent: here
`);
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
  });

  it('rejects YAML with validation errors', async () => {
    const configPath = path.join(tmpDir, 'bad-fields.yaml');
    await fs.writeFile(configPath, `
interface: eth0
bootFile: pxelinux.0
tftpRoot: /tftpboot
serverIP: not-valid
`);
    await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
  });
});

// ── resolveBootFile ──────────────────────────────────────────────────

describe('resolveBootFile', () => {
  it('falls back to global bootFile when no bootFiles map', () => {
    expect(resolveBootFile(undefined, undefined, 'pxelinux.0')).toBe('pxelinux.0');
  });

  it('uses global bootFiles map based on architecture', () => {
    const globalBootFiles = {
      bios: 'pxelinux.0',
      efiX86_64: 'bootx64.efi',
      efiARM64: 'grubaa64.efi',
    };

    expect(resolveBootFile(undefined, globalBootFiles, 'pxelinux.0', ClientArchitecture.BIOS)).toBe('pxelinux.0');
    expect(resolveBootFile(undefined, globalBootFiles, 'pxelinux.0', ClientArchitecture.EFI_x86_64)).toBe('bootx64.efi');
    expect(resolveBootFile(undefined, globalBootFiles, 'pxelinux.0', ClientArchitecture.EFI_ARM64)).toBe('grubaa64.efi');
  });

  it('falls back to efiX86_64 for unknown architecture', () => {
    const globalBootFiles = {
      bios: 'pxelinux.0',
      efiX86_64: 'bootx64.efi',
      efiARM64: 'grubaa64.efi',
    };

    // RISC-V — unknown, falls back to efiX86_64
    expect(resolveBootFile(undefined, globalBootFiles, 'pxelinux.0', 11 as ClientArchitecture)).toBe('bootx64.efi');
  });

  it('per-reservation bootFile overrides everything', () => {
    const reservation = { bootFile: 'custom.efi' };
    const globalBootFiles = {
      bios: 'pxelinux.0',
      efiX86_64: 'bootx64.efi',
    };

    // Even with architecture specified, the exact override wins
    expect(resolveBootFile(reservation, globalBootFiles, 'pxelinux.0', ClientArchitecture.EFI_x86_64)).toBe('custom.efi');
  });

  it('per-reservation bootFiles overrides global bootFiles', () => {
    const reservation = {
      bootFiles: {
        bios: 'local-bios.efi',
        efiX86_64: 'local-x64.efi',
      },
    };
    const globalBootFiles = {
      bios: 'global-bios.efi',
      efiX86_64: 'global-x64.efi',
    };

    expect(resolveBootFile(reservation, globalBootFiles, 'pxelinux.0', ClientArchitecture.BIOS)).toBe('local-bios.efi');
    expect(resolveBootFile(reservation, globalBootFiles, 'pxelinux.0', ClientArchitecture.EFI_x86_64)).toBe('local-x64.efi');
    // No reservation uses global
    expect(resolveBootFile(undefined, globalBootFiles, 'pxelinux.0', ClientArchitecture.BIOS)).toBe('global-bios.efi');
  });

  it('partial bootFiles falls back to global bootFile', () => {
    const globalBootFiles = {
      efiX86_64: 'bootx64.efi',
      // No bios entry
    };

    // BIOS not in bootFiles, falls back to global bootFile
    expect(resolveBootFile(undefined, globalBootFiles, 'pxelinux.0', ClientArchitecture.BIOS)).toBe('pxelinux.0');
    expect(resolveBootFile(undefined, globalBootFiles, 'pxelinux.0', ClientArchitecture.EFI_x86_64)).toBe('bootx64.efi');
  });

  it('no architecture returns bios entry', () => {
    const globalBootFiles = {
      bios: 'pxelinux.0',
      efiX86_64: 'bootx64.efi',
    };

    expect(resolveBootFile(undefined, globalBootFiles, 'pxelinux.0')).toBe('pxelinux.0');
  });
});
