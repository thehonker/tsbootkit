import { describe, it, expect } from 'vitest';
import {
  ProtocolError,
  getOpcode,
  encodeRRQ,
  encodeWRQ,
  encodeDATA,
  encodeACK,
  encodeERROR,
  encodeOACK,
  parsePacket,
  validateOptions,
  getDataPacketSize,
  validatedToRaw,
} from '../../src/tftp/protocol.mjs';
import {
  Opcode,
  ErrorCode,
  ERROR_MESSAGES,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_WINDOW_SIZE,
  DATA_HEADER_LEN,
} from '../../src/tftp/types.mjs';

// ─── Opcode extraction ──────────────────────────────────────────────

describe('getOpcode', () => {
  it('extracts a valid opcode', () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(Opcode.RRQ, 0);
    expect(getOpcode(buf)).toBe(Opcode.RRQ);
  });

  it('returns undefined for a too-short buffer', () => {
    expect(getOpcode(Buffer.alloc(1))).toBeUndefined();
    expect(getOpcode(Buffer.alloc(0))).toBeUndefined();
  });
});

// ─── RRQ round-trip ────────────────────────────────────────────────

describe('RRQ', () => {
  it('encodes and parses a minimal RRQ (no options)', () => {
    const encoded = encodeRRQ('test.txt', 'octet');
    const parsed = parsePacket(encoded);

    expect(parsed).toBeDefined();
    expect(parsed!.opcode).toBe(Opcode.RRQ);

    const rrq = parsed as import('../../src/tftp/types.mjs').RRQPacket;
    expect(rrq.filename).toBe('test.txt');
    expect(rrq.mode).toBe('octet');
    expect(rrq.options).toEqual({});
  });

  it('encodes and parses RRQ with netascii mode', () => {
    const encoded = encodeRRQ('boot.img', 'netascii');
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').RRQPacket;

    expect(parsed.filename).toBe('boot.img');
    expect(parsed.mode).toBe('netascii');
  });

  it('encodes and parses RRQ with options', () => {
    const opts = { blksize: '1400', windowsize: '8' };
    const encoded = encodeRRQ('pxelinux.0', 'octet', opts);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').RRQPacket;

    expect(parsed.filename).toBe('pxelinux.0');
    expect(parsed.mode).toBe('octet');
    expect(parsed.options.blksize).toBe('1400');
    expect(parsed.options.windowsize).toBe('8');
  });

  it('encodes and parses RRQ with all options', () => {
    const opts = { blksize: '1024', timeout: '5', tsize: '0', windowsize: '16' };
    const encoded = encodeRRQ('vmlinuz', 'octet', opts);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').RRQPacket;

    expect(parsed.options.blksize).toBe('1024');
    expect(parsed.options.timeout).toBe('5');
    expect(parsed.options.tsize).toBe('0');
    expect(parsed.options.windowsize).toBe('16');
  });

  it('rejects empty filename', () => {
    const encoded = encodeRRQ('', 'octet');
    // Manually craft: opcode + \0 + octet\0
    // encodeRRQ will produce it, but parse should reject
    expect(() => parsePacket(encoded)).toThrow(ProtocolError);
  });

  it('ignores unknown options', () => {
    const opts = { blksize: '512', foobar: 'baz' } as Record<string, string>;
    const encoded = encodeRRQ('file', 'octet', opts);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').RRQPacket;

    expect(parsed.options.blksize).toBe('512');
    expect(parsed.options.foobar).toBeUndefined();
  });
});

// ─── WRQ round-trip ────────────────────────────────────────────────

