/**
 * YAML configuration file support.
 *
 * tsbootkit.yaml schema:
 *
 * ```yaml
 * interface: eth0
 * bootFile: pxelinux.0
 * tftpRoot: /tftpboot
 * mode: dhcp          # dhcp | bootp
 *
 * serverIP: 192.168.1.1
 * subnetMask: 255.255.255.0
 * router: 192.168.1.1
 * tftpServer: 192.168.1.1
 * dnsServers:
 *   - 8.8.8.8
 *   - 8.8.4.4
 *
 * dhcp:
 *   leaseTime: 600
 *   answerAll: false
 *
 * bootp:
 *   allocationLifetime: 86400
 *
 * tftp:
 *   port: 69
 *   maxTransfers: 16
 *   allowWrite: false
 *
 * followSymlinks: false
 *
 * httpPort: 80
 * http:
 *   host: 0.0.0.0
 *   maxFileSize: 1073741824
 *
 * healthPort: 9470
 * mdnsAddress: 192.168.1.1
 *
 * reservations:
 *   - mac: aa:bb:cc:dd:ee:01
 *     ip: 192.168.1.50
 *     bootFile: custom/boot.efi
 *   - mac: aa:bb:cc:dd:ee:02
 *     ip: 192.168.1.51
 *
 * logging:
 *   level: info
 *   file: /var/log/tsbootkit.log
 * ```
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { IPv4, MAC } from './shared/types.mjs';
import { isValidIPv4, isValidMAC } from './shared/network.mjs';
import { PXEMode } from './pxe/types.mjs';

// ─── Reservation ───────────────────────────────────────────────────

/** A static IP reservation for a known MAC address. */
export interface Reservation {
  mac: MAC;
  ip: IPv4;
  /** Override boot filename for this client. */
  bootFile?: string;
  /** Client hostname (informational). */
  hostname?: string;
  /** Override boot file per architecture for this client. */
  bootFiles?: BootFileMap;
}

/** Map of client architecture → boot filename. */
export interface BootFileMap {
  /** BIOS / Intel x86PC (default for unknown architectures). */
  bios?: string;
  /** UEFI x86-64. */
  efiX86_64?: string;
  /** UEFI ARM64 / AArch64. */
  efiARM64?: string;
}

// ─── DHCP config section ───────────────────────────────────────────

export interface DHCPConfig {
  leaseTime?: number;
  answerAll?: boolean;
}

// ─── BOOTP config section ───────────────────────────────────────────

export interface BOOTPConfig {
  /** Seconds before an unused BOOTP allocation is reclaimed (default 86400 = 24h). */
  allocationLifetime?: number;
}

// ─── TFTP config section ───────────────────────────────────────────

export interface TFTPConfig {
  port?: number;
  maxTransfers?: number;
  allowWrite?: boolean;
}

// ─── HTTP config section ───────────────────────────────────────────

export interface HTTPConfig {
  /** HTTP fallback port for UEFI firmware (0 = disabled, default 0). */
  port?: number;
  /** Host to bind (default '0.0.0.0'). */
  host?: string;
  /** Maximum file size to serve in bytes (default 1GB). */
  maxFileSize?: number;
}

// ─── Logging config section ────────────────────────────────────────

export interface LoggingConfig {
  level?: string;
  file?: string;
}

// ─── Full config ───────────────────────────────────────────────────

/** Parsed and validated tsbootkit configuration. */
export interface TSBootKitConfig {
  interface: string;
  bootFile: string;
  tftpRoot: string;
  mode: PXEMode;

  // Network (all optional — auto-detected from interface)
  serverIP?: IPv4;
  subnetMask?: IPv4;
  router?: IPv4;
  tftpServer?: IPv4;
  dnsServers?: IPv4[];

  dhcp?: DHCPConfig;
  bootp?: BOOTPConfig;
  tftp?: TFTPConfig;
  logging?: LoggingConfig;

