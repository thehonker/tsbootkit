/**
 * Combined PXE daemon.
 *
 * Runs TFTP + DHCP (or BOOTP) in a single process for PXE boot.
 * Clients get an IP via DHCP/BOOTP, then fetch their boot image via TFTP
 * from the same host — one command to light up a PXE environment.
 *
 * pTFTPd had three separate CLI tools (tftpd, dhcpd, bootpd) that you
 * had to run yourself. We still support that, but the PXE daemon is the
 * intended primary interface.
 */

import { EventEmitter } from 'node:events';

import { createLogger } from '../shared/logger.mjs';
import { onShutdown } from '../shared/signals.mjs';
import { IPv4, MAC, type InterfaceConfig, type InterfaceStatus } from '../shared/types.mjs';
import { getInterfaceConfig, getInterfaceStatus, waitForInterface } from '../shared/network.mjs';
import { HealthCheckServer, HealthStatus } from '../shared/health.mjs';
import { HTTPServer } from '../shared/http.mjs';
import { mDNSAdvertiser } from '../shared/mdns.mjs';
import { registerDashboardRoutes, type DashboardStatus, type DashboardReservation } from '../shared/dashboard.mjs';

import { TFTPServer } from '../tftp/server.mjs';
import { DHCPServer } from '../dhcp/server.mjs';
import { BOOTPServer } from '../bootp/server.mjs';

import {
  PXEServerConfig,
  PXEMode,
} from './types.mjs';

// ─── Version ────────────────────────────────────────────────────────

declare const PKG_VERSION: string;
const _version: string = typeof PKG_VERSION !== 'undefined' ? PKG_VERSION : '0.0.0';

// ─── PXE Server ────────────────────────────────────────────────────

export class PXEServer extends EventEmitter {
  private readonly rawConfig: PXEServerConfig;
  private config!: {
    interface: string;
    bootFile: string;
    tftpRoot: string;
    mode: PXEMode;
    serverIP: IPv4;
    subnetMask: IPv4;
    router: IPv4;
    tftpServer: IPv4;
    dnsServers: IPv4[];
    dhcp?: import('../config.mjs').DHCPConfig;
    tftpPort: number;
    maxTransfers: number;
    allowWrite: boolean;
    reservations: import('../config.mjs').Reservation[];
    healthPort: number;
    httpPort: number;
    http?: import('../config.mjs').HTTPConfig;
    mdnsAddress?: string;
    bootFiles?: import('../config.mjs').BootFileMap;
    hooks?: import('../shared/hooks.mjs').HookConfig[];
    bootp?: import('../config.mjs').BOOTPConfig;
    followSymlinks?: boolean;
  };
  private tftpServer: TFTPServer | null = null;
  private ipServer: DHCPServer | BOOTPServer | null = null;
  private healthServer: HealthCheckServer | null = null;
  private httpServer: HTTPServer | null = null;
  private mdns: mDNSAdvertiser | null = null;
  private interfaceMonitor: ReturnType<typeof setInterval> | null = null;
  private interfaceState: InterfaceStatus | 'ip-changed' = 'up';
  private readonly log;
  private running = false;

  constructor(config: PXEServerConfig) {
    super();
    this.rawConfig = config;
    this.log = createLogger('pxed');
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Start the PXE daemon (TFTP + DHCP/BOOTP).
   *
   * If the configured interface is down and `wait` is enabled, polls
   * until the interface comes up (or timeout expires). Otherwise
   * throws immediately for unavailable interfaces.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('PXE server is already running');
    }

    const mode = this.rawConfig.mode ?? PXEMode.DHCP;

    // ── Resolve interface ────────────────────────────────────────
    const status = getInterfaceStatus(this.rawConfig.interface);
    let ifaceConfig: InterfaceConfig;

    if (status === 'up') {
      ifaceConfig = getInterfaceConfig(this.rawConfig.interface);
    } else if (this.rawConfig.wait) {
      this.log.info(
        `Interface ${this.rawConfig.interface} is ${status}, waiting for it to come up...`,
      );

      let lastLogTime = 0;
      ifaceConfig = await waitForInterface(this.rawConfig.interface, {
        timeoutMs: (this.rawConfig.waitTimeout ?? 0) * 1000,
        onPoll: (currentStatus, elapsedMs) => {
          // Log every ~10s
          if (elapsedMs - lastLogTime >= 10_000) {
            lastLogTime = elapsedMs;
            this.log.info(
              `Still waiting for ${this.rawConfig.interface} (${currentStatus}, ${Math.round(elapsedMs / 1000)}s)...`,
            );
          }
        },
      });

      this.log.info(`Interface ${this.rawConfig.interface} is now up`);
    } else {
      throw new Error(
        `Interface ${this.rawConfig.interface} is ${status} — use --wait to poll for link-up`,
      );
    }

