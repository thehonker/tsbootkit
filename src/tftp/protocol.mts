/**
 * TFTP packet codec.
 *
 * Pure functions for encoding and decoding TFTP packets using Node.js Buffers.
 * Replaces Python's `struct.pack`/`struct.unpack` with `Buffer` read/write.
 *
 * All encode functions return a Buffer ready to send.
 * All parse functions accept a Buffer (with or without the leading opcode)
 * and return a typed packet object.
 *
 * Packet formats (RFC1350):
 *   RRQ/WRQ:  | opcode (2) | filename\0 | mode\0 | [option\0 value\0 ...] |
 *   DATA:     | opcode (2) | block# (2) | data (0..blksize) |
 *   ACK:      | opcode (2) | block# (2) |
 *   ERROR:    | opcode (2) | error# (2) | errmsg\0 |
 *   OACK:     | opcode (2) | option\0 value\0 ... |
 */

import {
  Opcode,
  ErrorCode,
  ERROR_MESSAGES,
  TRANSFER_MODES,
  OptionName,
  OPTION_NAMES,
  OPTION_LIMITS,
  RawOptions,
  ValidatedOptions,
  RRQPacket,
  WRQPacket,
  DATAPacket,
  ACKPacket,
  ERRORPacket,
  OACKPacket,
  TFTPPacket,
  OPCODE_LEN,
  BLOCKNUM_LEN,
  DATA_HEADER_LEN,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_WINDOW_SIZE,
} from './types.mjs';

// ─── Protocol error ─────────────────────────────────────────────────

/** Error thrown when a packet cannot be parsed. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// ─── Opcode extraction ──────────────────────────────────────────────

/**
 * Extract the opcode from a raw TFTP packet.
 * Returns `undefined` if the buffer is too short.
 */
export function getOpcode(buf: Buffer): Opcode | undefined {
  if (buf.length < OPCODE_LEN) return undefined;
  return buf.readUInt16BE(0) as Opcode;
}

// ─── Null-terminated string helpers ─────────────────────────────────

/**
 * Write a null-terminated ASCII string into a buffer at the given offset.
 * Returns the new offset after the written string + null byte.
 */
function writeNullString(buf: Buffer, offset: number, str: string): number {
  buf.write(str, offset, 'ascii');
  offset += str.length;
  buf.writeUInt8(0, offset);
  return offset + 1;
}

/**
 * Split a buffer of null-terminated strings into an array of strings.
 * The buffer should contain sequences of null-terminated ASCII strings.
 */
function splitNullStrings(buf: Buffer): string[] {
  const parts: string[] = [];
  let start = 0;

  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      parts.push(buf.subarray(start, i).toString('ascii'));
      start = i + 1;
    }
  }

  // If the buffer doesn't end with a null byte, take the remainder
  if (start < buf.length) {
    parts.push(buf.subarray(start).toString('ascii'));
  }

  return parts;
}

/**
 * Parse null-terminated option pairs from a buffer region.
 * Returns a RawOptions map (lowercase keys, string values).
 * Throws ProtocolError if the option list is malformed (odd number of parts).
 */
function parseOptionPairs(buf: Buffer, offset: number, length: number): RawOptions {
  const region = buf.subarray(offset, offset + length);
  const parts = splitNullStrings(region);

  // Remove trailing empty string from final null byte
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }

  // Options must come in pairs
  if (parts.length % 2 !== 0) {
    throw new ProtocolError('Malformed option list: odd number of null-terminated parts');
  }

  const opts: RawOptions = {};
  for (let i = 0; i < parts.length; i += 2) {
    const key = parts[i]!.toLowerCase() as OptionName;
    const val = parts[i + 1]!;
    if (OPTION_NAMES.has(key)) {
      opts[key] = val;
    }
    // Unknown options are silently ignored per RFC2347
  }

  return opts;
}

/**
 * Compute the byte length of null-terminated option pairs.
 */
function optionPairsLength(opts: RawOptions): number {
  let len = 0;
  for (const [key, val] of Object.entries(opts)) {
    len += key.length + 1;  // key + null
    len += val.length + 1;  // value + null
  }
  return len;
}

/**
 * Write option pairs into a buffer at the given offset.
 * Returns the new offset.
 */
function writeOptionPairs(buf: Buffer, offset: number, opts: RawOptions): number {
  for (const [key, val] of Object.entries(opts)) {
    offset = writeNullString(buf, offset, key);
    offset = writeNullString(buf, offset, val);
  }
  return offset;
}

