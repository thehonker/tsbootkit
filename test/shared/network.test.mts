import { describe, it, expect } from 'vitest';
import {
  isValidIPv4,
  isValidMAC,
  ipv4ToInt,
  intToIPv4,
  netmaskToPrefix,
  computeCIDR,
  getInterfaceConfig,
  listInterfaces,
  generateRandomIP,
} from '../../src/shared/network.mjs';
import { IPv4 } from '../../src/shared/types.mjs';

describe('isValidIPv4', () => {
  it('accepts valid IPv4 addresses', () => {
    expect(isValidIPv4('192.168.1.1')).toBe(true);
    expect(isValidIPv4('0.0.0.0')).toBe(true);
    expect(isValidIPv4('255.255.255.255')).toBe(true);
    expect(isValidIPv4('10.0.0.1')).toBe(true);
  });

  it('rejects invalid IPv4 addresses', () => {
    expect(isValidIPv4('')).toBe(false);
    expect(isValidIPv4('1.2.3')).toBe(false);
    expect(isValidIPv4('1.2.3.4.5')).toBe(false);
    expect(isValidIPv4('256.1.1.1')).toBe(false);
    expect(isValidIPv4('1.2.3.abc')).toBe(false);
    expect(isValidIPv4('1.2.3.-1')).toBe(false);
  });
});

describe('isValidMAC', () => {
  it('accepts valid MAC addresses', () => {
    expect(isValidMAC('aa:bb:cc:dd:ee:ff')).toBe(true);
    expect(isValidMAC('00:00:00:00:00:00')).toBe(true);
    expect(isValidMAC('FF:FF:FF:FF:FF:FF')).toBe(true);
  });

  it('rejects invalid MAC addresses', () => {
    expect(isValidMAC('')).toBe(false);
    expect(isValidMAC('aa:bb:cc:dd:ee')).toBe(false);
    expect(isValidMAC('aa-bb-cc-dd-ee-ff')).toBe(false);
    expect(isValidMAC('gg:hh:ii:jj:kk:ll')).toBe(false);
  });
});

describe('ipv4ToInt / intToIPv4', () => {
  it('converts IPv4 to integer and back', () => {
    expect(ipv4ToInt('192.168.1.1' as IPv4)).toBe(0xc0a80101);
    expect(intToIPv4(0xc0a80101)).toBe('192.168.1.1');
  });

  it('handles boundary values', () => {
    expect(ipv4ToInt('0.0.0.0' as IPv4)).toBe(0);
    expect(intToIPv4(0)).toBe('0.0.0.0');
    expect(ipv4ToInt('255.255.255.255' as IPv4)).toBe(0xffffffff);
    expect(intToIPv4(0xffffffff)).toBe('255.255.255.255');
  });

  it('round-trips all special addresses', () => {
    const cases = ['10.0.0.1', '172.16.0.1', '127.0.0.1', '224.0.0.1'] as IPv4[];
    for (const ip of cases) {
      expect(intToIPv4(ipv4ToInt(ip))).toBe(ip);
    }
  });
});

describe('netmaskToPrefix', () => {
  it('converts common netmasks', () => {
    expect(netmaskToPrefix('255.255.255.0' as IPv4)).toBe(24);
    expect(netmaskToPrefix('255.255.0.0' as IPv4)).toBe(16);
    expect(netmaskToPrefix('255.0.0.0' as IPv4)).toBe(8);
    expect(netmaskToPrefix('255.255.255.252' as IPv4)).toBe(30);
    expect(netmaskToPrefix('0.0.0.0' as IPv4)).toBe(0);
    expect(netmaskToPrefix('255.255.255.255' as IPv4)).toBe(32);
  });
});

