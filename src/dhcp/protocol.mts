/**
 * DHCP packet codec.
 *
 * Encodes and decodes DHCP packets using Node.js Buffers.
 * Supports both raw Ethernet+IP+UDP frames (Linux PF_PACKET mode)
 * and standard UDP mode (cross-platform).
 *
 * Key improvements over pTFTPd:
 *   - Buffer-based instead of struct.pack/unpack
 *   - Proper DHCP option parsing with Map
 *   - PXE client detection
 *   - IP/UDP checksum computation (pTFTPd skipped it)
 *   - Standard UDP mode as primary (not PF_PACKET)
 */

import {
  DHCPMessageType,
  DHCPOption,
  DHCPPacket,
  RawDHCPOption,
  DHCP_MAGIC_COOKIE,
  CLIENT_UUID_LENGTH,
  DHCP_FIXED_SIZE,
  MIN_DHCP_PACKET_SIZE,
  DHCP_SERVER_PORT,
  DHCP_CLIENT_PORT,
} from './types.mjs';
import { IPv4, MAC } from '../shared/types.mjs';
import { writeIPv4, writeMAC, encodeOptions } from '../shared/encoding.mjs';

// ─── Protocol error ────────────────────────────────────────────────

export class DHCPProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DHCPProtocolError';
  }
}

// ─── IP/Buffer helpers ─────────────────────────────────────────────

/**
 * Read a 4-byte big-endian buffer as an IPv4 dotted-quad string.
 */
function readIPv4(buf: Buffer, offset: number): IPv4 {
  return `${buf[offset]!}.${buf[offset + 1]!}.${buf[offset + 2]!}.${buf[offset + 3]!}` as IPv4;
}

/**
 * Write an IPv4 dotted-quad string into a 4-byte big-endian buffer.
 */
/**
 * Read a 6-byte buffer as a MAC address string.
 */
function readMAC(buf: Buffer, offset: number): MAC {
  const parts: string[] = [];
  for (let i = 0; i < 6; i++) {
    parts.push(buf[offset + i]!.toString(16).padStart(2, '0'));
  }
  return parts.join(':') as MAC;
}

/**
 * Convert an IPv4 string to a 4-byte Buffer.
 */
export function ipv4ToBuffer(ip: IPv4): Buffer {
  const buf = Buffer.alloc(4);
  writeIPv4(buf, 0, ip);
  return buf;
}

// ─── Option parsing ────────────────────────────────────────────────

/**
 * Parse DHCP options from a buffer.
 * Returns a Map of option code → RawDHCPOption.
 */
function parseOptions(buf: Buffer, offset: number, length: number): Map<DHCPOption, RawDHCPOption> {
  const options = new Map<DHCPOption, RawDHCPOption>();
  let i = offset;
  const end = offset + length;

  while (i < end) {
    const code = buf[i]! as DHCPOption;
    i++;

    // Pad option
    if (code === DHCPOption.Pad) continue;

    // End option
    if (code === DHCPOption.End) break;

    // Options must have a length byte
    if (i >= end) break;

    const dataLen = buf[i]!;
    i++;

    if (i + dataLen > end) break;

    const data = Buffer.from(buf.subarray(i, i + dataLen));
    options.set(code, { code, data });
    i += dataLen;
  }

  return options;
}

/**
 * Encode DHCP options into a buffer.
 */
// ─── Packet parsing ────────────────────────────────────────────────

/**
 * Parse a raw DHCP packet from a UDP payload.
 *
 * @param buf - The UDP payload (DHCP packet, no Ethernet/IP/UDP headers).
 * @returns Parsed DHCP packet, or throws DHCPProtocolError.
 */
