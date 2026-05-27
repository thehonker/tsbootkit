/**
 * mDNS/DNS-SD service advertisement.
 *
 * Announces tsbootkit services on the local network so clients and
 * management tools can discover them via Zeroconf/Bonjour.
 *
 * Advertises:
 *   - `_tftp._udp` — TFTP server
 *   - `_http._tcp` — HTTP fallback server (if enabled)
 *
 * Customizable addresses — the advertised host doesn't have to match
 * the listening address. Useful when the server listens on 0.0.0.0
 * but needs to advertise a specific interface IP, or when running
 * behind a NAT/bridge where the container IP isn't reachable.
 *
 * Example:
 *   mdnsAdvertise({
 *     tftp: { port: 69, host: '192.168.1.1' },
 *     http: { port: 80, host: '192.168.1.1' },
 *   })
 */

import Bonjour, { Service as BonjourService } from 'bonjour-service';

import { createLogger } from './logger.mjs';

// ─── Config ────────────────────────────────────────────────────────

export interface ServiceRecord {
  /** Port the service listens on. */
  port: number;
  /** Host address to advertise (defaults to system hostname). */
  host?: string;
  /** Additional TXT records. */
  txt?: Record<string, string>;
}

export interface mDNSConfig {
  /** TFTP service to advertise. */
  tftp: ServiceRecord;
  /** HTTP fallback service to advertise (omit if HTTP is disabled). */
  http?: ServiceRecord;
  /** Explicit interface address to use for all services. */
  address?: string;
}

// ─── Advertiser ────────────────────────────────────────────────────

export class mDNSAdvertiser {
  private readonly config: mDNSConfig;
  private bonjour: InstanceType<typeof Bonjour> | null = null;
  private services: InstanceType<typeof BonjourService>[] = [];
  private readonly log;

  constructor(config: mDNSConfig) {
    this.config = config;
    this.log = createLogger('mdns');
  }

  /**
   * Start advertising services via mDNS/DNS-SD.
   */
  start(): void {
    this.bonjour = new Bonjour();

    // Advertise TFTP
    const tftpHost = this.config.tftp.host ?? this.config.address;
    this.services.push(
      this.bonjour.publish({
        name: 'tsbootkit-tftp',
        type: 'tftp',
        protocol: 'udp',
        port: this.config.tftp.port,
        host: tftpHost,
        txt: {
          path: '/',
          ...this.config.tftp.txt,
        },
      }),
    );
    this.log.info(
      `Advertising TFTP on ${tftpHost ?? 'hostname'}:${this.config.tftp.port}`,
    );

    // Advertise HTTP fallback (if configured)
    if (this.config.http) {
      const httpHost = this.config.http.host ?? this.config.address;
      this.services.push(
        this.bonjour.publish({
          name: 'tsbootkit-http',
          type: 'http',
          protocol: 'tcp',
          port: this.config.http.port,
          host: httpHost,
          txt: {
            path: '/',
            ...this.config.http.txt,
          },
        }),
      );
      this.log.info(
        `Advertising HTTP on ${httpHost ?? 'hostname'}:${this.config.http.port}`,
      );
    }
  }

  /**
   * Stop advertising and unpublish services.
   */
  stop(): void {
    for (const service of this.services) {
      service.stop();
    }
    this.services = [];

    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }

    this.log.info('mDNS advertisements stopped.');
  }

  /** Get the published services (for status/health). */
  get publishedServices(): ReadonlyArray<{ name: string; type: string; port: number; host?: string }> {
    return this.services
      .filter((s): s is NonNullable<typeof s> => s != null)
      .map((s) => ({
        name: s.name,
        type: s.type,
        port: s.port,
        host: s.host,
      }));
  }
}
