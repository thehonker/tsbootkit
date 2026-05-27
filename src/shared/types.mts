/** Shared type definitions used across tsbootkit. */

/** IPv4 address as a dotted-quad string (e.g. "192.168.1.1"). */
export type IPv4 = string & { readonly __brand: unique symbol };

/** MAC address as a colon-separated hex string (e.g. "aa:bb:cc:dd:ee:ff"). */
export type MAC = string & { readonly __brand: unique symbol };

/** A network interface's IP configuration. */
export interface InterfaceConfig {
  /** Interface name (e.g. "eth0"). */
  name: string;
  /** IPv4 address. */
  address: IPv4;
  /** IPv4 netmask. */
  netmask: IPv4;
  /** MAC address. */
  mac?: MAC;
  /** Whether this interface is internal (loopback). */
  internal: boolean;
}

/** A CIDR-style network (e.g. "192.168.1.0/24"). */
export interface NetworkCIDR {
  /** Network address. */
  network: IPv4;
  /** Netmask. */
  netmask: IPv4;
  /** Prefix length. */
  prefix: number;
  /** Broadcast address. */
  broadcast: IPv4;
}

/** Host/port pair identifying a network peer. */
export interface Peer {
  address: IPv4;
  port: number;
}
