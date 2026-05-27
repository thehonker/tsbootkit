#!/usr/bin/env node
/**
 * tsbootkit-tftpd — TFTP server CLI
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { TFTPServer } from '../tftp/server.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger, verboseCountToLevel, type TsbootkitLevel } from '../shared/logger.mjs';
import { setProcessTitle, writePIDFile, installSignalHandlers } from '../shared/signals.mjs';

async function main(): Promise<void> {
  setProcessTitle('tsbootkit-tftpd');
  installSignalHandlers();

  const argv = await yargs(hideBin(process.argv))
    .scriptName('tsbootkit-tftpd')
    .usage('$0 [options] [root]', 'Start a TFTP server')
    .option('config', {
      type: 'string',
      description: 'Path to YAML config file (overrides positional args)',
    })
    .positional('root', {
      type: 'string',
      description: 'TFTP root directory',
    })
    .option('interface', {
      type: 'string',
      description: 'Network interface to bind to (default: all interfaces)',
    })
    .option('port', {
      type: 'number',
      default: 69,
      description: 'TFTP server port',
    })
    .option('max-transfers', {
      type: 'number',
      default: 16,
      description: 'Maximum concurrent transfers',
    })
    .option('allow-write', {
      type: 'boolean',
      default: false,
      description: 'Allow WRQ (upload) requests',
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

  // Load config from YAML if specified, otherwise build from CLI args
  if (argv.config) {
    const config = await loadConfig(argv.config);

    // Config logging.level applies only if --verbose wasn't set
    if (config.logging?.level && !(argv as { verbose?: number }).verbose) {
      logLevel = config.logging.level as TsbootkitLevel;
    }
    if (config.logging?.file) {
      logFile = config.logging.file;
    }

    const logger = createLogger('tftpd', { level: logLevel, file: logFile });

    logger.info(`Loaded config from ${argv.config}`);

    const server = new TFTPServer({
      port: config.tftp?.port ?? argv.port,
      root: config.tftpRoot,
      interface: config.interface,
      maxTransfers: config.tftp?.maxTransfers ?? argv.maxTransfers,
      allowWrite: config.tftp?.allowWrite ?? argv.allowWrite,
      hooks: config.hooks,
    });

    server.on('listening', () => {
      logger.info(`TFTP server listening on port ${config.tftp?.port ?? argv.port}, root=${config.tftpRoot}`);
    });

    await server.start();
  } else {
    const logger = createLogger('tftpd', { level: logLevel, file: logFile });

    // CLI-only mode (no config file)
    const root = argv.root ?? argv._[0] as string | undefined;

    if (!root) {
      logger.error('Usage: tsbootkit-tftpd <root> --or-- tsbootkit-tftpd --config <file>');
      process.exit(1);
    }

    const server = new TFTPServer({
      port: argv.port,
      root,
      interface: argv.interface as string | undefined,
      maxTransfers: argv.maxTransfers,
      allowWrite: argv.allowWrite,
    });

    server.on('listening', () => {
      logger.info(`TFTP server listening on port ${argv.port}, root=${root}`);
    });

    await server.start();
  }
}

main().catch((err: Error) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
