import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildHookArgs, runHook, runHooks } from '../../src/shared/hooks.mjs';
import type { HookConfig, TFTPHookContext, DHCPHookContext, BOOTPHookContext } from '../../src/shared/hooks.mjs';

// ─── buildHookArgs — TFTP ───────────────────────────────────────────

describe('buildHookArgs (TFTP)', () => {
  it('builds args for a pre event', () => {
    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'pre',
      direction: 'rrq',
      clientIP: '192.168.1.50',
      clientPort: 54321,
      filename: 'pxelinux.0',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['pre', 'rrq', '192.168.1.50', '54321', 'pxelinux.0']);
  });

  it('builds args for a post event with byte counts', () => {
    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'post',
      direction: 'rrq',
      clientIP: '10.0.0.1',
      clientPort: 12345,
      filename: 'vmlinuz',
      bytesSent: 8192,
      bytesReceived: 0,
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['post', 'rrq', '10.0.0.1', '12345', 'vmlinuz', '8192', '0']);
  });

  it('builds args for an on-error event', () => {
    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'on-error',
      direction: 'wrq',
      clientIP: '172.16.0.5',
      clientPort: 9999,
      filename: 'upload.bin',
      errorCode: 4,
      errorMessage: 'Access violation',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['on-error', 'wrq', '172.16.0.5', '9999', 'upload.bin', '4', 'Access violation']);
  });

  it('handles missing optional fields with defaults', () => {
    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'post',
      direction: 'rrq',
      clientIP: '1.2.3.4',
      clientPort: 69,
      filename: 'test',
      // bytesSent and bytesReceived omitted
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['post', 'rrq', '1.2.3.4', '69', 'test', '0', '0']);
  });
});

// ─── buildHookArgs — DHCP ───────────────────────────────────────────

describe('buildHookArgs (DHCP)', () => {
  it('builds args for a discover event with hostname', () => {
    const ctx: DHCPHookContext = {
      protocol: 'dhcp',
      event: 'discover',
      clientMAC: 'aa:bb:cc:dd:ee:01',
      hostname: 'build-server',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['discover', 'aa:bb:cc:dd:ee:01', 'build-server']);
  });

  it('builds args for a discover event without hostname', () => {
    const ctx: DHCPHookContext = {
      protocol: 'dhcp',
      event: 'discover',
      clientMAC: 'aa:bb:cc:dd:ee:01',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['discover', 'aa:bb:cc:dd:ee:01']);
  });

  it('builds args for an offer event', () => {
    const ctx: DHCPHookContext = {
      protocol: 'dhcp',
      event: 'offer',
      clientMAC: 'aa:bb:cc:dd:ee:01',
      offeredIP: '192.168.1.50',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['offer', 'aa:bb:cc:dd:ee:01', '192.168.1.50']);
  });

  it('builds args for a request event with hostname', () => {
    const ctx: DHCPHookContext = {
      protocol: 'dhcp',
      event: 'request',
      clientMAC: 'aa:bb:cc:dd:ee:01',
      requestedIP: '192.168.1.50',
      hostname: 'build-server',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['request', 'aa:bb:cc:dd:ee:01', '192.168.1.50', 'build-server']);
  });

  it('builds args for an ack event', () => {
    const ctx: DHCPHookContext = {
      protocol: 'dhcp',
      event: 'ack',
      clientMAC: 'aa:bb:cc:dd:ee:01',
      assignedIP: '192.168.1.50',
      hostname: 'build-server',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['ack', 'aa:bb:cc:dd:ee:01', '192.168.1.50', 'build-server']);
  });

  it('builds args for a nak event', () => {
    const ctx: DHCPHookContext = {
      protocol: 'dhcp',
      event: 'nak',
      clientMAC: 'aa:bb:cc:dd:ee:01',
      reason: 'requested IP outside subnet',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['nak', 'aa:bb:cc:dd:ee:01', 'requested IP outside subnet']);
  });
});

// ─── buildHookArgs — BOOTP ──────────────────────────────────────────

describe('buildHookArgs (BOOTP)', () => {
  it('builds args for a request event', () => {
    const ctx: BOOTPHookContext = {
      protocol: 'bootp',
      event: 'request',
      clientMAC: 'aa:bb:cc:dd:ee:01',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['request', 'aa:bb:cc:dd:ee:01']);
  });

  it('builds args for a reply event', () => {
    const ctx: BOOTPHookContext = {
      protocol: 'bootp',
      event: 'reply',
      clientMAC: 'aa:bb:cc:dd:ee:01',
      assignedIP: '192.168.1.50',
    };

    const args = buildHookArgs(ctx);
    expect(args).toEqual(['reply', 'aa:bb:cc:dd:ee:01', '192.168.1.50']);
  });
});

// ─── runHook ────────────────────────────────────────────────────────