describe('WRQ', () => {
  it('encodes and parses a minimal WRQ', () => {
    const encoded = encodeWRQ('upload.bin', 'octet');
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').WRQPacket;

    expect(parsed.opcode).toBe(Opcode.WRQ);
    expect(parsed.filename).toBe('upload.bin');
    expect(parsed.mode).toBe('octet');
  });

  it('encodes and parses WRQ with options', () => {
    const opts = { blksize: '2048', tsize: '12345' };
    const encoded = encodeWRQ('data.bin', 'octet', opts);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').WRQPacket;

    expect(parsed.options.blksize).toBe('2048');
    expect(parsed.options.tsize).toBe('12345');
  });
});

// ─── DATA round-trip ───────────────────────────────────────────────

describe('DATA', () => {
  it('encodes and parses a DATA packet', () => {
    const data = Buffer.from('hello world');
    const encoded = encodeDATA(1, data);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').DATAPacket;

    expect(parsed.opcode).toBe(Opcode.DATA);
    expect(parsed.blockNum).toBe(1);
    expect(parsed.data.toString()).toBe('hello world');
  });

  it('encodes and parses a DATA packet with block number 0', () => {
    const data = Buffer.from('initial');
    const encoded = encodeDATA(0, data);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').DATAPacket;

    expect(parsed.blockNum).toBe(0);
    expect(parsed.data.toString()).toBe('initial');
  });

  it('handles empty data', () => {
    const data = Buffer.alloc(0);
    const encoded = encodeDATA(42, data);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').DATAPacket;

    expect(parsed.blockNum).toBe(42);
    expect(parsed.data.length).toBe(0);
  });

  it('handles binary data with null bytes', () => {
    const data = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const encoded = encodeDATA(99, data);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').DATAPacket;

    expect(parsed.data).toEqual(data);
  });

  it('handles max block size data (512 bytes)', () => {
    const data = Buffer.alloc(DEFAULT_BLOCK_SIZE, 0xab);
    const encoded = encodeDATA(1, data);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').DATAPacket;

    expect(parsed.data.length).toBe(DEFAULT_BLOCK_SIZE);
    expect(parsed.data[0]).toBe(0xab);
  });
});

// ─── ACK round-trip ────────────────────────────────────────────────

describe('ACK', () => {
  it('encodes and parses ACK with block 0', () => {
    const encoded = encodeACK(0);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').ACKPacket;

    expect(parsed.opcode).toBe(Opcode.ACK);
    expect(parsed.blockNum).toBe(0);
  });

  it('encodes and parses ACK with a large block number', () => {
    const encoded = encodeACK(65535);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').ACKPacket;

    expect(parsed.blockNum).toBe(65535);
  });

  it('is exactly 4 bytes', () => {
    const encoded = encodeACK(1);
    expect(encoded.length).toBe(4);
  });
});

// ─── ERROR round-trip ──────────────────────────────────────────────

describe('ERROR', () => {
  it('encodes and parses a standard error', () => {
    const encoded = encodeERROR(ErrorCode.FileNotFound);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').ERRORPacket;

    expect(parsed.opcode).toBe(Opcode.ERROR);
    expect(parsed.errorCode).toBe(ErrorCode.FileNotFound);
    expect(parsed.message).toBe(ERROR_MESSAGES[ErrorCode.FileNotFound]);
  });

  it('encodes and parses a custom error message', () => {
    const encoded = encodeERROR(ErrorCode.NotDefined, 'Something went wrong');
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').ERRORPacket;

    expect(parsed.errorCode).toBe(ErrorCode.NotDefined);
    expect(parsed.message).toBe('Something went wrong');
  });

  it('handles all standard error codes', () => {
    for (const code of [
      ErrorCode.NotDefined,
      ErrorCode.FileNotFound,
      ErrorCode.AccessViolation,
      ErrorCode.DiskFull,
      ErrorCode.IllegalOperation,
      ErrorCode.UnknownTransferID,
      ErrorCode.FileAlreadyExists,
      ErrorCode.NoSuchUser,
      ErrorCode.OptionNegotiation,
    ]) {
      const encoded = encodeERROR(code);
      const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').ERRORPacket;
      expect(parsed.errorCode).toBe(code);
      expect(parsed.message).toBe(ERROR_MESSAGES[code]);
    }
  });
});