  /** Static MAC → IP reservations. No dynamic lease persistence. */
  reservations: Reservation[];
  /** Health check HTTP port (default 9470, 0 = disabled). */
  healthPort?: number;
  /** HTTP fallback server port for UEFI firmware (0 = disabled). */
  httpPort?: number;
  /** HTTP fallback server configuration. */
  http?: HTTPConfig;
  /** Address to advertise via mDNS (defaults to serverIP). Set to '' to disable. */
  mdnsAddress?: string;
  /** Global boot file defaults per client architecture. */
  bootFiles?: BootFileMap;
  /** Transfer hooks to execute on TFTP lifecycle events. */
  hooks?: import('./shared/hooks.mjs').HookConfig[];
  /** Whether to follow symbolic links in TFTP/HTTP file serving (default false). */
  followSymlinks?: boolean;
  /** Whether to wait for the interface to come up before starting (default false). */
  wait?: boolean;
  /** Maximum seconds to wait for the interface (0 = wait forever, default 0). */
  waitTimeout?: number;
  /** Directory that the config file was loaded from (for resolving relative paths). Set by loadConfig(). */
  configDir?: string;
}

// ─── Raw config from YAML ──────────────────────────────────────────

/** Raw parsed YAML before validation. */
interface RawConfig {
  interface?: string;
  bootFile?: string;
  tftpRoot?: string;
  mode?: string;
  serverIP?: string;
  subnetMask?: string;
  router?: string;
  tftpServer?: string;
  dnsServers?: string[];
  dhcp?: DHCPConfig;
  bootp?: BOOTPConfig;
  tftp?: TFTPConfig;
  logging?: LoggingConfig;
  healthPort?: number;
  httpPort?: number;
  http?: HTTPConfig;
  mdnsAddress?: string;
  bootFiles?: BootFileMap;
  hooks?: import('./shared/hooks.mjs').HookConfig[];
  followSymlinks?: boolean;
  wait?: boolean;
  waitTimeout?: number;
  reservations?: Array<{
    mac?: string;
    ip?: string;
    bootFile?: string;
    hostname?: string;
    bootFiles?: BootFileMap;
  }>;
}

// ─── Config error ──────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ─── Loading ───────────────────────────────────────────────────────

/**
 * Load and validate a tsbootkit configuration file.
 *
 * @param configPath - Path to the YAML config file.
 * @returns Validated configuration object.
 * @throws ConfigError if validation fails.
 */
export async function loadConfig(configPath: string): Promise<TSBootKitConfig> {
  const resolvedPath = path.resolve(configPath);

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file: ${resolvedPath} (${(err as Error).message})`);
  }

  let parsed: RawConfig;
  try {
    parsed = parseYaml(raw) as RawConfig;
  } catch (err) {
    throw new ConfigError(`Invalid YAML in config file: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError('Config file is empty or not a valid YAML mapping');
  }

  return validateConfig(parsed, path.dirname(resolvedPath));
}

/**
 * Validate and normalize a raw config object.
 */
