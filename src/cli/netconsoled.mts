#!/usr/bin/env node
/**
 * tsbootkit-netconsoled — Netconsole listener CLI
 *
 * Standalone netconsole listener for receiving kernel log messages over UDP.
 * Useful on its own or alongside the full PXE daemon.
 *
 * Usage:
 *   tsbootkit-netconsoled --port 6666 --address 0.0.0.0
 *   tsbootkit-netconsoled --config tsbootkit.yaml
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { NetconsoleServer } from '../netconsole/server.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger, verboseCountToLevel, type TsbootkitLevel } from '../shared/logger.mjs';
import { setProcessTitle, writePIDFile, installSignalHandlers } from '../shared/signals.mjs';

async function main(): Promise<void> {
  setProcessTitle('tsbootkit-netconsoled');
  installSignalHandlers();

  const argv = await yargs(hideBin(process.argv))
    .scriptName('tsbootkit-netconsoled')
    .usage('$0 [options]', 'Start a netconsole listener')
    .option('config', {
      type: 'string',
      description: 'Path to YAML config file (overrides positional args)',
    })
    .option('port', {
      type: 'number',
      default: 6666,
      description: 'UDP port to listen on (0 = disabled)',
    })
    .option('address', {
      type: 'string',
      description: 'Address to bind (default: 0.0.0.0)',
    })
    .option('level', {
      choices: ['error', 'warn', 'info', 'debug', 'trace'] as const,
      default: 'info' as const,
      description: 'Log level for received messages',
    })
    .option('pid-file', {
      type: 'string',
      description: 'Write PID file to this path',
    })
    .option('verbose', {
      alias: 'v',
      type: 'count',
      description: 'Increase verbosity (-v info, -vv debug, -vvv trace)',
    })
    .version()
    .help()
    .argv;

  // Determine log level and file from CLI flags / config
  let logLevel: TsbootkitLevel = 'info';
  let logFile: string | undefined;

  if ((argv as { verbose?: number }).verbose) {
    logLevel = verboseCountToLevel((argv as { verbose: number }).verbose);
  }

  // Write PID file if requested
  if (argv.pidFile) {
    await writePIDFile(argv.pidFile);
  }

  if (argv.config) {
    const config = await loadConfig(argv.config);

    // Config logging.level applies only if --verbose wasn't set
    if (config.logging?.level && !(argv as { verbose?: number }).verbose) {
      logLevel = config.logging.level as TsbootkitLevel;
    }
    if (config.logging?.file) {
      logFile = config.logging.file;
    }

    const logger = createLogger('netconsoled', { level: logLevel, file: logFile });

    if (!config.netconsole || (config.netconsole.port ?? 6666) === 0) {
      logger.error('Netconsole is not enabled in config (port is 0 or section is missing)');
      process.exit(1);
    }

    logger.info(`Loaded config from ${argv.config}`);

    const server = new NetconsoleServer({
      port: config.netconsole.port,
      address: config.netconsole.address ?? config.serverIP as string | undefined,
      level: config.netconsole.level as TsbootkitLevel | undefined,
      hooks: config.hooks,
    });

    await server.start();
  } else {
    const logger = createLogger('netconsoled', { level: logLevel, file: logFile });

    if (argv.port === 0) {
      logger.error('Port must be > 0 (use --port 6666 or set a non-zero port)');
      process.exit(1);
    }

    const server = new NetconsoleServer({
      port: argv.port,
      address: argv.address,
      level: argv.level as TsbootkitLevel,
    });

    await server.start();
  }
}

main().catch((err: Error) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