// ─── OACK round-trip ───────────────────────────────────────────────

describe('OACK', () => {
  it('encodes and parses OACK with options', () => {
    const opts = { blksize: '1400', windowsize: '8' };
    const encoded = encodeOACK(opts);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').OACKPacket;

    expect(parsed.opcode).toBe(Opcode.OACK);
    expect(parsed.options.blksize).toBe('1400');
    expect(parsed.options.windowsize).toBe('8');
  });

  it('encodes and parses OACK with all options', () => {
    const opts = { blksize: '1024', timeout: '10', tsize: '5000', windowsize: '4' };
    const encoded = encodeOACK(opts);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').OACKPacket;

    expect(parsed.options.blksize).toBe('1024');
    expect(parsed.options.timeout).toBe('10');
    expect(parsed.options.tsize).toBe('5000');
    expect(parsed.options.windowsize).toBe('4');
  });

  it('rejects empty OACK', () => {
    const encoded = encodeOACK({});
    expect(() => parsePacket(encoded)).toThrow(ProtocolError);
  });
});

// ─── Parse error handling ──────────────────────────────────────────

describe('parsePacket error handling', () => {
  it('throws for too-short buffer', () => {
    expect(() => parsePacket(Buffer.alloc(1))).toThrow(ProtocolError);
  });

  it('returns undefined for unknown opcode', () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(99, 0);
    expect(parsePacket(buf)).toBeUndefined();
  });

  it('throws for DATA payload too short', () => {
    const buf = Buffer.alloc(2); // opcode only, no block number
    buf.writeUInt16BE(Opcode.DATA, 0);
    expect(() => parsePacket(buf)).toThrow(ProtocolError);
  });

  it('throws for ACK payload too short', () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(Opcode.ACK, 0);
    expect(() => parsePacket(buf)).toThrow(ProtocolError);
  });

  it('throws for ERROR payload too short', () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(Opcode.ERROR, 0);
    expect(() => parsePacket(buf)).toThrow(ProtocolError);
  });
});

// ─── Option validation ─────────────────────────────────────────────

describe('validateOptions', () => {
  it('returns defaults when no options provided', () => {
    const result = validateOptions({});
    expect(result.blksize).toBe(DEFAULT_BLOCK_SIZE);
    expect(result.windowsize).toBe(DEFAULT_WINDOW_SIZE);
    expect(result.timeout).toBeUndefined();
    expect(result.tsize).toBeUndefined();
  });

  it('validates blksize within range', () => {
    expect(validateOptions({ blksize: '8' }).blksize).toBe(8);
    expect(validateOptions({ blksize: '65464' }).blksize).toBe(65464);
    expect(validateOptions({ blksize: '512' }).blksize).toBe(512);
  });

  it('throws for blksize below minimum', () => {
    expect(() => validateOptions({ blksize: '7' })).toThrow(ProtocolError);
  });

  it('throws for blksize above maximum', () => {
    expect(() => validateOptions({ blksize: '65465' })).toThrow(ProtocolError);
  });

  it('throws for non-numeric blksize', () => {
    expect(() => validateOptions({ blksize: 'abc' })).toThrow(ProtocolError);
  });

  it('validates timeout within range', () => {
    expect(validateOptions({ timeout: '1' }).timeout).toBe(1);
    expect(validateOptions({ timeout: '255' }).timeout).toBe(255);
  });

  it('throws for timeout out of range', () => {
    expect(() => validateOptions({ timeout: '0' })).toThrow(ProtocolError);
    expect(() => validateOptions({ timeout: '256' })).toThrow(ProtocolError);
  });

  it('validates tsize', () => {
    expect(validateOptions({ tsize: '0' }).tsize).toBe(0);
    expect(validateOptions({ tsize: '999999' }).tsize).toBe(999999);
  });

  it('throws for negative tsize', () => {
    expect(() => validateOptions({ tsize: '-1' })).toThrow(ProtocolError);
  });

  it('validates windowsize within range', () => {
    expect(validateOptions({ windowsize: '1' }).windowsize).toBe(1);
    expect(validateOptions({ windowsize: '65535' }).windowsize).toBe(65535);
  });

  it('throws for windowsize out of range', () => {
    expect(() => validateOptions({ windowsize: '0' })).toThrow(ProtocolError);
    expect(() => validateOptions({ windowsize: '65536' })).toThrow(ProtocolError);
  });

  it('validates all options together', () => {
    const result = validateOptions({
      blksize: '1400',
      timeout: '5',
      tsize: '0',
      windowsize: '8',
    });

    expect(result.blksize).toBe(1400);
    expect(result.timeout).toBe(5);
    expect(result.tsize).toBe(0);
    expect(result.windowsize).toBe(8);
  });

  it('applies custom defaults', () => {
    const result = validateOptions({}, { blksize: 1024, windowsize: 4 });
    expect(result.blksize).toBe(1024);
    expect(result.windowsize).toBe(4);
  });
});