    // ── Build resolved config ────────────────────────────────────
    this.config = {
      interface: this.rawConfig.interface,
      bootFile: this.rawConfig.bootFile,
      tftpRoot: this.rawConfig.tftpRoot,
      mode,
      serverIP: this.rawConfig.serverIP ?? ifaceConfig.address as IPv4,
      subnetMask: this.rawConfig.subnetMask ?? ifaceConfig.netmask as IPv4,
      router: this.rawConfig.router ?? this.rawConfig.serverIP ?? ifaceConfig.address as IPv4,
      tftpServer: this.rawConfig.tftpServer ?? this.rawConfig.serverIP ?? ifaceConfig.address as IPv4,
      dnsServers: this.rawConfig.dnsServers ?? [],
      dhcp: this.rawConfig.dhcp,
      tftpPort: this.rawConfig.tftpPort ?? 69,
      maxTransfers: this.rawConfig.maxTransfers ?? 16,
      allowWrite: this.rawConfig.allowWrite ?? false,
      reservations: this.rawConfig.reservations ?? [],
      healthPort: this.rawConfig.healthPort ?? 9470,
      httpPort: this.rawConfig.httpPort ?? this.rawConfig.http?.port ?? 0,
      http: this.rawConfig.http,
      mdnsAddress: (this.rawConfig.mdnsAddress ?? this.rawConfig.serverIP) as string | undefined,
      bootFiles: this.rawConfig.bootFiles,
      hooks: this.rawConfig.hooks,
      bootp: this.rawConfig.bootp,
      followSymlinks: this.rawConfig.followSymlinks,
    };

    this.interfaceState = 'up';

    this.log.info(
      `Starting PXE daemon on ${this.config.interface} ` +
      `(mode=${this.config.mode}, boot=${this.config.bootFile}, ` +
      `tftp=${this.config.tftpRoot})`,
    );

    // Start TFTP server (pass pre-resolved config)
    this.tftpServer = new TFTPServer({
      port: this.config.tftpPort,
      root: this.config.tftpRoot,
      iface: ifaceConfig,
      maxTransfers: this.config.maxTransfers,
      allowWrite: this.config.allowWrite,
      hooks: this.config.hooks,
      followSymlinks: this.config.followSymlinks,
    });

    this.tftpServer.on('transfer:start', (transfer: import('../tftp/state.mts').TFTPTransfer) => {
      this.log.info(`TFTP transfer started: ${transfer.filename} → ${transfer.peer.address}:${transfer.peer.port}`);
      this.emit('tftp-start', transfer.filename, `${transfer.peer.address}:${transfer.peer.port}`);
    });

    this.tftpServer.on('transfer:complete', (transfer: import('../tftp/state.mts').TFTPTransfer) => {
      this.log.info(`TFTP transfer complete: ${transfer.filename} → ${transfer.peer.address}:${transfer.peer.port}`);
      this.emit('tftp-end', transfer.filename, `${transfer.peer.address}:${transfer.peer.port}`);
    });

    this.tftpServer.on('transfer:error', (transfer: import('../tftp/state.mts').TFTPTransfer, errorCode: number, errorMessage: string) => {
      this.log.warn(`TFTP transfer error: ${transfer.filename} → ${transfer.peer.address}:${transfer.peer.port}: [${errorCode}] ${errorMessage}`);
      this.emit('tftp-error', transfer.filename, `${transfer.peer.address}:${transfer.peer.port}`, new Error(`[${errorCode}] ${errorMessage}`));
    });

    await this.tftpServer.start();

