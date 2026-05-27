/**
 * Cross-platform network interface detection.
 *
 * Replaces the 3x-duplicated `get_ip_config_for_iface()` from pTFTPd
 * that used Linux-specific `fcntl.ioctl` calls. Uses `os.networkInterfaces()`
 * instead — works on Linux, macOS, and Windows.
 */

import os from 'node:os';
import { IPv4, MAC, InterfaceConfig, NetworkCIDR } from './types.mjs';

/**
 * Brand a string as IPv4. Does NOT validate — use `isValidIPv4` for that.
 */
function asIPv4(value: string): IPv4 {
  return value as IPv4;
}

/**
 * Brand a string as MAC. Does NOT validate — use `isValidMAC` for that.
 */
function asMAC(value: string): MAC {
  return value as MAC;
}

/**
 * Check whether a string is a valid IPv4 dotted-quad address.
 */
export function isValidIPv4(value: string): value is IPv4 {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return /^\d{1,3}$/.test(p) && n >= 0 && n <= 255;
  });
}

/**
 * Check whether a string is a valid MAC address (colon-separated hex).
 */
export function isValidMAC(value: string): value is MAC {
  return /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(value);
}

/**
 * Convert an IPv4 string to a 32-bit unsigned integer.
 */
export function ipv4ToInt(ip: IPv4): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/**
 * Convert a 32-bit unsigned integer to an IPv4 string.
 */
export function intToIPv4(n: number): IPv4 {
  return asIPv4(`${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`);
}

/**
 * Compute the prefix length from a netmask (e.g. "255.255.255.0" → 24).
 */
export function netmaskToPrefix(netmask: IPv4): number {
  const n = ipv4ToInt(netmask);
  // Count set bits — netmasks are contiguous, so popcount works
  return n.toString(2).split('').filter((c) => c === '1').length;
}

/**
 * Compute a CIDR network block from an IP address and netmask.
 */
export function computeCIDR(address: IPv4, netmask: IPv4): NetworkCIDR {
  const addrInt = ipv4ToInt(address);
  const maskInt = ipv4ToInt(netmask);
  const networkInt = (addrInt & maskInt) >>> 0;
  const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
  const prefix = netmaskToPrefix(netmask);

  return {
    network: intToIPv4(networkInt),
    netmask,
    prefix,
    broadcast: intToIPv4(broadcastInt),
  };
}

/**
 * Get the IP configuration for a specific network interface.
 *
 * @throws {Error} If the interface does not exist or has no IPv4 address.
 */
export function getInterfaceConfig(iface: string): InterfaceConfig {
  const interfaces = os.networkInterfaces();
  const entries = interfaces[iface];

  if (!entries || entries.length === 0) {
    throw new Error(`Unknown network interface: ${iface}`);
  }

  // Find the first IPv4, non-internal entry
  const ipv4Entry = entries.find((e) => e.family === 'IPv4' && !e.internal);

  if (!ipv4Entry) {
    throw new Error(`No IPv4 address found on interface: ${iface}`);
  }

  // MAC from the first entry (same MAC for all addresses on the interface)
  const macEntry = entries[0]!;

  return {
    name: iface,
    address: asIPv4(ipv4Entry.address),
    netmask: asIPv4(ipv4Entry.netmask),
    mac: asMAC(macEntry.mac),
    internal: ipv4Entry.internal,
  };
}

/**
 * List all available network interfaces with IPv4 addresses.
 */
export function listInterfaces(): InterfaceConfig[] {
  const interfaces = os.networkInterfaces();
  const result: InterfaceConfig[] = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;

    const ipv4Entry = entries.find((e) => e.family === 'IPv4' && !e.internal);
    if (!ipv4Entry) continue;

    const macEntry = entries[0]!;

    result.push({
      name,
      address: asIPv4(ipv4Entry.address),
      netmask: asIPv4(ipv4Entry.netmask),
      mac: asMAC(macEntry.mac),
      internal: ipv4Entry.internal,
    });
  }

  return result;
}

/**
 * Generate a random IP address within the network defined by the given
 * interface config, excluding the server's own address, the network
 * address, and the broadcast address.
 *
 * Port of pTFTPd's `generate_free_ip()` — but without the `while True`
 * entropy loop. We pick a random host portion and check constraints.
 */
export function generateRandomIP(config: InterfaceConfig, allocated: Set<IPv4>): IPv4 {
  const serverInt = ipv4ToInt(config.address);
  const maskInt = ipv4ToInt(config.netmask);
  const antiMask = (~maskInt) >>> 0;
  const cidr = computeCIDR(config.address, config.netmask);
  const networkInt = ipv4ToInt(cidr.network);
  const broadcastInt = ipv4ToInt(cidr.broadcast);

  // Maximum attempts to avoid infinite loops on full subnets
  for (let attempt = 0; attempt < 1000; attempt++) {
    const entropy = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const candidate = ((serverInt & maskInt) | (entropy & antiMask)) >>> 0;

    // Skip server address, network address, broadcast, and already-allocated
    if (
      candidate === serverInt ||
      candidate === networkInt ||
      candidate === broadcastInt ||
      allocated.has(intToIPv4(candidate))
    ) {
      continue;
    }

    return intToIPv4(candidate);
  }

  throw new Error(`No available IP addresses on ${config.name} subnet`);
}
