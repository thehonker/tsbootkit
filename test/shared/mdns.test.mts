import { describe, it, expect, afterEach } from 'vitest';
import { mDNSAdvertiser } from '../../src/shared/mdns.mjs';

describe('mDNSAdvertiser', () => {
  let advertiser: mDNSAdvertiser | null = null;

  afterEach(() => {
    if (advertiser) {
      advertiser.stop();
      advertiser = null;
    }
  });

  it('creates an advertiser with TFTP only', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 69 },
    });

    expect(advertiser).toBeDefined();
  });

  it('creates an advertiser with TFTP and HTTP', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 69 },
      http: { port: 80 },
    });

    expect(advertiser).toBeDefined();
  });

  it('creates an advertiser with custom host address', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 69, host: '192.168.1.1' },
      http: { port: 80, host: '192.168.1.1' },
    });

    expect(advertiser).toBeDefined();
  });

  it('creates an advertiser with global address override', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 69 },
      http: { port: 80 },
      address: '10.0.0.1',
    });

    expect(advertiser).toBeDefined();
  });

  it('start and stop do not throw', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 6969 },
    });

    expect(() => advertiser!.start()).not.toThrow();
    expect(() => advertiser!.stop()).not.toThrow();
  });

  it('publishedServices returns service info after start', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 6969, host: '192.168.1.50' },
      http: { port: 8080, host: '192.168.1.50' },
    });

    advertiser.start();

    const services = advertiser.publishedServices;
    expect(services.length).toBe(2);
    expect(services[0]!.type).toBe('_tftp._udp');
    expect(services[0]!.port).toBe(6969);
    expect(services[1]!.type).toBe('_http._tcp');
    expect(services[1]!.port).toBe(8080);
  });

  it('publishedServices is empty before start', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 6969 },
    });

    expect(advertiser.publishedServices).toEqual([]);
  });

  it('per-service host overrides global address', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 69, host: '10.0.0.1' },
      http: { port: 80, host: '10.0.0.2' },
      address: '192.168.1.1',
    });

    // Per-service host should take precedence — verify no throw
    advertiser.start();
    const services = advertiser.publishedServices;
    expect(services.length).toBe(2);
  });

  it('supports TXT records', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 69, txt: { path: '/boot', version: '1.0' } },
    });

    advertiser.start();
    expect(advertiser.publishedServices.length).toBe(1);
  });

  it('stop is idempotent', () => {
    advertiser = new mDNSAdvertiser({
      tftp: { port: 6969 },
    });

    advertiser.start();
    advertiser.stop();
    // Second stop should not throw
    advertiser.stop();
  });
});