    // Start DHCP or BOOTP server
    if (this.config.mode === PXEMode.DHCP) {
      this.ipServer = new DHCPServer({
        interface: this.config.interface,
        bootFile: this.config.bootFile,
        serverIP: this.config.serverIP,
        subnetMask: this.config.subnetMask,
        router: this.config.router,
        tftpServer: this.config.tftpServer,
        dnsServers: this.config.dnsServers,
        leaseTime: this.config.dhcp?.leaseTime,
        answerAll: this.config.dhcp?.answerAll,
        bootFiles: this.config.bootFiles,
        hooks: this.config.hooks,
      });

      const dhcp = this.ipServer as DHCPServer;

      // Apply static reservations
      if (this.config.reservations) {
        for (const r of this.config.reservations) {
          dhcp.addReservation(r.mac, r.ip, r.bootFile, r.bootFiles);
        }
      }

      dhcp.on('discover', (mac: MAC, uuid: string | undefined) => {
        this.log.debug(`DHCP discover from ${mac}${uuid ? ` (uuid: ${uuid})` : ''}`);
        this.emit('dhcp-discover', mac, uuid);
      });

      dhcp.on('offer', (mac: MAC, ip: IPv4) => {
        this.log.info(`DHCP offer: ${ip} → ${mac}`);
        this.emit('dhcp-offer', mac, ip);
      });

      dhcp.on('request', (mac: MAC, ip: IPv4) => {
        this.log.debug(`DHCP request: ${mac} → ${ip}`);
        this.emit('dhcp-request', mac, ip);
      });

      dhcp.on('ack', (mac: MAC, ip: IPv4) => {
        this.log.info(`DHCP ack: ${ip} → ${mac}`);
        this.emit('dhcp-ack', mac, ip);
      });
    } else {
      this.ipServer = new BOOTPServer({
        interface: this.config.interface,
        bootFile: this.config.bootFile,
        serverIP: this.config.serverIP,
        subnetMask: this.config.subnetMask,
        router: this.config.router,
        tftpServer: this.config.tftpServer,
        dnsServers: this.config.dnsServers,
        bootFiles: this.config.bootFiles,
        hooks: this.config.hooks,
        allocationLifetime: this.config.bootp?.allocationLifetime,
      });

      const bootp = this.ipServer as BOOTPServer;

      // Apply static reservations
      if (this.config.reservations) {
        for (const r of this.config.reservations) {
          bootp.addReservation(r.mac, r.ip, r.bootFile, r.bootFiles);
        }
      }

      bootp.on('request', (mac: MAC) => {
        this.log.debug(`BOOTP request from ${mac}`);
        this.emit('bootp-request', mac);
      });

      bootp.on('reply', (mac: MAC, ip: IPv4) => {
        this.log.info(`BOOTP reply: ${ip} → ${mac}`);
        this.emit('bootp-reply', mac, ip);
      });
    }

    await this.ipServer.start();

    // Start health check server (if enabled)
    if (this.config.healthPort > 0) {
      this.healthServer = new HealthCheckServer({
        port: this.config.healthPort,
        getStatus: () => this.getHealthStatus(),
      });

      // Register dashboard routes on the health check HTTP server
      registerDashboardRoutes(this.healthServer, () => this.getDashboardStatus());

      await this.healthServer.start();
    }

    // Start HTTP fallback server (if enabled)
    if (this.config.httpPort > 0) {
      this.httpServer = new HTTPServer({
        root: this.config.tftpRoot,
        port: this.config.httpPort,
        host: this.config.http?.host,
        maxFileSize: this.config.http?.maxFileSize,
        followSymlinks: this.config.followSymlinks,
      });
      await this.httpServer.start();
    }

    // Start mDNS advertisement
    if (this.config.mdnsAddress) {
      const mdnsConfig: import('../shared/mdns.mjs').mDNSConfig = {
        tftp: { port: this.config.tftpPort },
        address: this.config.mdnsAddress,
      };
      if (this.httpServer) {
        mdnsConfig.http = { port: this.config.httpPort };
      }
      this.mdns = new mDNSAdvertiser(mdnsConfig);
      this.mdns.start();
    }

    this.running = true;

    // Start passive interface monitor
    this.startInterfaceMonitor();

    this.log.info('PXE daemon ready');
    this.emit('ready');

