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
import { IPv4, MAC, type InterfaceConfig } from '../shared/types.mjs';
import { getInterfaceConfig } from '../shared/network.mjs';
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
  private readonly config: {
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
  private readonly log;
  private running = false;

  constructor(config: PXEServerConfig) {
    super();

    // Resolve interface config — always needed for MAC address
    let ifaceConfig: InterfaceConfig | null = null;
    try {
      ifaceConfig = getInterfaceConfig(config.interface);
    } catch {
      // Interface exists but is internal (loopback) — MAC not available
    }
    const mode = config.mode ?? PXEMode.DHCP;

    this.config = {
      interface: config.interface,
      bootFile: config.bootFile,
      tftpRoot: config.tftpRoot,
      mode,
      serverIP: config.serverIP ?? ifaceConfig?.address as IPv4,
      subnetMask: config.subnetMask ?? ifaceConfig?.netmask as IPv4,
      router: config.router ?? config.serverIP ?? ifaceConfig?.address as IPv4,
      tftpServer: config.tftpServer ?? config.serverIP ?? ifaceConfig?.address as IPv4,
      dnsServers: config.dnsServers ?? [],
      dhcp: config.dhcp,
      tftpPort: config.tftpPort ?? 69,
      maxTransfers: config.maxTransfers ?? 16,
      allowWrite: config.allowWrite ?? false,
      reservations: config.reservations ?? [],
      healthPort: config.healthPort ?? 9470,
      httpPort: config.httpPort ?? config.http?.port ?? 0,
      http: config.http,
      mdnsAddress: (config.mdnsAddress ?? config.serverIP) as string | undefined,
      bootFiles: config.bootFiles,
      hooks: config.hooks,
      bootp: config.bootp,
      followSymlinks: config.followSymlinks,
    };

    this.log = createLogger('pxed');
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Start the PXE daemon (TFTP + DHCP/BOOTP).
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('PXE server is already running');
    }

    this.log.info(
      `Starting PXE daemon on ${this.config.interface} ` +
      `(mode=${this.config.mode}, boot=${this.config.bootFile}, ` +
      `tftp=${this.config.tftpRoot})`,
    );

    // Start TFTP server
    this.tftpServer = new TFTPServer({
      port: this.config.tftpPort,
      root: this.config.tftpRoot,
      interface: this.config.interface,
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

  // ── Health status ────────────────────────────────────────────────

  /**
   * Gather current health status for the health check endpoint.
   */
  private getHealthStatus(): HealthStatus {
    const status: HealthStatus = {
      status: this.running ? 'ok' : 'down',
      uptime: process.uptime(),
      pid: process.pid,
      version: _version,
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
