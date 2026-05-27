/**
 * BOOTP type definitions.
 *
 * BOOTP (RFC951) is the predecessor to DHCP. The packet format is
 * identical to DHCP — same fixed fields, same magic cookie, same
 * RFC1497 vendor extensions. The only difference: no DHCP Message Type
 * option (53), no lease negotiation, just request → reply.
 *
 * We reuse the DHCP packet structure and add BOOTP-specific semantics.
 */

import { IPv4 } from '../shared/types.mjs';

// ─── BOOTP constants ───────────────────────────────────────────────

/** BOOTP operation codes (RFC951). */
export enum BOOTPOp {
  REQUEST = 1,
  REPLY   = 2,
}

/** BOOTP server port (same as DHCP). */
export const BOOTP_SERVER_PORT = 67;

/** BOOTP client port (same as DHCP). */
export const BOOTP_CLIENT_PORT = 68;

/** BOOTP minimum packet size (RFC951 §3). */
export const BOOTP_MIN_PACKET_SIZE = 300;

/** BOOTP broadcast flag. */
export const BOOTP_BROADCAST_FLAG = 0x8000;

// ─── BOOTP server config ───────────────────────────────────────────

/** BOOTP server configuration. */
export interface BOOTPServerConfig {
  /** Network interface to listen on. */
  interface: string;
  /** PXE boot filename (e.g. "pxelinux.0"). */
  bootFile: string;
  /** Server IP address. */
  serverIP?: IPv4;
  /** Subnet mask. */
  subnetMask?: IPv4;
  /** Default gateway (defaults to server IP). */
  router?: IPv4;
  /** TFTP server IP (defaults to server IP). */
  tftpServer?: IPv4;
  /** DNS servers. */
  dnsServers?: IPv4[];
  /** Architecture-specific boot files. */
  bootFiles?: import('../config.mts').BootFileMap;
  /** BOOTP event hooks. */
  hooks?: import('../shared/hooks.mjs').HookConfig[];
  /** Seconds before an unused BOOTP allocation is reclaimed (default 86400 = 24h). */
  allocationLifetime?: number;
}