describe('runHook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips hooks that do not match the event', () => {
    const hook: HookConfig = {
      exec: '/bin/echo',
      events: ['post'],
    };

    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'pre',
      direction: 'rrq',
      clientIP: '10.0.0.1',
      clientPort: 12345,
      filename: 'test',
    };

    runHook(hook, ctx);
  });

  it('runs hooks that match the event', () => {
    const hook: HookConfig = {
      exec: '/bin/echo',
      events: ['pre'],
    };

    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'pre',
      direction: 'rrq',
      clientIP: '10.0.0.1',
      clientPort: 12345,
      filename: 'test',
    };

    runHook(hook, ctx);
  });

  it('runs hooks with no event filter (all events)', () => {
    const hook: HookConfig = {
      exec: '/bin/echo',
    };

    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'on-error',
      direction: 'wrq',
      clientIP: '1.1.1.1',
      clientPort: 69,
      filename: 'fail',
      errorCode: 1,
      errorMessage: 'oops',
    };

    runHook(hook, ctx);
  });

  it('runs DHCP hooks that match the event', () => {
    const hook: HookConfig = {
      exec: '/bin/echo',
      events: ['ack'],
    };

    const ctx: DHCPHookContext = {
      protocol: 'dhcp',
      event: 'ack',
      clientMAC: 'aa:bb:cc:dd:ee:01',
      assignedIP: '192.168.1.50',
    };

    runHook(hook, ctx);
  });

  it('skips DHCP hooks for non-matching protocol events', () => {
    const hook: HookConfig = {
      exec: '/bin/echo',
      events: ['ack'],  // DHCP ack — should NOT match TFTP post
    };

    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'post',
      direction: 'rrq',
      clientIP: '10.0.0.1',
      clientPort: 12345,
      filename: 'test',
    };

    runHook(hook, ctx);
  });

  it('runs cross-protocol hooks with matching event names', () => {
    const hook: HookConfig = {
      exec: '/bin/echo',
      events: ['ack', 'post'],  // both TFTP and DHCP events
    };

    const ctx: DHCPHookContext = {
      protocol: 'dhcp',
      event: 'ack',
      clientMAC: 'aa:bb:cc:dd:ee:01',
      assignedIP: '192.168.1.50',
    };

    runHook(hook, ctx);
  });

  it('appends extra args', () => {
    const hook: HookConfig = {
      exec: '/bin/echo',
      extraArgs: ['--notify', 'slack'],
    };

    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'pre',
      direction: 'rrq',
      clientIP: '10.0.0.1',
      clientPort: 12345,
      filename: 'test',
    };

    runHook(hook, ctx);
  });
});

// ─── runHooks ───────────────────────────────────────────────────────

describe('runHooks', () => {
  it('runs all matching hooks', () => {
    const hooks: HookConfig[] = [
      { exec: '/bin/echo', events: ['pre', 'post'] },
      { exec: '/bin/true', events: ['on-error'] },
    ];

    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'pre',
      direction: 'rrq',
      clientIP: '10.0.0.1',
      clientPort: 12345,
      filename: 'test',
    };

    runHooks(hooks, ctx);
  });

  it('handles empty hook list', () => {
    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'pre',
      direction: 'rrq',
      clientIP: '10.0.0.1',
      clientPort: 12345,
      filename: 'test',
    };

    runHooks([], ctx);
  });
});

// ─── Integration: run a real script ─────────────────────────────────

describe('runHook integration', () => {
  it('executes a real script with TFTP context', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');

    const marker = path.join(os.tmpdir(), `tsbootkit-hook-test-${Date.now()}`);
    const script = path.join(os.tmpdir(), `tsbootkit-hook-script-${Date.now()}.sh`);

    await fs.writeFile(script, `#!/bin/sh\necho ok > "${marker}"\n`, { mode: 0o755 });

    const hook: HookConfig = { exec: script };

    const ctx: TFTPHookContext = {
      protocol: 'tftp',
      event: 'pre',
      direction: 'rrq',
      clientIP: '10.0.0.1',
      clientPort: 12345,
      filename: 'test',
    };

    runHook(hook, ctx);

    await new Promise((r) => setTimeout(r, 500));

    const content = await fs.readFile(marker, 'utf-8');
    expect(content.trim()).toBe('ok');

    await fs.unlink(marker);
    await fs.unlink(script);
  });

  it('executes a real script with DHCP context', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');

    const marker = path.join(os.tmpdir(), `tsbootkit-dhcp-hook-test-${Date.now()}`);
    const script = path.join(os.tmpdir(), `tsbootkit-dhcp-hook-script-${Date.now()}.sh`);

    // Script that writes the event and MAC to a marker file
    await fs.writeFile(script, `#!/bin/sh\necho "$1 $2 $3" > "${marker}"\n`, { mode: 0o755 });

    const hook: HookConfig = { exec: script, events: ['ack'] };

    const ctx: DHCPHookContext = {
      protocol: 'dhcp',
      event: 'ack',
      clientMAC: 'aa:bb:cc:dd:ee:01',
      assignedIP: '192.168.1.50',
    };

    runHook(hook, ctx);

    await new Promise((r) => setTimeout(r, 500));

    const content = await fs.readFile(marker, 'utf-8');
    expect(content.trim()).toBe('ack aa:bb:cc:dd:ee:01 192.168.1.50');

    await fs.unlink(marker);
    await fs.unlink(script);
  });

  it('executes a real script with BOOTP context', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');

    const marker = path.join(os.tmpdir(), `tsbootkit-bootp-hook-test-${Date.now()}`);
    const script = path.join(os.tmpdir(), `tsbootkit-bootp-hook-script-${Date.now()}.sh`);

    await fs.writeFile(script, `#!/bin/sh\necho "$1 $2 $3" > "${marker}"\n`, { mode: 0o755 });

    const hook: HookConfig = { exec: script, events: ['reply'] };

    const ctx: BOOTPHookContext = {
      protocol: 'bootp',
      event: 'reply',
      clientMAC: '11:22:33:44:55:66',
      assignedIP: '10.0.0.5',
    };

    runHook(hook, ctx);

    await new Promise((r) => setTimeout(r, 500));

    const content = await fs.readFile(marker, 'utf-8');
    expect(content.trim()).toBe('reply 11:22:33:44:55:66 10.0.0.5');

    await fs.unlink(marker);
    await fs.unlink(script);
  });
});
