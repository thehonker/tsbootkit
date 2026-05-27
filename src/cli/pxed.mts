#!/usr/bin/env node
/**
 * tsbootkit-pxed — Combined PXE daemon CLI
 *
 * Starts TFTP + DHCP (or BOOTP) in one process.
 * This is the primary CLI entry point.
 *
 * Usage:
 *   tsbootkit-pxed --config tsbootkit.yaml
 *   tsbootkit-pxed eth0 pxelinux.0 /tftpboot
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { PXEServer } from '../pxe/server.mjs';
import { PXEMode } from '../pxe/types.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger, verboseCountToLevel, type TsbootkitLevel } from '../shared/logger.mjs';
import { setProcessTitle, writePIDFile, installSignalHandlers } from '../shared/signals.mjs';
import type { IPv4 } from '../shared/types.mjs';

async function main(): Promise<void> {
  setProcessTitle('tsbootkit-pxed');
  installSignalHandlers();

  const argv = await yargs(hideBin(process.argv))
    .scriptName('tsbootkit-pxed')
    .usage('$0 [options]', 'Start a PXE daemon (TFTP + DHCP/BOOTP)')
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
      description: 'PXE boot filename (e.g. pxelinux.0)',
    })
    .positional('tftproot', {
      type: 'string',
      description: 'TFTP server root directory',
    })
    .option('mode', {
      choices: ['dhcp', 'bootp'] as const,
      default: 'dhcp' as const,
      description: 'IP assignment mode (dhcp or bootp)',
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
    .option('lease-time', {
      type: 'number',
      default: 600,
      description: 'DHCP lease time in seconds (DHCP mode only)',
    })
    .option('answer-all', {
      type: 'boolean',
      default: false,
      description: 'Respond to non-PXE DHCP requests (DHCP mode only)',
    })
    .option('tftp-port', {
      type: 'number',
      default: 69,
      description: 'TFTP server port',
    })
    .option('max-transfers', {
      type: 'number',
      default: 16,
      description: 'Maximum concurrent TFTP transfers',
    })
    .option('allow-write', {
      type: 'boolean',
      default: false,
      description: 'Allow TFTP write (upload) requests',
    })
    .option('verbose', {
      alias: 'v',
      type: 'count',
      description: 'Increase verbosity (-v info, -vv debug, -vvv trace)',
    })
    .option('pid-file', {
      type: 'string',
      description: 'Write PID file to this path',
    })
    .option('health-port', {
      type: 'number',
      default: 9470,
      description: 'Health check HTTP port (0 to disable)',
    })
    .option('http-port', {
      type: 'number',
      default: 0,
      description: 'HTTP fallback server port for UEFI firmware (0 to disable)',
    })
    .option('mdns-address', {
      type: 'string',
      description: 'Address to advertise via mDNS (defaults to serverIP, set to "" to disable)',
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

  if (argv.config) {
    const config = await loadConfig(argv.config);

    // Config logging.level applies only if --verbose wasn't set
    if (config.logging?.level && !(argv as { verbose?: number }).verbose) {
      logLevel = config.logging.level as TsbootkitLevel;
    }
    if (config.logging?.file) {
      logFile = config.logging.file;
    }

    const logger = createLogger('pxed', { level: logLevel, file: logFile });

    logger.info(`Loaded config from ${argv.config}: ${config.reservations.length} reservation(s)`);

    // Write PID file if requested
    if (argv.pidFile) {
      await writePIDFile(argv.pidFile);
    }

    const server = new PXEServer({
      interface: config.interface,
      bootFile: config.bootFile,
      tftpRoot: config.tftpRoot,
      mode: config.mode,
      serverIP: config.serverIP,
      subnetMask: config.subnetMask,
      router: config.router,
      tftpServer: config.tftpServer,
      dnsServers: config.dnsServers,
      dhcp: config.dhcp,
      tftpPort: config.tftp?.port,
      maxTransfers: config.tftp?.maxTransfers,
      allowWrite: config.tftp?.allowWrite,
      reservations: config.reservations,
      healthPort: config.healthPort ?? argv.healthPort,
      httpPort: config.httpPort ?? config.http?.port ?? argv.httpPort,
      http: config.http,
      mdnsAddress: config.mdnsAddress ?? argv.mdnsAddress as string | undefined,
      bootFiles: config.bootFiles,
      hooks: config.hooks,
      bootp: config.bootp,
      followSymlinks: config.followSymlinks,
    });

    server.on('ready', () => {
      logger.info(`PXE daemon ready (mode=${config.mode}, boot=${config.bootFile})`);
    });

    await server.start();
  } else {
    const logger = createLogger('pxed', { level: logLevel, file: logFile });

    // Write PID file if requested
    if (argv.pidFile) {
      await writePIDFile(argv.pidFile);
    }

    // CLI-only mode (no config file)
    const iface = argv._[0] as string | undefined;
    const bootfile = argv._[1] as string | undefined;
    const tftproot = argv._[2] as string | undefined;

    if (!iface || !bootfile || !tftproot) {
      logger.error('Usage: tsbootkit-pxed <interface> <bootfile> <tftproot> --or-- tsbootkit-pxed --config <file>');
      process.exit(1);
    }

    const mode = argv.mode === 'bootp' ? PXEMode.BOOTP : PXEMode.DHCP;

    const server = new PXEServer({
      interface: iface,
      bootFile: bootfile,
      tftpRoot: tftproot,
      mode,
      tftpServer: argv.tftpServer as IPv4 | undefined,
      router: argv.gateway as IPv4 | undefined,
      dnsServers: (argv.dns ?? []) as IPv4[],
      dhcp: {
        leaseTime: argv.leaseTime as number | undefined,
        answerAll: argv.answerAll as boolean | undefined,
      },
      tftpPort: argv.tftpPort,
      maxTransfers: argv.maxTransfers,
      allowWrite: argv.allowWrite,
      healthPort: argv.healthPort,
      httpPort: argv.httpPort,
      mdnsAddress: argv.mdnsAddress as string | undefined,
    });

    server.on('ready', () => {
      logger.info(`PXE daemon ready (mode=${mode}, boot=${bootfile})`);
    });

    await server.start();
  }
}

main().catch((err: Error) => {
  // Last-resort error — logger may not exist yet
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