// ─── Utility functions ─────────────────────────────────────────────

describe('getDataPacketSize', () => {
  it('returns header + blksize', () => {
    expect(getDataPacketSize(512)).toBe(DATA_HEADER_LEN + 512);
    expect(getDataPacketSize(1400)).toBe(DATA_HEADER_LEN + 1400);
    expect(getDataPacketSize(8)).toBe(DATA_HEADER_LEN + 8);
  });
});

describe('validatedToRaw', () => {
  it('converts only non-default options', () => {
    const raw = validatedToRaw({ blksize: DEFAULT_BLOCK_SIZE, windowsize: DEFAULT_WINDOW_SIZE });
    expect(Object.keys(raw)).toHaveLength(0);
  });

  it('includes non-default values', () => {
    const raw = validatedToRaw({ blksize: 1400, windowsize: 8, timeout: 5 });
    expect(raw.blksize).toBe('1400');
    expect(raw.windowsize).toBe('8');
    expect(raw.timeout).toBe('5');
  });

  it('includes tsize when present', () => {
    const raw = validatedToRaw({ blksize: 512, windowsize: 1, tsize: 1024 });
    expect(raw.tsize).toBe('1024');
  });
});

// ─── Cross-protocol round-trips ────────────────────────────────────

describe('full round-trip: encode → parse → encode', () => {
  it('RRQ with options round-trips through validated options', () => {
    const rawOpts = { blksize: '1400', windowsize: '8' };
    const encoded = encodeRRQ('test.bin', 'octet', rawOpts);
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').RRQPacket;
    const validated = validateOptions(parsed.options);
    const backToRaw = validatedToRaw(validated);
    const reEncoded = encodeRRQ(parsed.filename, parsed.mode, backToRaw);
    const reParsed = parsePacket(reEncoded) as import('../../src/tftp/types.mjs').RRQPacket;

    expect(reParsed.filename).toBe('test.bin');
    expect(reParsed.mode).toBe('octet');
    expect(reParsed.options.blksize).toBe('1400');
    expect(reParsed.options.windowsize).toBe('8');
  });

  it('ERROR with custom message round-trips', () => {
    const encoded = encodeERROR(ErrorCode.NotDefined, 'custom error');
    const parsed = parsePacket(encoded) as import('../../src/tftp/types.mjs').ERRORPacket;

    expect(parsed.errorCode).toBe(ErrorCode.NotDefined);
    expect(parsed.message).toBe('custom error');

    // Re-encode
    const reEncoded = encodeERROR(parsed.errorCode, parsed.message);
    const reParsed = parsePacket(reEncoded) as import('../../src/tftp/types.mjs').ERRORPacket;
    expect(reParsed.message).toBe('custom error');
  });
});
