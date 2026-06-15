import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LogBufferTransport } from '../../src/shared/log-buffer.mjs';
import { createLogger, setLogBuffer, getLogBuffer, createLogBuffer, setBufferLogLevel, setAllLogLevels, TSBOOTKIT_LEVEL_NAMES } from '../../src/shared/logger.mjs';
import type { TsbootkitLevel } from '../../src/shared/logger.mjs';

// ─── LogBufferTransport ────────────────────────────────────────────

describe('LogBufferTransport', () => {
  let transport: LogBufferTransport;

  beforeEach(() => {
    transport = new LogBufferTransport({ maxSize: 5 });
  });

  it('starts empty', () => {
    expect(transport.size).toBe(0);
    expect(transport.capacity).toBe(5);
    expect(transport.getEntries()).toEqual([]);
  });

  it('captures log entries', () => {
    transport.log({ timestamp: '10:00:00', level: 'info', label: 'test', message: 'hello' }, () => {});

    expect(transport.size).toBe(1);
    const entries = transport.getEntries();
    expect(entries[0]).toEqual({
      timestamp: '10:00:00',
      level: 'info',
      label: 'test',
      message: 'hello',
    });
  });

  it('defaults missing fields', () => {
    transport.log({ level: 'error', message: 'fail' }, () => {});

    const entry = transport.getEntries()[0]!;
    expect(entry.timestamp).toBeTruthy();
    expect(entry.label).toBe('');
  });

  it('enforces ring buffer capacity', () => {
    for (let i = 0; i < 8; i++) {
      transport.log({ timestamp: `10:00:${i}`, level: 'info', label: 'test', message: `msg ${i}` }, () => {});
    }

    // Only the last 5 entries should remain
    expect(transport.size).toBe(5);
    const entries = transport.getEntries();
    expect(entries[0]!.message).toBe('msg 3');
    expect(entries[4]!.message).toBe('msg 7');
  });

  it('getEntries returns a snapshot (not a live reference)', () => {
    transport.log({ timestamp: '10:00:00', level: 'info', label: 'test', message: 'hello' }, () => {});

    const snapshot = transport.getEntries();
    transport.log({ timestamp: '10:00:01', level: 'info', label: 'test', message: 'world' }, () => {});

    expect(snapshot).toHaveLength(1);
    expect(transport.getEntries()).toHaveLength(2);
  });

  it('uses default maxSize of 500', () => {
    const defaultTransport = new LogBufferTransport();
    expect(defaultTransport.capacity).toBe(500);
  });
});

// ─── Logger integration ─────────────────────────────────────────────

describe('Logger + LogBuffer integration', () => {
  let buffer: LogBufferTransport;

  beforeEach(() => {
    buffer = createLogBuffer(50);
    setLogBuffer(buffer);
  });

  afterEach(() => {
    setLogBuffer(undefined as unknown as LogBufferTransport);
  });

  it('createLogBuffer creates a LogBufferTransport', () => {
    const localBuffer = createLogBuffer(100);
    expect(localBuffer).toBeInstanceOf(LogBufferTransport);
    expect(localBuffer.capacity).toBe(100);
  });

  it('setLogBuffer attaches buffer to new loggers', async () => {
    const logger = createLogger('test-buffer', { level: 'debug' });
    logger.info('captured message');

    // Winston transports are async — wait a tick
    await new Promise(r => setTimeout(r, 50));

    // Use getLogBuffer() to get the canonical instance
    const currentBuffer = getLogBuffer()!;
    expect(currentBuffer.size).toBeGreaterThanOrEqual(1);
    const entries = currentBuffer.getEntries();
    const captured = entries.find(e => e.message === 'captured message' && e.label === 'test-buffer');
    expect(captured).toBeDefined();
    expect(captured!.label).toBe('test-buffer');
    expect(captured!.level).toBe('info');
  });

  it('log buffer captures from multiple loggers', async () => {
    const logger1 = createLogger('module-a', { level: 'debug' });
    const logger2 = createLogger('module-b', { level: 'debug' });

    logger1.info('from module a');
    logger2.warn('from module b');

    await new Promise(r => setTimeout(r, 50));

    const currentBuffer = getLogBuffer()!;
    expect(currentBuffer.size).toBeGreaterThanOrEqual(2);
    const entries = currentBuffer.getEntries();
    expect(entries.find(e => e.label === 'module-a' && e.message === 'from module a')).toBeDefined();
    expect(entries.find(e => e.label === 'module-b' && e.message === 'from module b')).toBeDefined();
  });

  it('TSBOOTKIT_LEVEL_NAMES contains all levels', () => {
    expect(TSBOOTKIT_LEVEL_NAMES).toEqual(['error', 'warn', 'info', 'debug', 'trace']);
  });

  it('setAllLogLevels changes transport levels at runtime', () => {
    const logger = createLogger('level-test', { level: 'info' });

    const initialLevel = logger.transports[0]?.level;
    expect(initialLevel).toBe('info');

    setAllLogLevels('debug' as TsbootkitLevel);

    const newLevel = logger.transports[0]?.level;
    expect(newLevel).toBe('debug');
  });

  it('setBufferLogLevel only affects the buffer, not console/file transports', async () => {
    const logger = createLogger('buffer-level-test', { level: 'info' });

    // Buffer starts at trace (captures everything)
    expect(buffer.level).toBe('trace');

    // Console/file remain at info
    const consoleLevel = logger.transports.find(t => t !== buffer)?.level;
    expect(consoleLevel).toBe('info');

    // Narrow buffer to warn only
    setBufferLogLevel('warn' as TsbootkitLevel);
    expect(buffer.level).toBe('warn');

    // Console/file should still be info
    const consoleLevelAfter = logger.transports.find(t => t !== buffer)?.level;
    expect(consoleLevelAfter).toBe('info');
  });

  it('buffer captures all levels when logger level is debug', async () => {
    const logger = createLogger('level-capture', { level: 'debug' });

    logger.info('info message');
    logger.debug('debug message');

    await new Promise(r => setTimeout(r, 50));

    const currentBuffer = getLogBuffer()!;
    const relevant = currentBuffer.getEntries().filter(e => e.label === 'level-capture');
    expect(relevant).toHaveLength(2);
  });
});