// ─── Encode functions ───────────────────────────────────────────────

/**
 * Encode an RRQ (Read Request) packet.
 *
 * Format: | 01 (2) | filename\0 | mode\0 | [options] |
 */
export function encodeRRQ(filename: string, mode: string, opts: RawOptions = {}): Buffer {
  const payloadLen = filename.length + 1 + mode.length + 1 + optionPairsLength(opts);
  const buf = Buffer.alloc(OPCODE_LEN + payloadLen);

  let offset = 0;
  buf.writeUInt16BE(Opcode.RRQ, offset);
  offset += OPCODE_LEN;
  offset = writeNullString(buf, offset, filename);
  offset = writeNullString(buf, offset, mode);
  offset = writeOptionPairs(buf, offset, opts);

  return buf.subarray(0, offset) as Buffer;
}

/**
 * Encode a WRQ (Write Request) packet.
 *
 * Format: | 02 (2) | filename\0 | mode\0 | [options] |
 */
export function encodeWRQ(filename: string, mode: string, opts: RawOptions = {}): Buffer {
  const payloadLen = filename.length + 1 + mode.length + 1 + optionPairsLength(opts);
  const buf = Buffer.alloc(OPCODE_LEN + payloadLen);

  let offset = 0;
  buf.writeUInt16BE(Opcode.WRQ, offset);
  offset += OPCODE_LEN;
  offset = writeNullString(buf, offset, filename);
  offset = writeNullString(buf, offset, mode);
  offset = writeOptionPairs(buf, offset, opts);

  return buf.subarray(0, offset) as Buffer;
}

/**
 * Encode a DATA packet.
 *
 * Format: | 03 (2) | block# (2) | data (0..blksize) |
 */
export function encodeDATA(blockNum: number, data: Buffer): Buffer {
  const buf = Buffer.alloc(DATA_HEADER_LEN + data.length);
  let offset = 0;
  buf.writeUInt16BE(Opcode.DATA, offset);
  offset += OPCODE_LEN;
  buf.writeUInt16BE(blockNum, offset);
  offset += BLOCKNUM_LEN;
  data.copy(buf, offset);
  return buf;
}

/**
 * Encode an ACK packet.
 *
 * Format: | 04 (2) | block# (2) |
 */
export function encodeACK(blockNum: number): Buffer {
  const buf = Buffer.alloc(OPCODE_LEN + BLOCKNUM_LEN);
  buf.writeUInt16BE(Opcode.ACK, 0);
  buf.writeUInt16BE(blockNum, OPCODE_LEN);
  return buf;
}

/**
 * Encode an ERROR packet.
 *
 * Format: | 05 (2) | error# (2) | errmsg\0 |
 * If no custom message is provided, the standard message for the error code is used.
 */
export function encodeERROR(errorCode: ErrorCode, message?: string): Buffer {
  const msg = message ?? ERROR_MESSAGES[errorCode];
  const msgLen = Buffer.byteLength(msg, 'ascii');
  const buf = Buffer.alloc(OPCODE_LEN + BLOCKNUM_LEN + msgLen + 1);

  let offset = 0;
  buf.writeUInt16BE(Opcode.ERROR, offset);
  offset += OPCODE_LEN;
  buf.writeUInt16BE(errorCode, offset);
  offset += BLOCKNUM_LEN;
  offset = writeNullString(buf, offset, msg);

  return buf.subarray(0, offset) as Buffer;
}

/**
 * Encode an OACK (Option Acknowledgment) packet.
 *
 * Format: | 06 (2) | option\0 value\0 ... |
 */
export function encodeOACK(opts: RawOptions): Buffer {
  const payloadLen = optionPairsLength(opts);
  const buf = Buffer.alloc(OPCODE_LEN + payloadLen);

  let offset = 0;
  buf.writeUInt16BE(Opcode.OACK, offset);
  offset += OPCODE_LEN;
  offset = writeOptionPairs(buf, offset, opts);

  return buf.subarray(0, offset) as Buffer;
}

// ─── Parse functions ────────────────────────────────────────────────

/**
 * Parse a full TFTP packet (including opcode) into a typed packet object.
 * Throws ProtocolError for malformed packets.
 * Returns undefined for unknown opcodes.
 */
