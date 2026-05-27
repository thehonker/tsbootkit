import { describe, it, expect } from 'vitest';
import {
  TFTPTransfer,
  TransferState,
  DEFAULT_TIMEOUT_SECS,
} from '../../src/tftp/state.mjs';
import { Opcode, ErrorCode, DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_SIZE, BLOCKNUM_MAX } from '../../src/tftp/types.mjs';
import { getOpcode } from '../../src/tftp/protocol.mjs';

// ── Helpers ────────────────────────────────────────────────────────

const TEST_PEER = { address: '127.0.0.1' as const, port: 12345 };
const TEST_ROOT = '/tftpboot';

function createRRQTransfer(opts?: Partial<import('../../src/tftp/types.mjs').ValidatedOptions>): TFTPTransfer {
  return new TFTPTransfer(TEST_PEER, Opcode.RRQ, TEST_ROOT, 'test.txt', 'octet', opts);
}

function createWRQTransfer(opts?: Partial<import('../../src/tftp/types.mjs').ValidatedOptions>): TFTPTransfer {
  return new TFTPTransfer(TEST_PEER, Opcode.WRQ, TEST_ROOT, 'upload.bin', 'octet', opts);
}

// ── Construction ───────────────────────────────────────────────────

describe('TFTPTransfer construction', () => {
  it('creates an RRQ transfer with defaults', () => {
    const t = createRRQTransfer();
    expect(t.opcode).toBe(Opcode.RRQ);
    expect(t.filename).toBe('test.txt');
    expect(t.mode).toBe('octet');
    expect(t.opts.blksize).toBe(DEFAULT_BLOCK_SIZE);
    expect(t.opts.windowsize).toBe(DEFAULT_WINDOW_SIZE);
    expect(t.state).toBe(TransferState.Done); // Not initialized yet
  });

  it('resolves filepath against root', () => {
    const t = createRRQTransfer();
    expect(t.filepath).toContain('test.txt');
  });

  it('creates a WRQ transfer', () => {
    const t = createWRQTransfer();
    expect(t.opcode).toBe(Opcode.WRQ);
    expect(t.filename).toBe('upload.bin');
  });

  it('applies custom options', () => {
    const t = createRRQTransfer({ blksize: 1400, windowsize: 8, timeout: 5 });
    expect(t.opts.blksize).toBe(1400);
    expect(t.opts.windowsize).toBe(8);
    expect(t.opts.timeout).toBe(5);
  });
});

// ── Path traversal protection ──────────────────────────────────────

describe('isPathInRoot', () => {
  it('accepts paths within root', () => {
    const t = new TFTPTransfer(TEST_PEER, Opcode.RRQ, '/tftpboot', 'subdir/file.txt', 'octet');
    expect(t.isPathInRoot()).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    const t = new TFTPTransfer(TEST_PEER, Opcode.RRQ, '/tftpboot', '../../../etc/passwd', 'octet');
    expect(t.isPathInRoot()).toBe(false);
  });

  it('rejects absolute paths outside root', () => {
    const t = new TFTPTransfer(TEST_PEER, Opcode.RRQ, '/tftpboot', '/etc/passwd', 'octet');
    // /etc/passwd resolves to /etc/passwd, which doesn't start with /tftpboot
    expect(t.isPathInRoot()).toBe(false);
  });
});

// ── RRQ initialization ─────────────────────────────────────────────

describe('RRQ initialization', () => {
  it('initRRQ without options starts in Send state', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);
    expect(t.state).toBe(TransferState.Send);
    expect(t.blockNum).toBe(0);
  });

  it('initRRQ with options starts in SendOACK state', () => {
    const t = createRRQTransfer({ blksize: 1400 });
    t.initRRQ(true);
    expect(t.state).toBe(TransferState.SendOACK);
  });
});

// ── WRQ initialization ─────────────────────────────────────────────