export function parseDHCPPacket(buf: Buffer): DHCPPacket {
  if (buf.length < MIN_DHCP_PACKET_SIZE) {
    throw new DHCPProtocolError(`DHCP packet too short: ${buf.length} bytes (minimum ${MIN_DHCP_PACKET_SIZE})`);
  }

  const op = buf[0]!;
  const htype = buf[1]!;
  const hlen = buf[2]!;
  const hops = buf[3]!;
  const xid = buf.readUInt32BE(4);
  const secs = buf.readUInt16BE(8);
  const flags = buf.readUInt16BE(10);
  const ciaddr = readIPv4(buf, 12);
  const yiaddr = readIPv4(buf, 16);
  const siaddr = readIPv4(buf, 20);
  const giaddr = readIPv4(buf, 24);
  const chaddr = readMAC(buf, 28);
  const sname = buf.subarray(44, 108).toString('ascii').replace(/\0+$/, '');
  const file = buf.subarray(108, 236).toString('ascii').replace(/\0+$/, '');

  // Magic cookie
  const cookie = buf.readUInt32BE(236);
  if (cookie !== DHCP_MAGIC_COOKIE) {
    throw new DHCPProtocolError(`Invalid DHCP magic cookie: 0x${cookie.toString(16)}`);
  }

  // Parse options
  const options = parseOptions(buf, DHCP_FIXED_SIZE + 4, buf.length - DHCP_FIXED_SIZE - 4);

  // Extract key options
  let messageType: DHCPMessageType | undefined;
  let isPXE = false;
  let requestedIP: IPv4 | undefined;
  let clientUUID: string | undefined;

  const msgTypeOpt = options.get(DHCPOption.MessageType);
  if (msgTypeOpt && msgTypeOpt.data.length >= 1) {
    messageType = msgTypeOpt.data[0]! as DHCPMessageType;
  }

  const vendorClassOpt = options.get(DHCPOption.VendorClassID);
  if (vendorClassOpt) {
    const vendorClass = vendorClassOpt.data.toString('ascii');
    if (vendorClass.startsWith('PXEClient')) {
      isPXE = true;
    }
  }

  const reqIPOpt = options.get(DHCPOption.RequestedIP);
  if (reqIPOpt && reqIPOpt.data.length === 4) {
    requestedIP = readIPv4(reqIPOpt.data, 0);
  }

  // Client UUID (option 61 or 97)
  const uuidOpt = options.get(DHCPOption.ClientUUID) ?? options.get(DHCPOption.ClientUUID2);
  if (uuidOpt && uuidOpt.data.length === CLIENT_UUID_LENGTH + 1) {
    // First byte is type, remaining 16 are UUID
    const uuidBytes = uuidOpt.data.subarray(1);
    const fields = Array.from(uuidBytes).map((b) => b.toString(16).padStart(2, '0'));
    clientUUID = `${fields.slice(0, 4).join('')}-${fields.slice(4, 6).join('')}-${fields.slice(6, 8).join('')}-${fields.slice(8, 10).join('')}-${fields.slice(10, 16).join('')}`;
  }

  // Client architecture (option 93, RFC4578)
  let clientArch: import('./types.mts').ClientArchitecture | undefined;
  const archOpt = options.get(DHCPOption.ClientArch);
  if (archOpt && archOpt.data.length >= 2) {
    clientArch = archOpt.data.readUInt16BE(0) as import('./types.mts').ClientArchitecture;
  }

  // Client hostname (option 12, RFC1533 §3.14)
  let hostname: string | undefined;
  const hostnameOpt = options.get(DHCPOption.Hostname);
  if (hostnameOpt && hostnameOpt.data.length > 0) {
    hostname = hostnameOpt.data.toString('ascii').trim();
  }

  // Server identifier (option 54) — present in DHCPREQUEST to indicate which server the client selected
  let serverID: IPv4 | undefined;
  const serverIDOpt = options.get(DHCPOption.ServerID);
  if (serverIDOpt && serverIDOpt.data.length === 4) {
    serverID = readIPv4(serverIDOpt.data, 0);
  }

  return {
    op,
    htype,
    hlen,
    hops,
    xid,
    secs,
    flags,
    ciaddr,
    yiaddr,
    siaddr,
    giaddr,
    chaddr,
    sname,
    file,
    options,
    messageType,
    isPXE,
    requestedIP,
    clientUUID,
    clientArch,
    hostname,
    serverID,
  };
}

