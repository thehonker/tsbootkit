/**
 * PXE type definitions.
 *
 * The PXE daemon combines TFTP + DHCP/BOOTP into a single process
 * for network boot environments.
 */

import { IPv4, MAC } from '../shared/types.mjs';
import type { Reservation } from '../config.mjs';

// ─── PXE server mode ───────────────────────────────────────────────

/** Which protocol to use for IP assignment. */
export enum PXEMode {
  /** DHCP with PXE extensions (default, modern). */
  DHCP = 'dhcp',
  /** Legacy BOOTP (RFC951). */
  BOOTP = 'bootp',
}

// ─── PXE server config ─────────────────────────────────────────────

/** PXE daemon configuration. */
export interface PXEServerConfig {
  /** Network interface to serve on. */
  interface: string;
  /** PXE boot filename (e.g. "pxelinux.0"). */
  bootFile: string;
  /** TFTP server root directory. */
  tftpRoot: string;
  /** IP assignment mode: DHCP or BOOTP. */
  mode?: PXEMode;
  /** Server IP address. */
  serverIP?: IPv4;
  /** Subnet mask. */
  subnetMask?: IPv4;
  /** Default gateway. */
  router?: IPv4;
  /** TFTP server IP (if different from this host). */
  tftpServer?: IPv4;
  /** DNS servers. */
  dnsServers?: IPv4[];
  /** DHCP-specific configuration. */
  dhcp?: import('../config.mts').DHCPConfig;
  /** TFTP server port (default 69). */
  tftpPort?: number;
  /** Maximum concurrent TFTP transfers (default 16). */
  maxTransfers?: number;
  /** Allow TFTP write (WRQ) requests. */
  allowWrite?: boolean;
  /** Static MAC → IP reservations from config. */
  reservations?: Reservation[];
  /** Health check HTTP port (default 9470, set to 0 to disable). */
  healthPort?: number;
  /** HTTP fallback server port for UEFI firmware (default 0 = disabled). */
  httpPort?: number;
  /** HTTP fallback server configuration. */
  http?: import('../config.mts').HTTPConfig;
  /** Address to advertise via mDNS (defaults to serverIP). Set to '' to disable. */
  mdnsAddress?: string;
  /** Global boot file defaults per client architecture. */
  bootFiles?: import('../config.mjs').BootFileMap;
  /** Transfer hooks to execute on TFTP lifecycle events. */
  hooks?: import('../shared/hooks.mjs').HookConfig[];
  /** BOOTP-specific configuration. */
  bootp?: import('../config.mts').BOOTPConfig;
  /** Whether to follow symbolic links in TFTP/HTTP file serving (default false). */
  followSymlinks?: boolean;
  /** Whether to wait for the interface to come up before starting (default false). */
  wait?: boolean;
  /** Maximum seconds to wait for the interface (0 = wait forever, default 0). Only meaningful when wait is true. */
  waitTimeout?: number;
}

// ─── PXE server events (reserved for future use) ────────────────────

// ─── PXE server events ─────────────────────────────────────────────

export interface PXEServerEvents {
  'dhcp-discover': (mac: MAC, uuid: string | undefined) => void;
  'dhcp-offer': (mac: MAC, ip: IPv4) => void;
  'dhcp-request': (mac: MAC, ip: IPv4) => void;
  'dhcp-ack': (mac: MAC, ip: IPv4) => void;
  'bootp-request': (mac: MAC) => void;
  'bootp-reply': (mac: MAC, ip: IPv4) => void;
  'tftp-start': (file: string, peer: string) => void;
  'tftp-end': (file: string, peer: string) => void;
  'tftp-error': (file: string, peer: string, err: Error) => void;
  'ready': () => void;
  'close': () => void;
  'error': (err: Error) => void;
}