describe('WRQ initialization', () => {
  it('initWRQ without options starts in RecvACK state', () => {
    const t = createWRQTransfer();
    t.initWRQ(false);
    expect(t.state).toBe(TransferState.RecvACK);
    expect(t.blockNum).toBe(1); // WRQ DATA packets start at 1
  });

  it('initWRQ with options starts in SendOACK state', () => {
    const t = createWRQTransfer({ blksize: 1400 });
    t.initWRQ(true);
    expect(t.state).toBe(TransferState.SendOACK);
  });
});

// ── OACK production ────────────────────────────────────────────────

describe('OACK production', () => {
  it('RRQ with options produces OACK then DATA packets', () => {
    const t = createRRQTransfer({ blksize: 1400, windowsize: 8 });
    t.initRRQ(true);

    const result = t.advanceSend();
    expect(result).not.toBeNull();
    expect(result!.packets.length).toBeGreaterThanOrEqual(1);

    // First packet should be OACK
    const opcode = getOpcode(result!.packets[0]!);
    expect(opcode).toBe(Opcode.OACK);

    // After OACK, state should be Send (for RRQ)
    expect(t.state).toBe(TransferState.Send);
  });

  it('WRQ with options produces OACK and transitions to Recv', () => {
    const t = createWRQTransfer({ blksize: 1400 });
    t.initWRQ(true);

    const result = t.advanceSend();
    expect(result).not.toBeNull();
    expect(result!.packets.length).toBe(1);

    const opcode = getOpcode(result!.packets[0]!);
    expect(opcode).toBe(Opcode.OACK);

    expect(t.state).toBe(TransferState.Recv);
  });
});

// ── ACK(0) for WRQ ────────────────────────────────────────────────

describe('WRQ ACK(0) production', () => {
  it('WRQ without options produces ACK(0)', () => {
    const t = createWRQTransfer();
    t.initWRQ(false);

    const result = t.advanceSend();
    expect(result).not.toBeNull();
    expect(result!.packets.length).toBe(1);

    const opcode = getOpcode(result!.packets[0]!);
    expect(opcode).toBe(Opcode.ACK);

    // Parse the block number from ACK packet
    const blockNum = result!.packets[0]!.readUInt16BE(2);
    expect(blockNum).toBe(0);

    expect(t.state).toBe(TransferState.Recv);
  });
});

// ── DATA packet production ─────────────────────────────────────────

describe('DATA packet production', () => {
  it('produces a DATA packet with correct block number', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);

    const data = Buffer.alloc(512, 0xab);
    const packet = t.produceDataPacket(data, false);

    expect(packet).not.toBeNull();
    const opcode = getOpcode(packet!);
    expect(opcode).toBe(Opcode.DATA);

    const blockNum = packet!.readUInt16BE(2);
    expect(blockNum).toBe(1); // First DATA block is 1
  });

  it('increments block number on each call', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);

    const data = Buffer.alloc(512, 0xab);
    const p1 = t.produceDataPacket(data, false);
    const p2 = t.produceDataPacket(data, false);

    expect(p1!.readUInt16BE(2)).toBe(1);
    expect(p2!.readUInt16BE(2)).toBe(2);
  });

  it('transitions to SendLast when data < blksize', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);

    const shortData = Buffer.alloc(100, 0xcd);
    t.produceDataPacket(shortData, true);

    expect(t.state).toBe(TransferState.SendLast);
  });

  it('handles data larger than blksize (overflow to sendBuffer)', () => {
    const t = createRRQTransfer({ blksize: 512 });
    t.initRRQ(false);

    const bigData = Buffer.alloc(700, 0xef);
    const packet = t.produceDataPacket(bigData, false);

    // Should produce a 512-byte DATA packet
    const dataLen = packet!.length - 4; // minus opcode + blocknum
    expect(dataLen).toBe(512);

    // Overflow should be in sendBuffer
    expect(t.sendBuffer.length).toBe(700 - 512);
  });
});