// ─── Packet encoding ───────────────────────────────────────────────

/**
 * Encode a DHCP reply packet as a UDP payload.
 *
 * @param request - The original request packet (for xid, chaddr, etc.).
 * @param offeredIP - The IP address to offer/assign.
 * @param serverIP - The DHCP server's IP address.
 * @param tftpServerIP - The TFTP server IP (for siaddr field).
 * @param bootFile - The PXE boot filename.
 * @param replyType - The DHCP message type (OFFER or ACK).
 * @param subnetMask - The subnet mask to provide.
 * @param router - The default gateway to provide.
 * @param leaseTime - The lease time in seconds.
 * @param dnsServers - Optional DNS servers.
 */
export function encodeDHCPReply(
  request: DHCPPacket,
  offeredIP: IPv4,
  serverIP: IPv4,
  tftpServerIP: IPv4,
  bootFile: string,
  replyType: DHCPMessageType.OFFER | DHCPMessageType.ACK,
  subnetMask: IPv4,
  router: IPv4,
  leaseTime: number,
  dnsServers?: IPv4[],
): Buffer {
  // Fixed portion: 236 bytes
  const fixed = Buffer.alloc(DHCP_FIXED_SIZE);
  fixed[0] = 2; // BOOTREPLY
  fixed[1] = 1; // Ethernet
  fixed[2] = 6; // Hardware address length
  fixed[3] = 0; // Hops
  fixed.writeUInt32BE(request.xid, 4); // Transaction ID
  fixed.writeUInt16BE(0, 8); // Seconds
  fixed.writeUInt16BE(0, 10); // Flags
  writeIPv4(fixed, 12, request.ciaddr); // Client IP
  writeIPv4(fixed, 16, offeredIP); // Your IP
  writeIPv4(fixed, 20, tftpServerIP); // Next server (TFTP)
  writeIPv4(fixed, 24, '0.0.0.0' as IPv4); // Relay agent
  writeMAC(fixed, 28, request.chaddr); // Client MAC
  // sname (44-108) and file (108-236) are zeroed

  // Write boot filename
  const fileBuf = Buffer.from(bootFile, 'ascii');
  fileBuf.copy(fixed, 108);

  // Magic cookie
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(DHCP_MAGIC_COOKIE, 0);

  // DHCP options
  const optList: RawDHCPOption[] = [
    // Message type
    { code: DHCPOption.MessageType, data: Buffer.from([replyType]) },
    // Lease time
    { code: DHCPOption.LeaseTime, data: (() => { const b = Buffer.alloc(4); b.writeUInt32BE(leaseTime, 0); return b; })() },
    // Subnet mask
    { code: DHCPOption.SubnetMask, data: ipv4ToBuffer(subnetMask) },
    // Router
    { code: DHCPOption.Router, data: ipv4ToBuffer(router) },
    // Server ID
    { code: DHCPOption.ServerID, data: ipv4ToBuffer(serverIP) },
  ];

  // DNS servers
  if (dnsServers && dnsServers.length > 0) {
    const dnsBuf = Buffer.alloc(dnsServers.length * 4);
    for (let i = 0; i < dnsServers.length; i++) {
      writeIPv4(dnsBuf, i * 4, dnsServers[i]!);
    }
    optList.push({ code: DHCPOption.DNS, data: dnsBuf });
  }

  const optionsBuf = encodeOptions(optList);

  return Buffer.concat([fixed, cookie, optionsBuf]);
}

/**
 * Encode a DHCPNAK reply packet as a UDP payload.
 *
 * DHCPNAK is minimal — just the message type and server identifier.
 * No lease time, subnet mask, router, or other options.
 *
 * @param request - The original request packet (for xid, chaddr, etc.).
 * @param serverIP - The DHCP server's IP address.
 * @param message - Optional human-readable message (not included in packet, for logging only).
 */
