#!/usr/bin/env node
/**
 * tsbootkit-dhcpd — DHCP server CLI
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { DHCPServer } from '../dhcp/server.mjs';
import { loadConfig } from '../config.mjs';
import { createLogger, verboseCountToLevel, type TsbootkitLevel } from '../shared/logger.mjs';
import { setProcessTitle, writePIDFile, installSignalHandlers } from '../shared/signals.mjs';
import { getInterfaceConfig, getInterfaceStatus, waitForInterface } from '../shared/network.mjs';
import type { IPv4, MAC } from '../shared/types.mjs';

async function main(): Promise<void> {
  setProcessTitle('tsbootkit-dhcpd');
  installSignalHandlers();

  const argv = await yargs(hideBin(process.argv))
    .scriptName('tsbootkit-dhcpd')
    .usage('$0 [options] [interface] [bootfile]', 'Start a PXE-aware DHCP server')
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
      description: 'DHCP lease time in seconds',
    })
    .option('answer-all', {
      type: 'boolean',
      default: false,
      description: 'Respond to non-PXE DHCP requests',
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
    .option('wait', {
      type: 'boolean',
      default: false,
      description: 'Wait for the interface to come up before starting',
    })
    .option('wait-timeout', {
      type: 'number',
      default: 0,
      description: 'Max seconds to wait for the interface (0 = forever, requires --wait)',
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

    const logger = createLogger('dhcpd', { level: logLevel, file: logFile });

    logger.info(`Loaded config from ${argv.config}: ${config.reservations.length} reservation(s)`);

    // Resolve interface if serverIP/subnetMask weren't provided by config
    const shouldWait = config.wait ?? (argv.wait as boolean);
    const waitTimeout = config.waitTimeout ?? (argv.waitTimeout as number) ?? 0;
    let ifaceConfig = undefined;
    if (!config.serverIP || !config.subnetMask) {
      ifaceConfig = await resolveInterfaceForStandalone(config.interface, logger, shouldWait, waitTimeout);
    }

    const server = new DHCPServer({
      interface: config.interface,
      bootFile: config.bootFile,
      serverIP: config.serverIP ?? ifaceConfig?.address,
      subnetMask: config.subnetMask ?? ifaceConfig?.netmask,
      tftpServer: config.tftpServer,
      router: config.router,
      dnsServers: config.dnsServers,
      leaseTime: config.dhcp?.leaseTime,
      answerAll: config.dhcp?.answerAll,
      bootFiles: config.bootFiles,
      hooks: config.hooks,
    });

    // Wire reservations
    for (const res of config.reservations) {
      server.addReservation(res.mac as MAC, res.ip as IPv4, res.bootFile, res.bootFiles);
    }

    await server.start();
  } else {
    const logger = createLogger('dhcpd', { level: logLevel, file: logFile });

    // CLI-only mode (no config file)
    const iface = argv.interface ?? argv._[0] as string | undefined;
    const bootfile = argv.bootfile ?? argv._[1] as string | undefined;

    if (!iface || !bootfile) {
      logger.error('Usage: tsbootkit-dhcpd <interface> <bootfile> --or-- tsbootkit-dhcpd --config <file>');
      process.exit(1);
    }

    // Resolve interface (with optional wait)
    const shouldWait = argv.wait as boolean;
    const waitTimeout = argv.waitTimeout as number;
    const ifaceConfig = await resolveInterfaceForStandalone(iface, logger, shouldWait, waitTimeout);

    const server = new DHCPServer({
      interface: iface,
      bootFile: bootfile,
      serverIP: ifaceConfig.address,
      subnetMask: ifaceConfig.netmask,
      tftpServer: argv.tftpServer as IPv4 | undefined,
      router: argv.gateway as IPv4 | undefined,
      dnsServers: (argv.dns ?? []) as IPv4[],
      leaseTime: argv.leaseTime,
      answerAll: argv.answerAll,
    });

    await server.start();
  }
}

main().catch((err: Error) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});

/**
 * Resolve a network interface for standalone CLI use.
 * Handles the wait/poll logic that PXEServer does internally.
 */
async function resolveInterfaceForStandalone(
  iface: string,
  logger: ReturnType<typeof createLogger>,
  wait: boolean,
  waitTimeout: number,
) {
  const status = getInterfaceStatus(iface);

  if (status === 'up') {
    return getInterfaceConfig(iface);
  }

  if (!wait) {
    throw new Error(`Interface ${iface} is ${status} — use --wait to poll for link-up`);
  }

  logger.info(`Interface ${iface} is ${status}, waiting for it to come up...`);

  let lastLogTime = 0;
  const ifaceConfig = await waitForInterface(iface, {
    timeoutMs: waitTimeout * 1000,
    onPoll: (currentStatus, elapsedMs) => {
      if (elapsedMs - lastLogTime >= 10_000) {
        lastLogTime = elapsedMs;
        logger.info(`Still waiting for ${iface} (${currentStatus}, ${Math.round(elapsedMs / 1000)}s)...`);
      }
    },
  });

  logger.info(`Interface ${iface} is now up`);
  return ifaceConfig;
}
