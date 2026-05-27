/**
 * Lifecycle hooks — execute external programs on server events.
 *
 * Supports any executable (bash, python, etc.) with context passed
 * as command-line arguments. Hooks are fire-and-forget — the event flow
 * is never blocked by a hook's exit code or runtime.
 *
 * **Security note:** The config file must be writable only by trusted users.
 * Hook `exec` paths are resolved relative to the config file directory if
 * not absolute, and validated for existence at config load time. However,
 * the executable itself runs with the server's full permissions. Protect
 * your config file accordingly.
 *
 * Supported events:
 *   TFTP:  pre | post | on-error
 *   DHCP:  discover | offer | request | ack | nak
 *   BOOTP: request | reply
 *
 * Arguments passed to the executable vary by protocol:
 *
 *   TFTP:  <event> <direction> <client-ip> <client-port> <filename> [extra...]
 *     extra (post):      <bytes-sent> <bytes-received>
 *     extra (on-error):  <error-code> <error-message>
 *
 *   DHCP:  <event> <client-mac> [extra...]
 *     extra (discover):  <hostname>
 *     extra (offer):     <offered-ip>
 *     extra (request):   <requested-ip> <hostname>
 *     extra (ack):       <assigned-ip> <hostname>
 *     extra (nak):       <reason>
 *
 *   BOOTP: <event> <client-mac> [extra...]
 *     extra (reply):     <assigned-ip>
 */

import { execFile } from 'node:child_process';
import { createLogger } from './logger.mjs';

// ─── Hook events ───────────────────────────────────────────────────

/** TFTP transfer events. */
export type TFTPHookEvent = 'pre' | 'post' | 'on-error';

/** DHCP protocol events. */
export type DHCPHookEvent = 'discover' | 'offer' | 'request' | 'ack' | 'nak';

/** BOOTP protocol events. */
export type BOOTPHookEvent = 'request' | 'reply';

/** All possible hook events across all protocols. */
export type HookEvent = TFTPHookEvent | DHCPHookEvent | BOOTPHookEvent;

// ─── Hook config ───────────────────────────────────────────────────

/** A single hook definition. */
export interface HookConfig {
  /** Path to the executable. */
  exec: string;
  /** Which events trigger this hook. Defaults to all events for the protocol. */
  events?: HookEvent[];
  /** Additional arguments appended after the standard ones. */
  extraArgs?: string[];
}

// ─── Hook contexts ─────────────────────────────────────────────────

/** Context for a TFTP hook invocation. */
export interface TFTPHookContext {
  protocol: 'tftp';
  event: TFTPHookEvent;
  /** Transfer direction. */
  direction: 'rrq' | 'wrq';
  /** Client IP address. */
  clientIP: string;
  /** Client port. */
  clientPort: number;
  /** Requested filename. */
  filename: string;
  /** Bytes sent (post only). */
  bytesSent?: number;
  /** Bytes received (post only). */
  bytesReceived?: number;
  /** TFTP error code (on-error only). */
  errorCode?: number;
  /** Error message (on-error only). */
  errorMessage?: string;
}

/** Context for a DHCP hook invocation. */
export interface DHCPHookContext {
  protocol: 'dhcp';
  event: DHCPHookEvent;
  /** Client MAC address. */
  clientMAC: string;
  /** Client hostname (option 12, if provided). */
  hostname?: string;
  /** Offered IP (offer). */
  offeredIP?: string;
  /** Requested IP (request). */
  requestedIP?: string;
  /** Assigned IP (ack). */
  assignedIP?: string;
  /** NAK reason (nak). */
  reason?: string;
}

/** Context for a BOOTP hook invocation. */
export interface BOOTPHookContext {
  protocol: 'bootp';
  event: BOOTPHookEvent;
  /** Client MAC address. */
  clientMAC: string;
  /** Assigned IP (reply). */
  assignedIP?: string;
}

/** Union of all hook contexts. */
export type HookContext = TFTPHookContext | DHCPHookContext | BOOTPHookContext;

// ─── Arg builders ──────────────────────────────────────────────────

/**
 * Build the argument list for a TFTP hook invocation.
 */
function buildTFTPHookArgs(ctx: TFTPHookContext): string[] {
  const args: string[] = [
    ctx.event,
    ctx.direction,
    ctx.clientIP,
    String(ctx.clientPort),
    ctx.filename,
  ];

  if (ctx.event === 'post') {
    args.push(String(ctx.bytesSent ?? 0));
    args.push(String(ctx.bytesReceived ?? 0));
  }

  if (ctx.event === 'on-error') {
    args.push(String(ctx.errorCode ?? 0));
    args.push(ctx.errorMessage ?? '');
  }

  return args;
}

/**
 * Build the argument list for a DHCP hook invocation.
 */
function buildDHCPHookArgs(ctx: DHCPHookContext): string[] {
  const args: string[] = [
    ctx.event,
    ctx.clientMAC,
  ];

  switch (ctx.event) {
    case 'discover':
      if (ctx.hostname) args.push(ctx.hostname);
      break;
    case 'offer':
      args.push(ctx.offeredIP ?? '');
      break;
    case 'request':
      args.push(ctx.requestedIP ?? '');
      if (ctx.hostname) args.push(ctx.hostname);
      break;
    case 'ack':
      args.push(ctx.assignedIP ?? '');
      if (ctx.hostname) args.push(ctx.hostname);
      break;
    case 'nak':
      args.push(ctx.reason ?? '');
      break;
  }

  return args;
}

/**
 * Build the argument list for a BOOTP hook invocation.
 */
function buildBOOTPHookArgs(ctx: BOOTPHookContext): string[] {
  const args: string[] = [
    ctx.event,
    ctx.clientMAC,
  ];

  if (ctx.event === 'reply') {
    args.push(ctx.assignedIP ?? '');
  }

  return args;
}

/**
 * Build the argument list for any hook invocation.
 */
export function buildHookArgs(ctx: HookContext): string[] {
  switch (ctx.protocol) {
    case 'tftp': return buildTFTPHookArgs(ctx);
    case 'dhcp': return buildDHCPHookArgs(ctx);
    case 'bootp': return buildBOOTPHookArgs(ctx);
  }
}

// ─── Hook runner ───────────────────────────────────────────────────

const log = createLogger('hooks');

/**
 * Run a single hook. Fire-and-forget — errors are logged, not thrown.
 */
export function runHook(hook: HookConfig, ctx: HookContext): void {
  if (hook.events && hook.events.length > 0 && !hook.events.includes(ctx.event)) {
    return;
  }

  const args = buildHookArgs(ctx);
  if (hook.extraArgs) {
    args.push(...hook.extraArgs);
  }

  log.info(`Hook [${ctx.protocol}:${ctx.event}]: ${hook.exec} ${args.join(' ')}`);

  execFile(hook.exec, args, (err, stdout, stderr) => {
    if (err) {
      log.error(`Hook ${hook.exec} failed (exit ${err.code ?? '?'}): ${err.message}`);
      return;
    }
    if (stderr.trim()) {
      log.debug(`Hook ${hook.exec} stderr: ${stderr.trim()}`);
    }
    if (stdout.trim()) {
      log.debug(`Hook ${hook.exec} stdout: ${stdout.trim()}`);
    }
  });
}

/**
 * Run all matching hooks for an event.
 */
export function runHooks(hooks: HookConfig[], ctx: HookContext): void {
  for (const hook of hooks) {
    runHook(hook, ctx);
  }
}