export function encodeDHCPNAK(
  request: DHCPPacket,
  serverIP: IPv4,
  _message?: string,
): Buffer {
  // Fixed portion: 236 bytes
  const fixed = Buffer.alloc(DHCP_FIXED_SIZE);
  fixed[0] = 2; // BOOTREPLY
  fixed[1] = 1; // Ethernet
  fixed[2] = 6; // Hardware address length
  fixed[3] = 0; // Hops
  fixed.writeUInt32BE(request.xid, 4); // Transaction ID
  fixed.writeUInt16BE(0, 8); // Seconds
  // Set broadcast flag — client has no valid IP, broadcast is required
  fixed.writeUInt16BE(0x8000, 10);
  // All IP fields zeroed — client must discard its address
  writeMAC(fixed, 28, request.chaddr);

  // Magic cookie
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(DHCP_MAGIC_COOKIE, 0);

  // Minimal options: message type + server ID only
  const optList: RawDHCPOption[] = [
    { code: DHCPOption.MessageType, data: Buffer.from([DHCPMessageType.NAK]) },
    { code: DHCPOption.ServerID, data: ipv4ToBuffer(serverIP) },
  ];

  const optionsBuf = encodeOptions(optList);

  return Buffer.concat([fixed, cookie, optionsBuf]);
}

// ─── IP/UDP frame construction (for raw socket mode) ───────────────

/** Ethernet IP protocol number. */
const ETHERNET_IP_PROTO = 0x0800;

/** UDP protocol number in IP headers. */
const IP_UDP_PROTO = 0x11;

/**
 * Compute the IP header checksum.
 */
function ipChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < header.length; i += 2) {
    if (i + 1 < header.length) {
      sum += header.readUInt16BE(i);
    } else {
      sum += header[i]! << 8;
    }
    if (sum > 0xffff) {
      sum = (sum & 0xffff) + 1;
    }
  }
  return 0xffff - sum;
}

/**
 * Encode a full Ethernet + IP + UDP + DHCP frame for raw socket transmission.
 *
 * This is the Linux PF_PACKET path — needed when the OS won't let you
 * bind to port 67 without root, or when you need to send to 255.255.255.255.
 *
 * pTFTPd used this as the ONLY mode. We use it as a fallback.
 */
export function encodeRawDHCPFrame(
  dhcpPayload: Buffer,
  srcMAC: MAC,
  dstMAC: MAC,
  srcIP: IPv4,
  dstIP: IPv4,
): Buffer {
  // UDP header (8 bytes)
  const udpLen = 8 + dhcpPayload.length;
  const udp = Buffer.alloc(8);
  udp.writeUInt16BE(DHCP_SERVER_PORT, 0); // Source port
  udp.writeUInt16BE(DHCP_CLIENT_PORT, 2); // Destination port
  udp.writeUInt16BE(udpLen, 4); // Length
  udp.writeUInt16BE(0, 6); // Checksum (0 = not computed)

  // IP header (20 bytes, no options)
  const ipTotalLen = 20 + udpLen;
  const ipHeader = Buffer.alloc(20);
  ipHeader[0] = 0x45; // Version 4, IHL 5
  ipHeader[1] = 0; // DSCP/ECN
  ipHeader.writeUInt16BE(ipTotalLen, 2); // Total length
  ipHeader.writeUInt16BE(0, 4); // Identification
  ipHeader.writeUInt16BE(0, 6); // Flags/Fragment offset
  ipHeader[8] = 64; // TTL
  ipHeader[9] = IP_UDP_PROTO; // Protocol
  ipHeader.writeUInt16BE(0, 10); // Checksum placeholder
  writeIPv4(ipHeader, 12, srcIP);
  writeIPv4(ipHeader, 16, dstIP);

  // Compute IP checksum
  const cksum = ipChecksum(ipHeader);
  ipHeader.writeUInt16BE(cksum, 10);

  // Ethernet header (14 bytes)
  const eth = Buffer.alloc(14);
  writeMAC(eth, 0, dstMAC);
  writeMAC(eth, 6, srcMAC);
  eth.writeUInt16BE(ETHERNET_IP_PROTO, 12);

  return Buffer.concat([eth, ipHeader, udp, dhcpPayload]);
}
