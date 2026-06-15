/** Netconsole listener type definitions. */

/** Netconsole server configuration. */
export interface NetconsoleConfig {
  /** UDP port to listen on (default 6666). */
  port?: number;
  /** Address to bind (defaults to serverIP from PXE config). */
  address?: string;
  /** Log level for received messages (default 'info'). */
  level?: 'error' | 'warn' | 'info' | 'debug' | 'trace';
}