describe('computeCIDR', () => {
  it('computes /24 CIDR correctly', () => {
    const cidr = computeCIDR('192.168.1.100' as IPv4, '255.255.255.0' as IPv4);
    expect(cidr.network).toBe('192.168.1.0');
    expect(cidr.broadcast).toBe('192.168.1.255');
    expect(cidr.prefix).toBe(24);
  });

  it('computes /16 CIDR correctly', () => {
    const cidr = computeCIDR('10.20.30.40' as IPv4, '255.255.0.0' as IPv4);
    expect(cidr.network).toBe('10.20.0.0');
    expect(cidr.broadcast).toBe('10.20.255.255');
    expect(cidr.prefix).toBe(16);
  });

  it('computes /30 CIDR correctly', () => {
    const cidr = computeCIDR('192.168.1.1' as IPv4, '255.255.255.252' as IPv4);
    expect(cidr.network).toBe('192.168.1.0');
    expect(cidr.broadcast).toBe('192.168.1.3');
    expect(cidr.prefix).toBe(30);
  });
});

describe('getInterfaceConfig', () => {
  it('throws for a non-existent interface', () => {
    expect(() => getInterfaceConfig('nonexistent0')).toThrow(/unknown network interface/i);
  });

  it('returns valid config for the first available interface', () => {
    const ifaces = listInterfaces();
    if (ifaces.length === 0) return; // skip if no external interfaces
    const config = getInterfaceConfig(ifaces[0]!.name);
    expect(config.name).toBe(ifaces[0]!.name);
    expect(isValidIPv4(config.address)).toBe(true);
    expect(isValidIPv4(config.netmask)).toBe(true);
    expect(isValidMAC(config.mac)).toBe(true);
  });
});

describe('listInterfaces', () => {
  it('returns at least one interface', () => {
    const ifaces = listInterfaces();
    expect(ifaces.length).toBeGreaterThan(0);
  });

  it('all entries have valid fields', () => {
    const ifaces = listInterfaces();
    for (const iface of ifaces) {
      expect(isValidIPv4(iface.address)).toBe(true);
      expect(isValidIPv4(iface.netmask)).toBe(true);
      expect(isValidMAC(iface.mac)).toBe(true);
      expect(iface.name).toBeTruthy();
    }
  });
});

describe('generateRandomIP', () => {
  it('generates an IP in the correct subnet', () => {
    // Use a synthetic config, not from a real interface
    const testConfig = {
      name: 'test',
      address: '192.168.1.1' as IPv4,
      netmask: '255.255.255.0' as IPv4,
      mac: '00:00:00:00:00:00' as const as import('../../src/shared/types.mjs').MAC,
      internal: false,
    };
    const allocated = new Set<IPv4>();

    const ip = generateRandomIP(testConfig, allocated);
    expect(ip).toMatch(/^192\.168\.1\.\d+$/);
    expect(ip).not.toBe('192.168.1.1'); // not the server
  });

  it('does not generate the network address', () => {
    const testConfig = {
      name: 'test',
      address: '10.0.0.1' as IPv4,
      netmask: '255.255.255.0' as IPv4,
      mac: '00:00:00:00:00:00' as const as import('../../src/shared/types.mjs').MAC,
      internal: false,
    };
    const allocated = new Set<IPv4>();

    for (let i = 0; i < 50; i++) {
      const ip = generateRandomIP(testConfig, allocated);
      expect(ip).not.toBe('10.0.0.0');
    }
  });

  it('does not generate the broadcast address', () => {
    const testConfig = {
      name: 'test',
      address: '10.0.0.1' as IPv4,
      netmask: '255.255.255.0' as IPv4,
      mac: '00:00:00:00:00:00' as const as import('../../src/shared/types.mjs').MAC,
      internal: false,
    };
    const allocated = new Set<IPv4>();

    for (let i = 0; i < 50; i++) {
      const ip = generateRandomIP(testConfig, allocated);
      expect(ip).not.toBe('10.0.0.255');
    }
  });

  it('does not generate already-allocated IPs', () => {
    const testConfig = {
      name: 'test',
      address: '192.168.1.1' as IPv4,
      netmask: '255.255.255.0' as IPv4,
      mac: '00:00:00:00:00:00' as const as import('../../src/shared/types.mjs').MAC,
      internal: false,
    };

    // Allocate most of the subnet to force collision checking
    const allocated = new Set<IPv4>();
    for (let i = 2; i < 200; i++) {
      allocated.add(`192.168.1.${i}` as IPv4);
    }

    for (let i = 0; i < 20; i++) {
      const ip = generateRandomIP(testConfig, allocated);
      expect(allocated.has(ip)).toBe(false);
    }
  });
});