// ── ACK handling (RRQ side) ────────────────────────────────────────

describe('ACK handling', () => {
  it('final ACK completes a SendLast transfer', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);
    t.state = TransferState.SendLast;
    t.blockNum = 5;

    const result = t.handleACK(5);
    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
    expect(t.state).toBe(TransferState.Done);
  });

  it('duplicate ACK is ignored', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);
    t.blockNum = 3;
    t.state = TransferState.Send;

    const result = t.handleACK(2); // Previous block
    expect(result).toBeNull();
  });

  it('mismatched ACK triggers error', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);
    t.blockNum = 5;
    t.state = TransferState.Send;

    const result = t.handleACK(99);
    expect(result).not.toBeNull();
    expect(t.state).toBe(TransferState.Done);
  });
});

// ── DATA handling (WRQ side) ───────────────────────────────────────

describe('DATA handling', () => {
  it('receives DATA and ACKs at window boundary', () => {
    const t = createWRQTransfer();
    t.initWRQ(false);

    // Advance past RecvACK to Recv state
    t.advanceSend();
    expect(t.state).toBe(TransferState.Recv);

    const data = Buffer.alloc(DEFAULT_BLOCK_SIZE, 0xaa);
    const result = t.handleDATA(1, data);

    // With window size 1, should ACK immediately
    expect(result).not.toBeNull();
    expect(result!.packets.length).toBe(1);

    const opcode = getOpcode(result!.packets[0]!);
    expect(opcode).toBe(Opcode.ACK);
    expect(result!.packets[0]!.readUInt16BE(2)).toBe(1);
  });

  it('does not ACK within window', () => {
    const t = createWRQTransfer({ blksize: 512, windowsize: 4 });
    t.initWRQ(false);
    t.advanceSend(); // Move to Recv

    const data = Buffer.alloc(512, 0xaa);

    // Block 1 — within window, no ACK yet
    const r1 = t.handleDATA(1, data);
    expect(r1).toBeNull(); // Window not full yet

    // Block 2
    const r2 = t.handleDATA(2, data);
    expect(r2).toBeNull();

    // Block 3
    const r3 = t.handleDATA(3, data);
    expect(r3).toBeNull();

    // Block 4 — window boundary, ACK
    const r4 = t.handleDATA(4, data);
    expect(r4).not.toBeNull();
    expect(r4!.packets[0]!.readUInt16BE(2)).toBe(4);
  });

  it('completes on short DATA (last packet)', () => {
    const t = createWRQTransfer();
    t.initWRQ(false);
    t.advanceSend(); // Move to Recv

    const shortData = Buffer.alloc(100, 0xbb);
    const result = t.handleDATA(1, shortData);

    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
    expect(t.state).toBe(TransferState.Done);
  });

  it('rejects DATA exceeding blksize', () => {
    const t = createWRQTransfer({ blksize: 512 });
    t.initWRQ(false);
    t.advanceSend(); // Move to Recv

    const bigData = Buffer.alloc(600, 0xcc);
    const result = t.handleDATA(1, bigData);

    // Should produce an error
    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
  });

  it('handles duplicate DATA with re-ACK', () => {
    const t = createWRQTransfer();
    t.initWRQ(false);
    t.advanceSend(); // Move to Recv

    const data = Buffer.alloc(DEFAULT_BLOCK_SIZE, 0xaa);

    // First DATA at block 1
    t.handleDATA(1, data);
    // blockNum is now 2

    // Duplicate DATA at block 1
    const result = t.handleDATA(1, data);
    expect(result).not.toBeNull();
    expect(result!.packets[0]!.readUInt16BE(2)).toBe(1); // Re-ACK block 1
  });
});

// ── Error handling ─────────────────────────────────────────────────

