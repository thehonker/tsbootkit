/**
 * DHCP type definitions.
 *
 * A stripped-down DHCP implementation designed exclusively for PXE boot.
 * Only supports the operations and options needed for PXE.
 *
 * RFC1533 — DHCP Options and BOOTP Vendor Extensions
 * RFC2131 — Dynamic Host Configuration Protocol
 */

import { IPv4, MAC } from '../shared/types.mjs';

// ─── DHCP opcodes ──────────────────────────────────────────────────

/** DHCP message types (RFC2131 §7). */
export enum DHCPMessageType {
  DISCOVER = 1,
  OFFER    = 2,
  REQUEST  = 3,
  DECLINE  = 4,
  ACK      = 5,
  NAK      = 6,
  RELEASE  = 7,
  INFORM   = 8,
}

// ─── DHCP options ──────────────────────────────────────────────────

/** DHCP option codes we care about (RFC1533). */
export enum DHCPOption {
  Pad                = 0,
  SubnetMask         = 1,
  Router             = 3,
  DNS                = 6,
  Hostname           = 12,
  DomainName         = 15,
  RequestedIP        = 50,
  LeaseTime          = 51,
  MessageType        = 53,
  ServerID           = 54,
  VendorClassID      = 60,
  ClientUUID         = 61,
  PXEVendor          = 43,
  ClientArch         = 93,
  End                = 255,
  ClientUUID2        = 97,
}

/** PXE client architecture types (RFC4578, option 93). */
export enum ClientArchitecture {
  /** Intel x86PC (BIOS). */
  BIOS       = 0,
  /** NEC/PC98. */
  NEC_PC98   = 1,
  /** EFI Itanium. */
  EFI_IA64   = 2,
  /** EFI x86-64 (UEFI). */
  EFI_x86_64 = 3,
  /** EFI DEC Alpha. */
  EFI_Alpha  = 4,
  /** EFI Arc x86. */
  EFI_Arc    = 5,
  /** EFI Intel Lean Client. */
  EFI_ILC    = 6,
  /** EFI ARM 32-bit. */
  EFI_ARM32  = 7,
  /** EFI ARM 64-bit (AArch64). */
  EFI_ARM64  = 8,
  /** EFI x86 (32-bit UEFI). */
  EFI_x86    = 9,
  /** EFI RISC-V 32-bit. */
  EFI_RV32   = 10,
  /** EFI RISC-V 64-bit. */
  EFI_RV64   = 11,
  /** EFI RISC-V 128-bit. */
  EFI_RV128  = 12,
}

/** DHCP option value — can be a raw Buffer or a parsed value. */
export type DHCPOptionValue = Buffer | string | number | IPv4 | IPv4[];

/** Raw DHCP option as read from the wire. */
export interface RawDHCPOption {
  code: DHCPOption;
  data: Buffer;
}

// ─── DHCP packet ───────────────────────────────────────────────────

/** Parsed DHCP packet. */
export interface DHCPPacket {
  /** Message op code: 1 = BOOTREQUEST, 2 = BOOTREPLY. */
  op: number;
  /** Hardware address type (1 = Ethernet). */
  htype: number;
  /** Hardware address length (6 for Ethernet). */
  hlen: number;
  /** Hop count. */
  hops: number;
  /** Transaction ID. */
  xid: number;
  /** Seconds elapsed since client began address acquisition. */
  secs: number;
  /** Flags. */
  flags: number;
  /** Client IP address. */
  ciaddr: IPv4;
  /** 'Your' (offered) IP address. */
  yiaddr: IPv4;
  /** Next server IP address (TFTP server for PXE). */
  siaddr: IPv4;
  /** Relay agent IP address. */
  giaddr: IPv4;
  /** Client hardware address. */
  chaddr: MAC;
  /** Server hostname. */
  sname: string;
  /** Boot filename. */
  file: string;
  /** Parsed DHCP options. */
  options: Map<DHCPOption, RawDHCPOption>;
  /** The DHCP message type option value, if present. */
  messageType?: DHCPMessageType;
  /** Whether this is a PXE client request. */
  isPXE: boolean;
  /** Client-requested IP address, if present. */
  requestedIP?: IPv4;
  /** Client UUID, if present. */
  clientUUID?: string;
  /** Client architecture (option 93), if present. */
  clientArch?: ClientArchitecture;
  /** Client hostname (option 12), if present. */
  hostname?: string;
  /** Server identifier (option 54) from the request, if present. */
  serverID?: IPv4;
}

// ─── DHCP server config ────────────────────────────────────────────

/** DHCP server configuration. */
export interface DHCPServerConfig {
  /** Network interface to listen on. */
  interface: string;
  /** PXE boot filename (e.g. "pxelinux.0"). */
  bootFile: string;
  /** Server IP address (auto-detected from interface if omitted). */
  serverIP?: IPv4;
  /** Subnet mask (auto-detected from interface if omitted). */
  subnetMask?: IPv4;
  /** Default gateway (defaults to server IP). */
  router?: IPv4;
  /** TFTP server IP (defaults to server IP). */
  tftpServer?: IPv4;
  /** DNS servers. */
  dnsServers?: IPv4[];
  /** DHCP lease time in seconds (default 600 = 10 minutes). */
  leaseTime?: number;
  /** Whether to respond to non-PXE DHCP requests (default false). */
  answerAll?: boolean;
  /** Global boot file defaults per client architecture. */
  bootFiles?: import('../config.mts').BootFileMap;
  /** DHCP event hooks. */
  hooks?: import('../shared/hooks.mjs').HookConfig[];
}

// ─── Constants ─────────────────────────────────────────────────────

/** DHCP magic cookie (RFC1497). */
export const DHCP_MAGIC_COOKIE = 0x63825363;

/** DHCP server port. */
export const DHCP_SERVER_PORT = 67;

/** DHCP client port. */
export const DHCP_CLIENT_PORT = 68;

/** Default lease time: 10 minutes. */
export const DEFAULT_LEASE_TIME = 600;

/** Internal lease timeout: 15 minutes (allows client to wrap up). */
export const INTERNAL_LEASE_TIME = 900;

/** Client UUID length (16 bytes). */
export const CLIENT_UUID_LENGTH = 16;

/** Minimum DHCP packet size. */
export const MIN_DHCP_PACKET_SIZE = 240; // 236 fixed + 4 magic cookie

/** DHCP packet fixed portion size (before options). */
export const DHCP_FIXED_SIZE = 236;

/** Maximum DHCP packet size (RFC2131). */
export const MAX_DHCP_PACKET_SIZE = 576;
