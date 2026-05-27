/**
 * TFTP type definitions.
 *
 * RFC1350 — The TFTP Protocol (revision 2)
 * RFC2347 — TFTP Option Extension
 * RFC2348 — TFTP Blocksize Option
 * RFC2349 — TFTP Timeout Interval and Transfer Size Options
 * RFC7440 — TFTP Windowsize Option
 */

// ─── Opcodes ────────────────────────────────────────────────────────

/** TFTP packet opcodes (RFC1350 §4). */
export enum Opcode {
  RRQ   = 1,
  WRQ   = 2,
  DATA  = 3,
  ACK   = 4,
  ERROR = 5,
  OACK  = 6,
}

/** Human-readable opcode names. */
export const OPCODE_NAMES: Record<Opcode, string> = {
  [Opcode.RRQ]:   'RRQ',
  [Opcode.WRQ]:   'WRQ',
  [Opcode.DATA]:  'DATA',
  [Opcode.ACK]:   'ACK',
  [Opcode.ERROR]: 'ERROR',
  [Opcode.OACK]:  'OACK',
};

// ─── Error codes ────────────────────────────────────────────────────

/** TFTP error codes (RFC1350 §4). */
export enum ErrorCode {
  NotDefined          = 0,
  FileNotFound        = 1,
  AccessViolation     = 2,
  DiskFull            = 3,
  IllegalOperation    = 4,
  UnknownTransferID   = 5,
  FileAlreadyExists   = 6,
  NoSuchUser          = 7,
  OptionNegotiation   = 8,
}

/** Default error messages per error code. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.NotDefined]:        'Not defined, see error message (if any).',
  [ErrorCode.FileNotFound]:      'File not found.',
  [ErrorCode.AccessViolation]:   'Access violation.',
  [ErrorCode.DiskFull]:          'Disk full or allocation exceeded.',
  [ErrorCode.IllegalOperation]:  'Illegal TFTP operation.',
  [ErrorCode.UnknownTransferID]: 'Unknown transfer ID.',
  [ErrorCode.FileAlreadyExists]: 'File already exists.',
  [ErrorCode.NoSuchUser]:        'No such user.',
  [ErrorCode.OptionNegotiation]: 'Option negotiation failed.',
};

// ─── Transfer modes ─────────────────────────────────────────────────

/** TFTP transfer modes (RFC1350). 'mail' is deprecated. */
export type TransferMode = 'netascii' | 'octet';

export const TRANSFER_MODES: Set<TransferMode> = new Set(['netascii', 'octet']);

// ─── Options ────────────────────────────────────────────────────────

/** TFTP option names. */
export type OptionName = 'blksize' | 'timeout' | 'tsize' | 'windowsize';

/** Known TFTP option names (RFC2348, RFC2349, RFC7440). */
export const OPTION_NAMES: Set<OptionName> = new Set(['blksize', 'timeout', 'tsize', 'windowsize']);

/** Option value constraints. */
export const OPTION_LIMITS = {
  blksize:    { min: 8,     max: 65464, default: 512  } as const,
  timeout:    { min: 1,     max: 255,   default: undefined } as const, // no default — only used when requested
  tsize:      { min: 0,     max: Infinity } as const, // tsize has no upper bound
  windowsize: { min: 1,     max: 65535,  default: 1    } as const,
} as const;

/** Raw option values as received in packets (strings). */
export type RawOptions = Partial<Record<OptionName, string>>;

/** Parsed and validated option values. */
export interface ValidatedOptions {
  blksize: number;
  timeout?: number;
  tsize?: number;
  windowsize: number;
}

// ─── Packet types ───────────────────────────────────────────────────

/** A parsed RRQ packet. */
export interface RRQPacket {
  opcode: Opcode.RRQ;
  filename: string;
  mode: TransferMode;
  options: RawOptions;
}

/** A parsed WRQ packet. */
export interface WRQPacket {
  opcode: Opcode.WRQ;
  filename: string;
  mode: TransferMode;
  options: RawOptions;
}

/** A parsed DATA packet. */
export interface DATAPacket {
  opcode: Opcode.DATA;
  blockNum: number;
  data: Buffer;
}

/** A parsed ACK packet. */
export interface ACKPacket {
  opcode: Opcode.ACK;
  blockNum: number;
}

/** A parsed ERROR packet. */
export interface ERRORPacket {
  opcode: Opcode.ERROR;
  errorCode: ErrorCode;
  message: string;
}

/** A parsed OACK packet. */
export interface OACKPacket {
  opcode: Opcode.OACK;
  options: RawOptions;
}

/** Union of all parsed TFTP packet types. */
export type TFTPPacket = RRQPacket | WRQPacket | DATAPacket | ACKPacket | ERRORPacket | OACKPacket;

// ─── Constants ──────────────────────────────────────────────────────

/** Default block size per RFC1350. */
export const DEFAULT_BLOCK_SIZE = 512;

/** Enhanced block size for LAN environments. */
export const LAN_BLOCK_SIZE = 1400;

/** Default window size (no windowing). */
export const DEFAULT_WINDOW_SIZE = 1;

/** Enhanced window size for LAN environments. */
export const LAN_WINDOW_SIZE = 8;

/** Maximum block number before wraparound (2^16). */
export const BLOCKNUM_MAX = 65536;

/** Block number to reset to on wraparound. */
export const BLOCKNUM_RESET = 1;

/** Opcode field length in bytes. */
export const OPCODE_LEN = 2;

/** Block number field length in bytes. */
export const BLOCKNUM_LEN = 2;

/** Minimum valid packet length (opcode only). */
export const MIN_PACKET_LEN = OPCODE_LEN;

/** DATA packet overhead: opcode (2) + block number (2) = 4 bytes. */
export const DATA_HEADER_LEN = OPCODE_LEN + BLOCKNUM_LEN;

/** LAN defaults for client connections. */
export const LAN_DEFAULTS: ValidatedOptions = {
  blksize: LAN_BLOCK_SIZE,
  windowsize: LAN_WINDOW_SIZE,
};

/** RFC1350 strict-mode defaults. */
export const RFC1350_DEFAULTS: ValidatedOptions = {
  blksize: DEFAULT_BLOCK_SIZE,
  windowsize: DEFAULT_WINDOW_SIZE,
};