describe('Error handling', () => {
  it('setError transitions to Error state', () => {
    const t = createRRQTransfer();
    t.setError(ErrorCode.FileNotFound);

    expect(t.state).toBe(TransferState.Error);
    expect(t.errorCode).toBe(ErrorCode.FileNotFound);
  });

  it('advanceError produces ERROR packet and transitions to Done', () => {
    const t = createRRQTransfer();
    t.setError(ErrorCode.AccessViolation);

    const result = t.advanceSend();
    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);

    const opcode = getOpcode(result!.packets[0]!);
    expect(opcode).toBe(Opcode.ERROR);
    expect(t.state).toBe(TransferState.Done);
  });

  it('handleError from peer transitions to Done', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);

    const result = t.handleError(ErrorCode.FileNotFound, 'nope');
    expect(result.done).toBe(true);
    expect(t.state).toBe(TransferState.Done);
  });
});

// ── Timeout / retransmit ───────────────────────────────────────────

describe('Timeout and retransmit', () => {
  it('uses default timeout when no timeout option set', () => {
    const t = createRRQTransfer();
    expect(t.getTimeoutMs()).toBe(DEFAULT_TIMEOUT_SECS * 1000);
  });

  it('uses negotiated timeout option', () => {
    const t = createRRQTransfer({ timeout: 5 });
    expect(t.getTimeoutMs()).toBe(5000);
  });

  it('incrementRetry tracks retries', () => {
    const t = createRRQTransfer();
    t.maxRetries = 3;

    expect(t.incrementRetry()).toBe(true);  // retry 1
    expect(t.incrementRetry()).toBe(true);  // retry 2
    expect(t.incrementRetry()).toBe(true);  // retry 3
    expect(t.incrementRetry()).toBe(false); // exceeded
  });

  it('touch updates lastSeen', () => {
    const t = createRRQTransfer();
    const before = t.lastSeen;
    // Small delay
    t.touch();
    expect(t.lastSeen).toBeGreaterThanOrEqual(before);
  });

  it('retries reset on successful ACK', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);
    t.retries = 3;
    t.state = TransferState.SendLast;
    t.blockNum = 1;

    t.handleACK(1);
    expect(t.retries).toBe(0);
  });
});

// ── Block number wraparound ────────────────────────────────────────

describe('Block number wraparound', () => {
  it('wraps block number when reaching max', () => {
    const t = createRRQTransfer();
    t.initRRQ(false);
    t.blockNum = BLOCKNUM_MAX - 1;
    t.wrapBlockNum = true;

    const data = Buffer.alloc(100, 0xaa);
    t.produceDataPacket(data, false);

    expect(t.blockNum).toBe(1); // BLOCKNUM_RESET
  });

  it('does not wrap when wrapBlockNum is false (RFC1350 mode)', () => {
    const t = new TFTPTransfer(TEST_PEER, Opcode.RRQ, TEST_ROOT, 'test.txt', 'octet', undefined, false);
    t.initRRQ(false);
    t.blockNum = 65534; // One before max uint16

    const data = Buffer.alloc(100, 0xaa);
    // Block 65535 is still valid
    t.produceDataPacket(data, false);
    expect(t.blockNum).toBe(65535);

    // Next increment would be 65536, which doesn't fit in uint16
    // Without wrapping, the transfer must end before this point
    // (RFC1350 limits transfers to 65535 blocks of 512 bytes = ~32MB)
  });
});

// ── Option negotiation ─────────────────────────────────────────────

describe('Option negotiation', () => {
  it('setOptions replaces tsize=0 with actual filesize', () => {
    const t = createRRQTransfer();
    t.filesize = 12345;

    t.setOptions({
      blksize: 1400,
      windowsize: 8,
      tsize: 0, // Client asking for size
    });

    expect(t.opts.tsize).toBe(12345);
  });

  it('setOptions preserves non-zero tsize', () => {
    const t = createRRQTransfer();
    t.filesize = 12345;

    t.setOptions({
      blksize: 1400,
      windowsize: 8,
      tsize: 99999,
    });

    expect(t.opts.tsize).toBe(99999);
  });
});
