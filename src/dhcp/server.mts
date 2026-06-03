/**
 * PXE-aware DHCP server.
 *
 * A stripped-down DHCP server designed for PXE boot environments.
 * Responds to DHCPDISCOVER with DHCPOFFER and DHCPREQUEST with DHCPACK,
 * providing PXE boot parameters (boot filename, TFTP server).
 *
 * Two modes:
 *   - Standard UDP mode (default): Uses dgram on port 67/68. Cross-platform,
 *     but may require root/admin privileges to bind to port 67.
 *   - Raw socket mode: Builds Ethernet+IP+UDP frames manually. Linux-only
 *     (requires PF_PACKET), but works without a bound socket.
 *
 * Key improvements over pTFTPd:
 *   - Cross-platform UDP mode (pTFTPd was Linux-only)
 *   - Lease tracking with expiration
 *   - Event-driven (no blocking serve_forever loop)
 *   - Structured logging
 *   - Graceful shutdown
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

import { createLogger } from '../shared/logger.mjs';
import { onShutdown } from '../shared/signals.mjs';
import { IPv4, MAC } from '../shared/types.mjs';
import { generateRandomIP, ipv4ToInt } from '../shared/network.mjs';

import {
  DHCPServerConfig,
  DHCPMessageType,
  ClientArchitecture,
  DEFAULT_LEASE_TIME,
  INTERNAL_LEASE_TIME,
  DHCP_SERVER_PORT,
  DHCP_CLIENT_PORT,
} from './types.mjs';
import { parseDHCPPacket, encodeDHCPReply, encodeDHCPNAK, DHCPProtocolError } from './protocol.mjs';
import { resolveBootFile } from '../config.mjs';
import { runHooks, type HookConfig } from '../shared/hooks.mjs';

// ─── Reservation (from config) ──────────────────────────────────────

export interface DHCPReservation {
  ip: IPv4;
  bootFile?: string;
  bootFiles?: import('../config.mts').BootFileMap;
}

// ─── Lease tracking ────────────────────────────────────────────────

interface Lease {
  ip: IPv4;
  mac: MAC;
  expires: number; // Unix timestamp in ms
  uuid?: string;
}

/** A pre-allocated offer awaiting a REQUEST. */
interface Offer {
  ip: IPv4;
  mac: MAC;
  expires: number; // Unix timestamp in ms
}

/** Default TTL for pre-allocated offers (seconds). */
const DEFAULT_OFFER_TTL = 60;

// ─── Server events ─────────────────────────────────────────────────

export interface DHCPServerEvents {
  'discover': (mac: MAC, uuid: string | undefined) => void;
  'offer': (mac: MAC, ip: IPv4) => void;
  'request': (mac: MAC, ip: IPv4) => void;
  'ack': (mac: MAC, ip: IPv4) => void;
  'nak': (mac: MAC, reason: string) => void;
  'listening': () => void;
  'close': () => void;
  'error': (err: Error) => void;
}

// ─── DHCP Server ───────────────────────────────────────────────────

export class DHCPServer extends EventEmitter {
  private readonly rawConfig: DHCPServerConfig;
  private config!: Omit<Required<DHCPServerConfig>, 'bootFiles' | 'hooks'> & { bootFiles?: import('../config.mts').BootFileMap; hooks: HookConfig[] };
  private socket: dgram.Socket | null = null;
  private readonly leases = new Map<IPv4, Lease>();
  private readonly offers = new Map<IPv4, Offer>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private readonly log;
  private readonly allocatedIPs = new Set<IPv4>();
  /** Static MAC → reservation map. */
  private readonly reservations = new Map<MAC, DHCPReservation>();

