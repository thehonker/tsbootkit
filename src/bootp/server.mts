/**
 * BOOTP server (RFC951).
 *
 * A minimal BOOTP server for PXE boot environments.
 * BOOTP is the predecessor to DHCP — same wire format, but no lease
 * negotiation, no options negotiation, just request → reply.
 *
 * Reuses the DHCP packet parser since the wire format is identical.
 * The only difference: no DHCP Message Type option in replies.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';

import { createLogger } from '../shared/logger.mjs';
import { onShutdown } from '../shared/signals.mjs';
import { IPv4, MAC } from '../shared/types.mjs';
import { generateRandomIP } from '../shared/network.mjs';
import { parseDHCPPacket, DHCPProtocolError } from '../dhcp/protocol.mjs';

import { BOOTPServerConfig, BOOTP_SERVER_PORT, BOOTP_CLIENT_PORT } from './types.mjs';
import { encodeBOOTPReply } from './protocol.mjs';
import { resolveBootFile } from '../config.mjs';
import type { BootFileMap } from '../config.mjs';
import { ClientArchitecture } from '../dhcp/types.mjs';
import { runHooks } from '../shared/hooks.mjs';

// ─── Reservation (from config) ──────────────────────────────────────

export interface BOOTPReservation {
  ip: IPv4;
  bootFile?: string;
  bootFiles?: BootFileMap;
}

// ─── Allocation tracking ────────────────────────────────────────────

interface Allocation {
  ip: IPv4;
  lastSeen: number; // Unix timestamp in ms
}

// ─── Server events ─────────────────────────────────────────────────

export interface BOOTPServerEvents {
  'request': (mac: MAC) => void;
  'reply': (mac: MAC, ip: IPv4) => void;
  'listening': () => void;
  'close': () => void;
  'error': (err: Error) => void;
}

// ─── BOOTP Server ──────────────────────────────────────────────────

export class BOOTPServer extends EventEmitter {
  private readonly rawConfig: BOOTPServerConfig;
  private config!: Omit<Required<BOOTPServerConfig>, 'bootFiles' | 'hooks' | 'allocationLifetime'> & { bootFiles?: BootFileMap; hooks: import('../shared/hooks.mjs').HookConfig[]; allocationLifetime?: number };
  private socket: dgram.Socket | null = null;
  private readonly allocatedIPs = new Set<IPv4>();
  private readonly allocations = new Map<MAC, Allocation>();
  private readonly reservations = new Map<MAC, BOOTPReservation>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private readonly log;
  private readonly hostname: string;

  private static readonly DEFAULT_ALLOCATION_LIFETIME = 86_400; // 24 hours in seconds
  private static readonly GC_INTERVAL = 60_000; // 1 minute

  constructor(config: BOOTPServerConfig) {
    super();

    this.rawConfig = config;
    this.hostname = os.hostname();
    this.log = createLogger('bootpd');
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    const config = this.rawConfig;

    if (!config.serverIP || !config.subnetMask) {
      throw new Error('BOOTP server requires serverIP and subnetMask — interface must be resolved before start()');
    }

    this.config = {
      interface: config.interface,
      bootFile: config.bootFile,
      serverIP: config.serverIP,
      subnetMask: config.subnetMask,
      router: config.router ?? config.serverIP,
      tftpServer: config.tftpServer ?? config.serverIP,
      dnsServers: config.dnsServers ?? [],
      bootFiles: config.bootFiles,
      hooks: config.hooks ?? [],
      allocationLifetime: config.allocationLifetime ?? BOOTPServer.DEFAULT_ALLOCATION_LIFETIME,
    };

    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg: Buffer) => {
      this.handleMessage(msg).catch((err: Error) => {
        this.log.error(`Error processing BOOTP message: ${err.message}`);
      });
    });

    this.socket.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      this.emit('close');
    });

    return new Promise<void>((resolve, reject) => {
      this.socket!.on('listening', () => {
        this.socket!.setBroadcast(true);
        this.log.info(
          `BOOTP server listening on ${this.config.serverIP}:${BOOTP_SERVER_PORT}, ` +
          `boot=${this.config.bootFile}, tftp=${this.config.tftpServer}`,
        );
        this.emit('listening');
        resolve();
      });

      this.socket!.on('error', (err: Error) => {
        reject(err);
      });

      this.socket!.bind(BOOTP_SERVER_PORT, this.config.serverIP);
    }).then(() => {
      this.startGC();
      onShutdown(() => this.stop());
    });
  }

  async stop(): Promise<void> {
    this.log.info('Shutting down BOOTP server...');

    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.allocatedIPs.clear();
    this.allocations.clear();
    this.log.info('BOOTP server stopped.');
  }

  // ── Message handling ────────────────────────────────────────────

  private async handleMessage(msg: Buffer): Promise<void> {
    let packet;
    try {
      packet = parseDHCPPacket(msg);
    } catch (err) {
      if (err instanceof DHCPProtocolError) {
        this.log.debug(`Ignoring non-BOOTP packet: ${err.message}`);
        return;
      }
      throw err;
    }

    // BOOTP requests have op=1 (BOOTREQUEST) and no DHCP Message Type option
    if (packet.op !== 1) return;

    // If there's a DHCP Message Type option, it's a DHCP packet, not BOOTP
    if (packet.messageType !== undefined) return;

    // If sname is set and doesn't match our hostname, ignore
    if (packet.sname && packet.sname !== this.hostname) {
      this.log.debug(`Ignoring BOOTP request for server "${packet.sname}"`);
      return;
    }

    this.handleBOOTPRequest(packet);
  }

  private handleBOOTPRequest(packet: import('../dhcp/types.mts').DHCPPacket): void {
    // Allocate an IP
    const ip = this.allocateIP(packet.chaddr);
    this.allocatedIPs.add(ip);

    // Track allocation with last-seen timestamp
    const existing = this.allocations.get(packet.chaddr);
    if (existing) {
      existing.lastSeen = Date.now();
    } else {
      this.allocations.set(packet.chaddr, { ip, lastSeen: Date.now() });
    }

    const bootFile = this.getBootFileForMAC(packet.chaddr, packet.clientArch);

    this.log.info(`BOOTP reply: ${ip} → ${packet.chaddr}, file=${bootFile}`);
    this.emit('request', packet.chaddr);

    if (this.config.hooks.length > 0) {
      runHooks(this.config.hooks, {
        protocol: 'bootp',
        event: 'request',
        clientMAC: packet.chaddr,
      });
    }

    const reply = encodeBOOTPReply(
      packet,
      ip,
      this.config.serverIP,
      this.config.tftpServer,
      bootFile,
      this.hostname,
      this.config.subnetMask,
      this.config.router,
      this.config.dnsServers,
    );

    this.sendReply(reply, packet);
    this.emit('reply', packet.chaddr, ip);

    if (this.config.hooks.length > 0) {
      runHooks(this.config.hooks, {
        protocol: 'bootp',
        event: 'reply',
        clientMAC: packet.chaddr,
        assignedIP: ip,
      });
    }
  }

  // ── IP allocation ───────────────────────────────────────────────

  private allocateIP(mac: MAC): IPv4 {
    // Check for a static reservation first
    const reservation = this.reservations.get(mac);
    if (reservation) {
      this.log.debug(`Using reserved IP ${reservation.ip} for ${mac}`);
      return reservation.ip;
    }

    return generateRandomIP(
      {
        name: this.config.interface,
        address: this.config.serverIP,
        netmask: this.config.subnetMask,
        internal: false,
      },
      this.allocatedIPs,
    );
  }

  // ── Packet sending ──────────────────────────────────────────────

  /**
   * Send a BOOTP reply.
   *
   * Per RFC951 §7: unicast to the client if it has a known IP (ciaddr),
   * otherwise broadcast to 255.255.255.255.
   */
  private sendReply(reply: Buffer, packet: import('../dhcp/types.mts').DHCPPacket): void {
    if (!this.socket) return;

    const clientIP = packet.ciaddr;
    const useBroadcast = !clientIP || clientIP === '0.0.0.0';
    const target = useBroadcast ? '255.255.255.255' : clientIP;

    if (useBroadcast) {
      this.log.debug('Broadcasting BOOTP reply (client has no IP)');
    } else {
      this.log.debug(`Unicasting BOOTP reply to ${clientIP}`);
    }

    this.socket.send(reply, BOOTP_CLIENT_PORT, target, (err) => {
      if (err) {
        this.log.error(`Failed to send BOOTP reply: ${err.message}`);
      }
    });
  }

  // ── Allocation garbage collection ────────────────────────────────

  private startGC(): void {
    if (this.gcTimer) return;

    this.gcTimer = setInterval(() => {
      this.gcAllocations();
    }, BOOTPServer.GC_INTERVAL);
  }

  /** Reclaim allocations whose MAC hasn't been seen within allocationLifetime. */
  private gcAllocations(): void {
    const lifetimeMs = (this.config.allocationLifetime ?? BOOTPServer.DEFAULT_ALLOCATION_LIFETIME) * 1000;
    const now = Date.now();
    let cleaned = 0;

    for (const [mac, alloc] of this.allocations) {
      if (now - alloc.lastSeen >= lifetimeMs) {
        this.log.info(`Allocation for ${mac} expired (IP ${alloc.ip})`);
        this.allocations.delete(mac);
        this.allocatedIPs.delete(alloc.ip);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.log.debug(`Garbage collected ${cleaned} expired allocation(s)`);
    }
  }

  // ── Reservations ────────────────────────────────────────────────

  /**
   * Add a static MAC → IP reservation.
   */
  addReservation(mac: MAC, ip: IPv4, bootFile?: string, bootFiles?: BootFileMap): void {
    this.reservations.set(mac, { ip, bootFile, bootFiles });
    this.allocatedIPs.add(ip);
    this.log.info(`Reservation added: ${mac} → ${ip}${bootFile ? ` (boot: ${bootFile})` : ''}`);
  }

  /**
   * Get the boot file for a MAC, checking reservations first, then architecture.
   */
  getBootFileForMAC(mac: MAC, arch?: ClientArchitecture): string {
    const reservation = this.reservations.get(mac);
    return resolveBootFile(reservation, this.config.bootFiles, this.config.bootFile, arch);
  }

  // ── Status ──────────────────────────────────────────────────────

  /** Get the number of allocated IPs. */
  get allocatedCount(): number {
    return this.allocatedIPs.size;
  }
}