export function parsePacket(buf: Buffer): TFTPPacket | undefined {
  const opcode = getOpcode(buf);
  if (opcode === undefined) {
    throw new ProtocolError('Packet too short to contain opcode');
  }

  // Strip the opcode for internal parsers
  const payload = buf.subarray(OPCODE_LEN);

  switch (opcode) {
    case Opcode.RRQ:   return parseRRQPayload(payload);
    case Opcode.WRQ:   return parseWRQPayload(payload);
    case Opcode.DATA:  return parseDATAPayload(payload);
    case Opcode.ACK:   return parseACKPayload(payload);
    case Opcode.ERROR: return parseERRORPayload(payload);
    case Opcode.OACK:  return parseOACKPayload(payload);
    default:
      return undefined;
  }
}

/**
 * Parse an RRQ payload (after the opcode has been stripped).
 */
export function parseRRQPayload(payload: Buffer): RRQPacket {
  const parts = splitNullStrings(payload);

  // Remove trailing empty from final null
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }

  if (parts.length < 2) {
    throw new ProtocolError('RRQ packet too short: missing filename or mode');
  }

  const filename = parts[0]!;
  if (!filename) {
    throw new ProtocolError('Empty filename in RRQ');
  }

  const mode = parts[1]!.toLowerCase();
  if (!TRANSFER_MODES.has(mode as typeof TRANSFER_MODES extends Set<infer T> ? T : never)) {
    throw new ProtocolError(`Unknown transfer mode: ${mode}`);
  }

  // Remaining parts are option pairs (must be even count)
  const optionParts = parts.slice(2);
  if (optionParts.length % 2 !== 0) {
    throw new ProtocolError('Malformed RRQ options: odd number of parts');
  }

  const options: RawOptions = {};
  for (let i = 0; i < optionParts.length; i += 2) {
    const key = optionParts[i]!.toLowerCase() as OptionName;
    const val = optionParts[i + 1]!;
    if (OPTION_NAMES.has(key)) {
      options[key] = val;
    }
  }

  return {
    opcode: Opcode.RRQ,
    filename,
    mode: mode as 'netascii' | 'octet',
    options,
  };
}

/**
 * Parse a WRQ payload (after the opcode has been stripped).
 */
export function parseWRQPayload(payload: Buffer): WRQPacket {
  // WRQ has identical format to RRQ
  const parts = splitNullStrings(payload);

  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }

  if (parts.length < 2) {
    throw new ProtocolError('WRQ packet too short: missing filename or mode');
  }

  const filename = parts[0]!;
  if (!filename) {
    throw new ProtocolError('Empty filename in WRQ');
  }

  const mode = parts[1]!.toLowerCase();
  if (!TRANSFER_MODES.has(mode as typeof TRANSFER_MODES extends Set<infer T> ? T : never)) {
    throw new ProtocolError(`Unknown transfer mode: ${mode}`);
  }

  const optionParts = parts.slice(2);
  if (optionParts.length % 2 !== 0) {
    throw new ProtocolError('Malformed WRQ options: odd number of parts');
  }

  const options: RawOptions = {};
  for (let i = 0; i < optionParts.length; i += 2) {
    const key = optionParts[i]!.toLowerCase() as OptionName;
    const val = optionParts[i + 1]!;
    if (OPTION_NAMES.has(key)) {
      options[key] = val;
    }
  }

  return {
    opcode: Opcode.WRQ,
    filename,
    mode: mode as 'netascii' | 'octet',
    options,
  };
}

/**
 * Parse a DATA payload (after the opcode has been stripped).
 *
 * Format: | block# (2) | data (0..blksize) |
 */
export function parseDATAPayload(payload: Buffer): DATAPacket {
  if (payload.length < BLOCKNUM_LEN) {
    throw new ProtocolError('DATA packet too short: missing block number');
  }

  const blockNum = payload.readUInt16BE(0);
  const data = Buffer.from(payload.subarray(BLOCKNUM_LEN));

  return {
    opcode: Opcode.DATA,
    blockNum,
    data,
  };
}

/**
 * Parse an ACK payload (after the opcode has been stripped).
 *
 * Format: | block# (2) |
 */
export function parseACKPayload(payload: Buffer): ACKPacket {
  if (payload.length < BLOCKNUM_LEN) {
    throw new ProtocolError('ACK packet too short: missing block number');
  }

  const blockNum = payload.readUInt16BE(0);

  return {
    opcode: Opcode.ACK,
    blockNum,
  };
}

/**
 * Parse an ERROR payload (after the opcode has been stripped).
 *
 * Format: | error# (2) | errmsg\0 |
 */
