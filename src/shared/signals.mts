/**
 * Graceful shutdown handling for tsbootkit servers.
 *
 * Catches SIGINT, SIGTERM, and uncaught exceptions, then calls
 * registered cleanup functions in reverse order before exiting.
 * Prevents zombie transfers, leaked sockets, and lost DHCP leases.
 */

import { createLogger } from './logger.mjs';

const log = createLogger('shutdown');

type CleanupFn = () => void | Promise<void>;

/** Registered cleanup functions, called in reverse order on shutdown. */
const cleanupStack: CleanupFn[] = [];

/** Whether we're already shutting down (prevent double-trigger). */
let shuttingDown = false;

/**
 * Register a cleanup function to run on shutdown.
 * Functions are called in reverse registration order (last-in, first-out).
 *
 * @returns A function to deregister the cleanup.
 */
export function onShutdown(fn: CleanupFn): () => void {
  cleanupStack.push(fn);
  return () => {
    const idx = cleanupStack.indexOf(fn);
    if (idx !== -1) {
      cleanupStack.splice(idx, 1);
    }
  };
}

/**
 * Trigger a graceful shutdown.
 *
 * @param signal - The signal or reason that triggered the shutdown.
 * @param exitCode - Process exit code (default 0).
 */
export async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  log.info(`Received ${signal}, shutting down gracefully...`);

  // Run cleanup functions in reverse order
  while (cleanupStack.length > 0) {
    const fn = cleanupStack.pop()!;
    try {
      await fn();
    } catch (err) {
      log.error(`Cleanup function failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  log.info('Shutdown complete.');
  process.exit(exitCode);
}

/**
 * Install signal handlers for graceful shutdown.
 *
 * @returns A function to remove the handlers (useful for tests).
 */
export function installSignalHandlers(): () => void {
  const onSIGINT = () => shutdown('SIGINT');
  const onSIGTERM = () => shutdown('SIGTERM');
  const onUncaught = (err: Error) => {
    log.error(`Uncaught exception: ${err.message}`);
    shutdown('uncaughtException', 1);
  };
  const onUnhandledRejection = (reason: unknown) => {
    log.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
    shutdown('unhandledRejection', 1);
  };

  process.on('SIGINT', onSIGINT);
  process.on('SIGTERM', onSIGTERM);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandledRejection);

  // Return a cleanup function to remove the handlers
  return () => {
    process.off('SIGINT', onSIGINT);
    process.off('SIGTERM', onSIGTERM);
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandledRejection);
  };
}

// ─── Process title ────────────────────────────────────────────────

/**
 * Set the process title for `ps` / `top` visibility.
 *
 * @param name - Short name like "tsbootkit-pxed".
 */
export function setProcessTitle(name: string): void {
  process.title = name;
}

// ─── PID file ─────────────────────────────────────────────────────

/**
 * Write a PID file and register cleanup on shutdown.
 *
 * @param pidPath - Path to the PID file (e.g. "/run/tsbootkit.pid").
 * @throws Error if the PID file already exists and is locked by a running process.
 */
export async function writePIDFile(pidPath: string): Promise<void> {
  const fs = await import('node:fs/promises');

  // Check if another instance is already running
  try {
    const existing = await fs.readFile(pidPath, 'utf8');
    const existingPid = parseInt(existing.trim(), 10);

    if (!isNaN(existingPid)) {
      // Check if the process is actually running
      try {
        process.kill(existingPid, 0); // signal 0 = existence check
        // No error → process is alive
        throw new Error(`Another instance is already running (PID ${existingPid}, ${pidPath})`);
      } catch (err: unknown) {
        // Re-throw our own "already running" error
        if (err instanceof Error && err.message.includes('already running')) {
          throw err;
        }
        // ESRCH = process doesn't exist → stale PID file, safe to overwrite
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw err;
        }
      }
    }
  } catch (err: unknown) {
    // ENOENT = file doesn't exist — that's fine, we'll create it
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // Write the PID file
  await fs.writeFile(pidPath, `${process.pid}\n`, 'utf8');

  // Register cleanup
  onShutdown(async () => {
    try {
      await fs.unlink(pidPath);
    } catch {
      // Already gone, fine
    }
  });
}