  constructor(config: DHCPServerConfig) {
    super();
    this.rawConfig = config;
    this.log = createLogger('dhcpd');
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Start the DHCP server.
   *
   * The caller must ensure serverIP, subnetMask, router, and tftpServer
   * are set in the config — interface resolution is the caller's
   * responsibility.
   */
  async start(): Promise<void> {
    const config = this.rawConfig;

    if (!config.serverIP || !config.subnetMask) {
      throw new Error('DHCP server requires serverIP and subnetMask — interface must be resolved before start()');
    }

    this.config = {
      interface: config.interface,
      bootFile: config.bootFile,
      serverIP: config.serverIP,
      subnetMask: config.subnetMask,
      router: config.router ?? config.serverIP,
      tftpServer: config.tftpServer ?? config.serverIP,
      dnsServers: config.dnsServers ?? [],
      leaseTime: config.leaseTime ?? DEFAULT_LEASE_TIME,
      answerAll: config.answerAll ?? false,
      bootFiles: config.bootFiles,
      hooks: config.hooks ?? [],
    };

    this.socket = dgram.createSocket('udp4');
    this.socket.setBroadcast(true);

    this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this.handleMessage(msg, rinfo).catch((err: Error) => {
        this.log.error(`Error processing DHCP message: ${err.message}`);
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
        this.log.info(
          `DHCP server listening on ${this.config.serverIP}:${DHCP_SERVER_PORT}, ` +
          `boot=${this.config.bootFile}, tftp=${this.config.tftpServer}`,
        );
        this.emit('listening');
        resolve();
      });

      this.socket!.on('error', (err: Error) => {
        reject(err);
      });

      this.socket!.bind(DHCP_SERVER_PORT, this.config.serverIP);
    }).then(() => {
      // Start lease garbage collection
      this.startGC();

      // Register for graceful shutdown
      onShutdown(() => this.stop());
    });
  }

  /**
   * Stop the DHCP server gracefully.
   */
  async stop(): Promise<void> {
    this.log.info('Shutting down DHCP server...');

    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.leases.clear();
    this.offers.clear();
    this.allocatedIPs.clear();
    this.reservations.clear();

    this.log.info('DHCP server stopped.');
  }

  // ── Message handling ────────────────────────────────────────────

  private async handleMessage(msg: Buffer, _rinfo: dgram.RemoteInfo): Promise<void> {
    let packet;
    try {
      packet = parseDHCPPacket(msg);
    } catch (err) {
      if (err instanceof DHCPProtocolError) {
        this.log.debug(`Ignoring non-DHCP packet: ${err.message}`);
        return;
      }
      throw err;
    }

    // Only handle DISCOVER and REQUEST
    if (packet.messageType !== DHCPMessageType.DISCOVER && packet.messageType !== DHCPMessageType.REQUEST) {
      return;
    }

    // Check if PXE client
    if (!packet.isPXE && !this.config.answerAll) {
      this.log.info('Ignoring non-PXE DHCP request');
      return;
    }

    // Garbage collect expired leases
    this.gcLeases();

    if (packet.messageType === DHCPMessageType.DISCOVER) {
      this.handleDiscover(packet);
    } else if (packet.messageType === DHCPMessageType.REQUEST) {
      this.handleRequest(packet);
    }
  }

  /**
   * Handle a DHCPDISCOVER message — respond with DHCPOFFER.
   */
  private handleDiscover(packet: import('./types.mts').DHCPPacket): void {
    const ip = this.allocateIP(packet);
    this.allocatedIPs.add(ip); // Pre-allocate to prevent duplicate offers

    // Track the offer so we can reclaim the IP if no REQUEST follows
    this.offers.set(ip, {
      ip,
      mac: packet.chaddr,
      expires: Date.now() + DEFAULT_OFFER_TTL * 1000,
    });
    this.log.info(`Offering ${ip} to ${packet.chaddr} (uuid: ${packet.clientUUID ?? 'not specified'})`);
    this.emit('discover', packet.chaddr, packet.clientUUID);

    if (this.config.hooks.length > 0) {
      runHooks(this.config.hooks, {
        protocol: 'dhcp',
        event: 'discover',
        clientMAC: packet.chaddr,
        hostname: packet.hostname,
      });
    }

    const bootFile = this.getBootFileForMAC(packet.chaddr, packet.clientArch);

    const reply = encodeDHCPReply(
      packet,
      ip,
      this.config.serverIP,
      this.config.tftpServer,
      bootFile,
      DHCPMessageType.OFFER,
      this.config.subnetMask,
      this.config.router,
      this.config.leaseTime,
      this.config.dnsServers,
    );

    this.sendReply(reply);
    this.emit('offer', packet.chaddr, ip);

    if (this.config.hooks.length > 0) {
      runHooks(this.config.hooks, {
        protocol: 'dhcp',
        event: 'offer',
        clientMAC: packet.chaddr,
        offeredIP: ip,
      });
    }
  }

  /**
   * Handle a DHCPREQUEST message — respond with DHCPACK or DHCPNAK.
   */
  private handleRequest(packet: import('./types.mts').DHCPPacket): void {
    // If the client specified a different server, ignore — not our client
    if (packet.serverID && packet.serverID !== this.config.serverIP) {
      this.log.debug(`Ignoring REQUEST for server ${packet.serverID}`);
      return;
    }

    const requestedIP = packet.requestedIP ?? packet.ciaddr;
    let nakReason: string | undefined;

    // Determine the IP and check for NAK conditions
    if (!requestedIP || requestedIP === '0.0.0.0') {
      // No requested IP and no ciaddr — nothing to NAK about, allocate fresh
      nakReason = undefined;
    } else if (!this.isInSubnet(requestedIP)) {
      nakReason = `requested IP ${requestedIP} is outside subnet`;
    } else {
      // Check if the IP is leased to a different MAC
      const existingLease = this.leases.get(requestedIP);
      if (existingLease && existingLease.mac !== packet.chaddr) {
        nakReason = `requested IP ${requestedIP} is leased to ${existingLease.mac}`;
      }
    }

    if (nakReason) {
      this.sendNAK(packet, nakReason);
      return;
    }

    // Allocate or use the requested IP
    let ip: IPv4;
    if (requestedIP && requestedIP !== '0.0.0.0' && !this.allocatedIPs.has(requestedIP) && this.isInSubnet(requestedIP)) {
      ip = requestedIP;
    } else {
      ip = this.allocateIP(packet);
    }

    // Register the lease
    const lease: Lease = {
      ip,
      mac: packet.chaddr,
      expires: Date.now() + INTERNAL_LEASE_TIME * 1000,
      uuid: packet.clientUUID,
    };

    const existingLease = this.findLeaseByMAC(packet.chaddr);
    if (existingLease) {
      this.leases.delete(existingLease.ip);
      this.allocatedIPs.delete(existingLease.ip);
    }

    this.leases.set(ip, lease);
    this.allocatedIPs.add(ip);

    // Offer is now a lease — remove from pending offers
    this.offers.delete(ip);

    this.log.info(`PXE booting ${ip} (uuid: ${packet.clientUUID ?? 'not specified'})`);
    this.emit('request', packet.chaddr, ip);

    if (this.config.hooks.length > 0) {
      runHooks(this.config.hooks, {
        protocol: 'dhcp',
        event: 'request',
        clientMAC: packet.chaddr,
        requestedIP: requestedIP ?? ip,
        hostname: packet.hostname,
      });
    }

    const bootFile = this.getBootFileForMAC(packet.chaddr, packet.clientArch);

    const reply = encodeDHCPReply(
      packet,
      ip,
      this.config.serverIP,
      this.config.tftpServer,
      bootFile,
      DHCPMessageType.ACK,
      this.config.subnetMask,
      this.config.router,
      this.config.leaseTime,
      this.config.dnsServers,
    );

    this.sendReply(reply);
    this.emit('ack', packet.chaddr, ip);

    if (this.config.hooks.length > 0) {
      runHooks(this.config.hooks, {
        protocol: 'dhcp',
        event: 'ack',
        clientMAC: packet.chaddr,
        assignedIP: ip,
        hostname: packet.hostname,
      });
    }
  }

  // ── IP allocation ───────────────────────────────────────────────

  /**
   * Allocate a free IP address for a client.
   */
  private allocateIP(packet: import('./types.mts').DHCPPacket): IPv4 {
    // Check for a static reservation first
    const reservation = this.reservations.get(packet.chaddr);
    if (reservation) {
      this.log.debug(`Using reserved IP ${reservation.ip} for ${packet.chaddr}`);
      return reservation.ip;
    }

    // Check if this MAC already has a lease
    const existingLease = this.findLeaseByMAC(packet.chaddr);
    if (existingLease) {
      return existingLease.ip;
    }

    // Generate a random free IP in the server's subnet
    const ip = generateRandomIP(
      {
        name: this.config.interface,
        address: this.config.serverIP,
        netmask: this.config.subnetMask,
        internal: false,
      },
      this.allocatedIPs,
    );

    return ip;
  }

  /**
   * Find an existing lease by MAC address.
   */
  private findLeaseByMAC(mac: MAC): Lease | undefined {
    for (const lease of this.leases.values()) {
      if (lease.mac === mac) return lease;
    }
    return undefined;
  }

  /**
   * Check whether an IP is within the server's configured subnet.
   */
  private isInSubnet(ip: IPv4): boolean {
    const ipInt = ipv4ToInt(ip);
    const netInt = ipv4ToInt(this.config.serverIP);
    const maskInt = ipv4ToInt(this.config.subnetMask);
    return (ipInt & maskInt) === (netInt & maskInt);
  }

  // ── Packet sending ──────────────────────────────────────────────

  /**
   * Send a DHCP reply packet.
   *
   * Broadcasts to 255.255.255.255:68 since the client doesn't have an IP yet.
   */
  private sendReply(reply: Buffer): void {
    if (!this.socket) return;

    this.socket.send(reply, DHCP_CLIENT_PORT, '255.255.255.255', (err) => {
      if (err) {
        this.log.error(`Failed to send DHCP reply: ${err.message}`);
      }
    });
  }

  /**
   * Send a DHCPNAK to the client.
   */
  private sendNAK(packet: import('./types.mts').DHCPPacket, reason: string): void {
    this.log.warn(`NAK to ${packet.chaddr}: ${reason}`);
    this.emit('nak', packet.chaddr, reason);

    if (this.config.hooks.length > 0) {
      runHooks(this.config.hooks, {
        protocol: 'dhcp',
        event: 'nak',
        clientMAC: packet.chaddr,
        reason,
      });
    }

    const reply = encodeDHCPNAK(packet, this.config.serverIP, reason);
    this.sendReply(reply);
  }

  // ── Lease garbage collection ────────────────────────────────────

  /**
   * Start the lease garbage collection timer.
   */
  private startGC(): void {
    if (this.gcTimer) return;

    this.gcTimer = setInterval(() => {
      this.gcLeases();
    }, 60_000); // Run every minute
  }

  /**
   * Remove expired leases and offers.
   */
  private gcLeases(): void {
    const now = Date.now();
    let cleaned = 0;

    // Clean expired offers (DISCOVER with no follow-up REQUEST)
    for (const [ip, offer] of this.offers) {
      if (offer.expires <= now) {
        this.log.debug(`Offer for ${ip} expired (no REQUEST from ${offer.mac})`);
        this.offers.delete(ip);
        // Only free the IP if no lease claimed it
        if (!this.leases.has(ip)) {
          this.allocatedIPs.delete(ip);
        }
        cleaned++;
      }
    }

    // Clean expired leases
    for (const [ip, lease] of this.leases) {
      if (lease.expires <= now) {
        this.log.info(`Lease on ${ip} expired`);
        this.leases.delete(ip);
        this.allocatedIPs.delete(ip);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.log.debug(`Garbage collected ${cleaned} expired lease(s)`);
    }
  }

  // ── Status ──────────────────────────────────────────────────────

  /** Get the number of active leases. */
  get activeLeases(): number {
    return this.leases.size;
  }

  /** Get a snapshot of current leases. */
  getLeases(): ReadonlyArray<Readonly<Lease>> {
    return Array.from(this.leases.values());
  }

  /** Get a serializable snapshot of leases for the dashboard API. */
  getLeasesJSON(): Array<{
    ip: string;
    mac: string;
    expires: number;
    uuid?: string;
  }> {
    return Array.from(this.leases.values()).map((l) => ({
      ip: l.ip,
      mac: l.mac,
      expires: l.expires,
      uuid: l.uuid,
    }));
  }

  // ── Reservations ────────────────────────────────────────────────

  /**
   * Add a static MAC → IP reservation.
   * Reserved IPs are always offered to their MAC, never to others.
   */
  addReservation(mac: MAC, ip: IPv4, bootFile?: string, bootFiles?: import('../config.mts').BootFileMap): void {
    this.reservations.set(mac, { ip, bootFile, bootFiles });
    // Pre-allocate the IP so random allocation doesn't hand it out
    this.allocatedIPs.add(ip);
    this.log.info(`Reservation added: ${mac} → ${ip}${bootFile ? ` (boot: ${bootFile})` : ''}`);
  }

  /**
   * Get the boot file for a MAC, checking reservations first, then architecture.
   */
  /**
   * Get the boot file for a MAC, checking reservations first, then architecture.
   */
  getBootFileForMAC(mac: MAC, arch?: ClientArchitecture): string {
    const reservation = this.reservations.get(mac);
    return resolveBootFile(reservation, this.config.bootFiles, this.config.bootFile, arch);
  }
}