export function parseERRORPayload(payload: Buffer): ERRORPacket {
  if (payload.length < BLOCKNUM_LEN) {
    throw new ProtocolError('ERROR packet too short: missing error code');
  }

  const errorCode = payload.readUInt16BE(0) as ErrorCode;

  // Error message is everything after the error code, up to the first null byte
  const msgBuf = payload.subarray(BLOCKNUM_LEN);
  const nullIdx = msgBuf.indexOf(0);
  const message = (nullIdx >= 0 ? msgBuf.subarray(0, nullIdx) : msgBuf).toString('ascii');

  return {
    opcode: Opcode.ERROR,
    errorCode,
    message,
  };
}

/**
 * Parse an OACK payload (after the opcode has been stripped).
 *
 * Format: | option\0 value\0 ... |
 */
export function parseOACKPayload(payload: Buffer): OACKPacket {
  if (payload.length === 0) {
    throw new ProtocolError('OACK packet has no options');
  }

  const options = parseOptionPairs(payload, 0, payload.length);

  return {
    opcode: Opcode.OACK,
    options,
  };
}

// ─── Option validation ──────────────────────────────────────────────

/**
 * Validate and parse TFTP option values.
 *
 * Returns validated options with numeric values, or throws ProtocolError
 * if any option value is out of range.
 *
 * This replaces pTFTPd's `parse_options()` which returned `None` on error.
 * We throw instead — caller can catch and send ERROR(option negotiation).
 */
export function validateOptions(raw: RawOptions, defaults?: Partial<ValidatedOptions>): ValidatedOptions {
  const result: ValidatedOptions = {
    blksize: defaults?.blksize ?? DEFAULT_BLOCK_SIZE,
    windowsize: defaults?.windowsize ?? DEFAULT_WINDOW_SIZE,
  };

  // blksize (RFC2348)
  if ('blksize' in raw) {
    const val = parseInt(raw.blksize!, 10);
    if (isNaN(val) || val < OPTION_LIMITS.blksize.min || val > OPTION_LIMITS.blksize.max) {
      throw new ProtocolError(
        `Invalid blksize: ${raw.blksize} (must be ${OPTION_LIMITS.blksize.min}-${OPTION_LIMITS.blksize.max})`,
      );
    }
    result.blksize = val;
  }

  // timeout (RFC2349) — only present when requested
  if ('timeout' in raw) {
    const val = parseInt(raw.timeout!, 10);
    if (isNaN(val) || val < OPTION_LIMITS.timeout.min || val > OPTION_LIMITS.timeout.max) {
      throw new ProtocolError(
        `Invalid timeout: ${raw.timeout} (must be ${OPTION_LIMITS.timeout.min}-${OPTION_LIMITS.timeout.max})`,
      );
    }
    result.timeout = val;
  }

  // tsize (RFC2349) — only present when requested, 0 means "tell me the size"
  if ('tsize' in raw) {
    const val = parseInt(raw.tsize!, 10);
    if (isNaN(val) || val < 0) {
      throw new ProtocolError(`Invalid tsize: ${raw.tsize} (must be >= 0)`);
    }
    result.tsize = val;
  }

  // windowsize (RFC7440)
  if ('windowsize' in raw) {
    const val = parseInt(raw.windowsize!, 10);
    if (isNaN(val) || val < OPTION_LIMITS.windowsize.min || val > OPTION_LIMITS.windowsize.max) {
      throw new ProtocolError(
        `Invalid windowsize: ${raw.windowsize} (must be ${OPTION_LIMITS.windowsize.min}-${OPTION_LIMITS.windowsize.max})`,
      );
    }
    result.windowsize = val;
  }

  return result;
}

// ─── Utility ────────────────────────────────────────────────────────

/**
 * Compute the expected size of a DATA packet (header + data) for a given blksize.
 * Useful for slicing received UDP datagrams when window size > 1.
 */
export function getDataPacketSize(blksize: number): number {
  return DATA_HEADER_LEN + blksize;
}

/**
 * Convert validated options to a RawOptions map for encoding.
 * Only includes options that should be sent in OACK/RRQ/WRQ.
 */
export function validatedToRaw(opts: ValidatedOptions): RawOptions {
  const raw: RawOptions = {};

  // Always include blksize if non-default
  if (opts.blksize !== DEFAULT_BLOCK_SIZE) {
    raw.blksize = String(opts.blksize);
  }

  if (opts.timeout !== undefined) {
    raw.timeout = String(opts.timeout);
  }

  if (opts.tsize !== undefined) {
    raw.tsize = String(opts.tsize);
  }

  if (opts.windowsize !== DEFAULT_WINDOW_SIZE) {
    raw.windowsize = String(opts.windowsize);
  }

  return raw;
}
