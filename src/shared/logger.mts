/**
 * Winston logger setup for tsbootkit.
 *
 * - In TTY: colorized, human-readable console output
 * - In non-TTY / production: JSON structured logs
 * - Per-transport log levels configurable
 */

import winston from 'winston';
import { TransformableInfo } from 'logform'; // winston's internal type for logform

/** Custom log levels beyond winston defaults — adds 'trace' below debug. */
const TSBOOTKIT_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
} as const;

export type TsbootkitLevel = keyof typeof TSBOOTKIT_LEVELS;

/** Map a --verbose count to a log level. */
export function verboseCountToLevel(count: number): TsbootkitLevel {
  switch (count) {
    case 0: return 'info';
    case 1: return 'debug';
    default: return 'trace'; // 2+ → most verbose
  }
}

/**
 * Create a Winston logger configured for tsbootkit.
 *
 * @param label - Module label (e.g. 'tftpd', 'dhcpd') for log context.
 * @param options - Optional overrides.
 * @param options.level - Minimum log level (default: 'info').
 * @param options.file - Write JSON logs to this file path.
 * @param options.json - Force JSON output even in TTY (default: false).
 * @param options.timestamp - Include ISO timestamp in logs (default: true).
 */
export function createLogger(
  label: string,
  options: {
    level?: TsbootkitLevel;
    file?: string;
    json?: boolean;
    timestamp?: boolean;
  } = {},
): winston.Logger {
  const {
    level = 'info',
    file,
    json = false,
    timestamp = true,
  } = options;

  const isTTY = process.stdout.isTTY;

  const transports: winston.transport[] = [];

  // Console transport — format depends on TTY and json flag
  if (isTTY && !json) {
    // Human-readable colorized output for interactive use
    const formatParts = [
      winston.format.label({ label }),
    ];
    if (timestamp) {
      formatParts.push(winston.format.timestamp({ format: 'HH:mm:ss' }));
    }
    formatParts.push(
      winston.format.colorize(),
      winston.format.printf((info: TransformableInfo) => {
        const ts = info.timestamp ? `[${info.timestamp as string}] ` : '';
        const lbl = info.label ? `${info.label} ` : '';
        return `${ts}${lbl}${info.level}: ${info.message as string}`;
      }),
    );
    const consoleFormat = winston.format.combine(...formatParts);

    transports.push(new winston.transports.Console({
      level,
      format: consoleFormat,
    }));
  } else {
    // JSON structured output for production / log aggregation
    const jsonFormatParts = [
      winston.format.label({ label }),
    ];
    if (timestamp) {
      jsonFormatParts.push(winston.format.timestamp());
    }
    jsonFormatParts.push(
      winston.format.errors({ stack: true }),
      winston.format.json(),
    );
    const jsonFmt = winston.format.combine(...jsonFormatParts);

    transports.push(new winston.transports.Console({
      level,
      format: jsonFmt,
    }));
  }

  // File transport — if file path is provided
  if (file) {
    transports.push(new winston.transports.File({
      level,
      filename: file,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
    }));
  }

  const logger = winston.createLogger({
    levels: TSBOOTKIT_LEVELS,
    transports,
  });

  return logger;
}
