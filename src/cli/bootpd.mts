#!/usr/bin/env node
/**
 * tsbootkit-bootpd — BOOTP server CLI
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { BOOTPServer } from '../bootp/server.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger, verboseCountToLevel, type TsbootkitLevel } from '../shared/logger.mjs';
import { setProcessTitle, writePIDFile, installSignalHandlers } from '../shared/signals.mjs';
import type { IPv4, MAC } from '../shared/types.mjs';

async function main(): Promise<void> {
  setProcessTitle('tsbootkit-bootpd');
  installSignalHandlers();

  const argv = await yargs(hideBin(process.argv))
    .scriptName('tsbootkit-bootpd')
    .usage('$0 [options] [interface] [bootfile]', 'Start a BOOTP server')
    .option('config', {
      type: 'string',
      description: 'Path to YAML config file (overrides positional args)',
    })
    .positional('interface', {
      type: 'string',
      description: 'Network interface to serve on',
    })
    .positional('bootfile', {
      type: 'string',
      description: 'PXE boot filename',
    })
    .option('tftp-server', {
      type: 'string',
      description: 'TFTP server IP (defaults to this host)',
    })
    .option('gateway', {
      type: 'string',
      description: 'Default gateway IP (defaults to this host)',
    })
    .option('dns', {
      type: 'array',
      description: 'DNS server IP(s)',
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

    const logger = createLogger('bootpd', { level: logLevel, file: logFile });

    logger.info(`Loaded config from ${argv.config}: ${config.reservations.length} reservation(s)`);

    const server = new BOOTPServer({
      interface: config.interface,
      bootFile: config.bootFile,
      serverIP: config.serverIP,
      subnetMask: config.subnetMask,
      tftpServer: config.tftpServer,
      router: config.router,
      dnsServers: config.dnsServers,
      bootFiles: config.bootFiles,
      hooks: config.hooks,
      allocationLifetime: config.bootp?.allocationLifetime,
    });

    // Wire reservations
    for (const res of config.reservations) {
      server.addReservation(res.mac as MAC, res.ip as IPv4, res.bootFile, res.bootFiles);
    }

    await server.start();
  } else {
    const logger = createLogger('bootpd', { level: logLevel, file: logFile });

    // CLI-only mode (no config file)
    const iface = argv.interface ?? argv._[0] as string | undefined;
    const bootfile = argv.bootfile ?? argv._[1] as string | undefined;

    if (!iface || !bootfile) {
      logger.error('Usage: tsbootkit-bootpd <interface> <bootfile> --or-- tsbootkit-bootpd --config <file>');
      process.exit(1);
    }

    const server = new BOOTPServer({
      interface: iface,
      bootFile: bootfile,
      tftpServer: argv.tftpServer as IPv4 | undefined,
      router: argv.gateway as IPv4 | undefined,
      dnsServers: (argv.dns ?? []) as IPv4[],
    });

    await server.start();
  }
}

main().catch((err: Error) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