    onShutdown(() => this.stop());
  }

  /**
   * Stop the PXE daemon gracefully.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.log.info('Shutting down PXE daemon...');

    if (this.interfaceMonitor) {
      clearInterval(this.interfaceMonitor);
      this.interfaceMonitor = null;
    }

    if (this.mdns) {
      this.mdns.stop();
      this.mdns = null;
    }

    if (this.httpServer) {
      await this.httpServer.stop();
      this.httpServer = null;
    }

    if (this.healthServer) {
      await this.healthServer.stop();
      this.healthServer = null;
    }

    if (this.tftpServer) {
      await this.tftpServer.stop();
      this.tftpServer = null;
    }

    if (this.ipServer) {
      await this.ipServer.stop();
      this.ipServer = null;
    }

    this.running = false;
    this.log.info('PXE daemon stopped.');
    this.emit('close');
  }

  // ── Accessors ───────────────────────────────────────────────────

  /** Whether the daemon is running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** The active IP assignment server (DHCP or BOOTP). */
  get activeIPServer(): DHCPServer | BOOTPServer | null {
    return this.ipServer;
  }

  /** The active TFTP server. */
  get activeTFTPServer(): TFTPServer | null {
    return this.tftpServer;
  }

  // ── Interface monitor ──────────────────────────────────────────

  /**
   * Start a passive interface monitor that logs warnings when the
   * interface goes down or its IP changes. No automatic recovery —
   * just surfaces the issue via logging and the health endpoint.
   */
  private startInterfaceMonitor(): void {
    if (this.interfaceMonitor) return;

    this.interfaceMonitor = setInterval(() => {
      const status = getInterfaceStatus(this.config.interface);

      if (status === 'down' || status === 'missing') {
        if (this.interfaceState !== status) {
          this.log.warn(`Interface ${this.config.interface} is ${status} — PXE services degraded`);
          this.interfaceState = status;
        }
        return;
      }

      // Interface is up — check for IP change
      try {
        const current = getInterfaceConfig(this.config.interface);
        if (current.address !== this.config.serverIP) {
          if (this.interfaceState !== 'ip-changed') {
            this.log.warn(
              `Interface ${this.config.interface} IP changed: ` +
              `${this.config.serverIP} → ${current.address} — restart required`,
            );
            this.interfaceState = 'ip-changed';
          }
        } else if (this.interfaceState !== 'up') {
          this.log.info(`Interface ${this.config.interface} recovered`);
          this.interfaceState = 'up';
        }
      } catch {
        // Race: went back down between status check and config read
        if (this.interfaceState !== 'down') {
          this.interfaceState = 'down';
        }
      }
    }, 30_000);
  }

  // ── Health status ────────────────────────────────────────────────

  /**
   * Gather current health status for the health check endpoint.
   */
  private getHealthStatus(): HealthStatus {
    const status: HealthStatus = {
      status: this.running ? (this.interfaceState === 'up' ? 'ok' : 'degraded') : 'down',
      uptime: process.uptime(),
      pid: process.pid,
      version: _version,
      interface: {
        name: this.config.interface,
        status: this.interfaceState,
        address: this.config.serverIP,
      },
    };

    if (this.tftpServer) {
      status.tftp = {
        activeTransfers: this.tftpServer.activeTransfers,
        totalBytes: 0, // TODO: track total bytes across all transfers
      };
    }

    if (this.ipServer && this.ipServer instanceof DHCPServer) {
      status.dhcp = {
        activeLeases: this.ipServer.activeLeases,
        reservations: this.ipServer.getLeases().length,
      };
    }

    if (this.ipServer && this.ipServer instanceof BOOTPServer) {
      status.bootp = {
        allocated: this.ipServer.allocatedCount,
      };
    }

    if (this.httpServer) {
      status.http = { enabled: true };
    }

    return status;
  }

  /**
   * Gather full status for the dashboard API.
   */
  private getDashboardStatus(): DashboardStatus {
    const status: DashboardStatus = {
      status: this.running ? 'ok' : 'down',
      uptime: process.uptime(),
      pid: process.pid,
      version: _version,
      mode: this.config.mode,
      interface: this.config.interface,
      bootFile: this.config.bootFile,
      tftp: null,
      dhcp: null,
      bootp: null,
      http: null,
      mdns: null,
    };

    if (this.tftpServer) {
      status.tftp = {
        activeTransfers: this.tftpServer.activeTransfers,
        transfers: this.tftpServer.getTransfers(),
      };
    }

    if (this.ipServer && this.ipServer instanceof DHCPServer) {
      status.dhcp = {
        activeLeases: this.ipServer.activeLeases,
        leases: this.ipServer.getLeasesJSON(),
        reservations: this.config.reservations.map((r): DashboardReservation => ({
          mac: r.mac,
          ip: r.ip,
          bootFile: r.bootFile,
          hostname: r.hostname,
        })),
      };
    }

    if (this.ipServer && this.ipServer instanceof BOOTPServer) {
      status.bootp = {
        allocated: this.ipServer.allocatedCount,
      };
    }

    if (this.httpServer) {
      status.http = { enabled: true };
    }

    if (this.mdns) {
      status.mdns = { enabled: true };
    }

    return status;
  }
}
