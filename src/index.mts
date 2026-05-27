/**
 * tsbootkit — TypeScript PXE/TFTP Toolkit
 *
 * Public API exports.
 */

// ─── Shared ────────────────────────────────────────────────────────

export { IPv4, MAC, InterfaceConfig, NetworkCIDR, Peer } from './shared/types.mjs';
export { getInterfaceConfig, isValidIPv4, isValidMAC, computeCIDR, generateRandomIP } from './shared/network.mjs';
export { createLogger, verboseCountToLevel } from './shared/logger.mjs';
export type { TsbootkitLevel } from './shared/logger.mjs';
export { onShutdown } from './shared/signals.mjs';

export { runHook, runHooks, buildHookArgs } from './shared/hooks.mjs';
export type { HookEvent, TFTPHookEvent, DHCPHookEvent, BOOTPHookEvent, HookConfig, HookContext, TFTPHookContext, DHCPHookContext, BOOTPHookContext } from './shared/hooks.mjs';

// ─── TFTP ──────────────────────────────────────────────────────────

export { Opcode, OPCODE_NAMES, ErrorCode, ERROR_MESSAGES, TransferMode, TRANSFER_MODES, OptionName, OPTION_NAMES, OPTION_LIMITS, RawOptions, ValidatedOptions, TFTPPacket, RRQPacket, WRQPacket, DATAPacket, ACKPacket, ERRORPacket, OACKPacket, } from './tftp/types.mjs';
export { ProtocolError, getOpcode, encodeRRQ, encodeWRQ, encodeDATA, encodeACK, encodeERROR, encodeOACK, parsePacket, parseRRQPayload, parseWRQPayload, parseDATAPayload, parseACKPayload, parseERRORPayload, parseOACKPayload, validateOptions, getDataPacketSize, validatedToRaw, } from './tftp/protocol.mjs';
export { TransferState, DEFAULT_TIMEOUT_SECS, DEFAULT_MAX_RETRIES, PeerInfo, StateResult, TFTPTransfer, } from './tftp/state.mjs';
export { TFTPServer } from './tftp/server.mjs';
export { TFTPClient, TFTPRepl } from './tftp/client.mjs';

// ─── DHCP ──────────────────────────────────────────────────────────

export { DHCPMessageType, DHCPOption, DHCPServerConfig, DHCP_SERVER_PORT, DHCP_CLIENT_PORT, DEFAULT_LEASE_TIME } from './dhcp/types.mjs';
export { parseDHCPPacket, encodeDHCPReply, encodeRawDHCPFrame, DHCPProtocolError } from './dhcp/protocol.mjs';
export { DHCPServer } from './dhcp/server.mjs';

// ─── BOOTP ─────────────────────────────────────────────────────────

export { BOOTPOp, BOOTPServerConfig, BOOTP_SERVER_PORT, BOOTP_CLIENT_PORT } from './bootp/types.mjs';
export { encodeBOOTPReply } from './bootp/protocol.mjs';
export { BOOTPServer } from './bootp/server.mjs';

// ─── PXE ───────────────────────────────────────────────────────────

export { PXEMode, PXEServerConfig, PXEServerEvents } from './pxe/types.mjs';
export { PXEServer } from './pxe/server.mjs';

// ─── Config ──────────────────────────────────────────────────────────

export { loadConfig, validateConfig, findReservation, resolveBootFile, archToBootFile, ConfigError } from './config.mjs';
export type { TSBootKitConfig, Reservation, BootFileMap, DHCPConfig, TFTPConfig, LoggingConfig } from './config.mjs';