export function validateConfig(raw: RawConfig, configDir?: string): TSBootKitConfig {
  const errors: string[] = [];

  // Required fields
  if (!raw.interface) errors.push('Missing required field: interface');
  if (!raw.bootFile) errors.push('Missing required field: bootFile');
  if (!raw.tftpRoot) errors.push('Missing required field: tftpRoot');

  // Validate mode
  if (raw.mode && raw.mode !== 'dhcp' && raw.mode !== 'bootp') {
    errors.push(`Invalid mode: "${raw.mode}" (must be "dhcp" or "bootp")`);
  }

  // Validate IP fields
  if (raw.serverIP && !isValidIPv4(raw.serverIP)) {
    errors.push(`Invalid serverIP: "${raw.serverIP}"`);
  }
  if (raw.subnetMask && !isValidIPv4(raw.subnetMask)) {
    errors.push(`Invalid subnetMask: "${raw.subnetMask}"`);
  }
  if (raw.router && !isValidIPv4(raw.router)) {
    errors.push(`Invalid router: "${raw.router}"`);
  }
  if (raw.tftpServer && !isValidIPv4(raw.tftpServer)) {
    errors.push(`Invalid tftpServer: "${raw.tftpServer}"`);
  }

  // Validate DNS servers
  if (raw.dnsServers) {
    for (const dns of raw.dnsServers) {
      if (!isValidIPv4(dns)) {
        errors.push(`Invalid DNS server: "${dns}"`);
      }
    }
  }

  // Validate reservations
  const reservations: Reservation[] = [];
  if (raw.reservations) {
    for (let i = 0; i < raw.reservations.length; i++) {
      const r = raw.reservations[i]!;
      if (!r.mac) {
        errors.push(`Reservation ${i}: missing required field "mac"`);
        continue;
      }
      if (!isValidMAC(r.mac)) {
        errors.push(`Reservation ${i}: invalid MAC: "${r.mac}"`);
        continue;
      }
      if (!r.ip) {
        errors.push(`Reservation ${i}: missing required field "ip"`);
        continue;
      }
      if (!isValidIPv4(r.ip)) {
        errors.push(`Reservation ${i}: invalid IP: "${r.ip}"`);
        continue;
      }

      // Check for duplicate MACs
      const dupMac = reservations.find((existing) => existing.mac === r.mac);
      if (dupMac) {
        errors.push(`Reservation ${i}: duplicate MAC ${r.mac} (first defined for IP ${dupMac.ip})`);
        continue;
      }

      // Check for duplicate IPs
      const dupIP = reservations.find((existing) => existing.ip === r.ip);
      if (dupIP) {
        errors.push(`Reservation ${i}: duplicate IP ${r.ip} (first defined for MAC ${dupIP.mac})`);
        continue;
      }

      reservations.push({
        mac: r.mac as MAC,
        ip: r.ip as IPv4,
        bootFile: r.bootFile,
        hostname: r.hostname,
        bootFiles: r.bootFiles,
      });
    }
  }

  // Validate DHCP section
  if (raw.dhcp?.leaseTime !== undefined && (raw.dhcp.leaseTime < 60 || raw.dhcp.leaseTime > 86400)) {
    errors.push('dhcp.leaseTime must be between 60 and 86400 seconds');
  }

  // Validate BOOTP section
  if (raw.bootp?.allocationLifetime !== undefined && (raw.bootp.allocationLifetime < 60 || raw.bootp.allocationLifetime > 604800)) {
    errors.push('bootp.allocationLifetime must be between 60 and 604800 seconds');
  }

  // Validate HTTP section
  if (raw.http?.port !== undefined && raw.http.port !== 0 && (raw.http.port < 1 || raw.http.port > 65535)) {
    errors.push('http.port must be between 1 and 65535 (or 0 to disable)');
  }
  if (raw.http?.maxFileSize !== undefined && raw.http.maxFileSize < 0) {
    errors.push('http.maxFileSize must be a positive number');
  }

  // Validate TFTP section
  if (raw.tftp?.port !== undefined && (raw.tftp.port < 1 || raw.tftp.port > 65535)) {
    errors.push('tftp.port must be between 1 and 65535');
  }
  if (raw.tftp?.maxTransfers !== undefined && (raw.tftp.maxTransfers < 1 || raw.tftp.maxTransfers > 1024)) {
    errors.push('tftp.maxTransfers must be between 1 and 1024');
  }

  if (errors.length > 0) {
    throw new ConfigError(`Config validation errors:\n  ${errors.join('\n  ')}`);
  }

  // Resolve and validate hook exec paths
  if (raw.hooks && raw.hooks.length > 0) {
    for (let i = 0; i < raw.hooks.length; i++) {
      const hook = raw.hooks[i]!;
      if (!hook.exec) {
        errors.push(`Hook ${i}: missing required field "exec"`);
        continue;
      }
      // Resolve relative paths against the config file directory
      if (configDir && !path.isAbsolute(hook.exec)) {
        hook.exec = path.resolve(configDir, hook.exec);
      }
      try {
        fsSync.statSync(hook.exec);
      } catch {
        errors.push(`Hook ${i}: executable not found: ${hook.exec}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new ConfigError(`Config validation errors:\n  ${errors.join('\n  ')}`);
  }

  return {
    interface: raw.interface!,
    bootFile: raw.bootFile!,
    tftpRoot: raw.tftpRoot!,
    mode: raw.mode === 'bootp' ? PXEMode.BOOTP : PXEMode.DHCP,
    serverIP: raw.serverIP as IPv4 | undefined,
    subnetMask: raw.subnetMask as IPv4 | undefined,
    router: raw.router as IPv4 | undefined,
    tftpServer: raw.tftpServer as IPv4 | undefined,
    dnsServers: raw.dnsServers as IPv4[] | undefined,
    dhcp: raw.dhcp,
    bootp: raw.bootp,
    tftp: raw.tftp,
    logging: raw.logging,
    healthPort: raw.healthPort,
    httpPort: raw.httpPort,
    http: raw.http,
    mdnsAddress: raw.mdnsAddress,
    bootFiles: raw.bootFiles,
    hooks: raw.hooks,
    followSymlinks: raw.followSymlinks,
    wait: raw.wait,
    waitTimeout: raw.waitTimeout,
    configDir,
    reservations,
  };
}

/**
 * Find a reservation for a given MAC address.
 */
export function findReservation(config: TSBootKitConfig, mac: MAC): Reservation | undefined {
  return config.reservations.find((r) => r.mac === mac);
}

// ─── Boot file resolution ────────────────────────────────────────────

import { ClientArchitecture } from './dhcp/types.mjs';

/**
 * Resolve the boot filename for a client based on its architecture.
 *
 * Priority:
 *   1. Per-reservation `bootFile` (exact override, ignores architecture)
 *   2. Per-reservation `bootFiles` map (architecture-specific for this MAC)
 *   3. Global `bootFiles` map (architecture-specific default)
 *   4. Global `bootFile` (catch-all default)
 *
 * @param reservation - The MAC's reservation, if any.
 * @param globalBootFiles - Architecture-to-boot-file map from server config.
 * @param defaultBootFile - Fallback boot filename.
 * @param arch - Client architecture from DHCP option 93.
 */
export function resolveBootFile(
  reservation: { bootFile?: string; bootFiles?: BootFileMap } | undefined,
  globalBootFiles: BootFileMap | undefined,
  defaultBootFile: string,
  arch?: ClientArchitecture,
): string {
  // 1. Per-reservation exact override
  if (reservation?.bootFile) {
    return reservation.bootFile;
  }

  // 2. Per-reservation architecture map
  if (reservation?.bootFiles) {
    const resolved = archToBootFile(reservation.bootFiles, arch);
    if (resolved) return resolved;
  }

  // 3. Global architecture map
  if (globalBootFiles) {
    const resolved = archToBootFile(globalBootFiles, arch);
    if (resolved) return resolved;
  }

  // 4. Global default
  return defaultBootFile;
}

/**
 * Map a client architecture to a boot filename from a BootFileMap.
 */
export function archToBootFile(map: BootFileMap, arch?: ClientArchitecture): string | undefined {
  if (arch === undefined) return map.bios;

  switch (arch) {
    case ClientArchitecture.BIOS:
    case ClientArchitecture.NEC_PC98:
    case ClientArchitecture.EFI_Arc:
    case ClientArchitecture.EFI_ILC:
      return map.bios;
    case ClientArchitecture.EFI_x86_64:
    case ClientArchitecture.EFI_IA64:
    case ClientArchitecture.EFI_x86:
      return map.efiX86_64;
    case ClientArchitecture.EFI_ARM32:
    case ClientArchitecture.EFI_ARM64:
      return map.efiARM64;
    default:
      // RISC-V, Alpha, unknown — fall back to x86-64 as most common
      return map.efiX86_64;
  }
}
