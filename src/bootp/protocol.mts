/**
 * BOOTP packet codec.
 *
 * BOOTP (RFC951) shares the same wire format as DHCP — the packet
 * structure, magic cookie, and vendor extensions (RFC1497) are identical.
 * The only difference is semantic: BOOTP has no DHCP Message Type option
 * and no lease negotiation.
 *
 * We reuse the DHCP codec for parsing and just provide BOOTP-specific
 * reply encoding that omits the DHCP Message Type option.
 */

import { IPv4 } from '../shared/types.mjs';
import {
  DHCPOption,
  DHCP_MAGIC_COOKIE,
  DHCP_FIXED_SIZE,
  RawDHCPOption,
} from '../dhcp/types.mjs';
import { ipv4ToBuffer } from '../dhcp/protocol.mjs';
import { writeIPv4, writeMAC, encodeOptions } from '../shared/encoding.mjs';
import { BOOTPOp, BOOTP_BROADCAST_FLAG, BOOTP_MIN_PACKET_SIZE } from './types.mjs';


// ─── BOOTP-specific reply ──────────────────────────────────────────

/**
 * Encode a BOOTP reply packet.
 *
 * Like a DHCP reply, but without the DHCP Message Type option.
 * BOOTP is just request → reply, no DORA dance.
 */
export function encodeBOOTPReply(
  request: import('../dhcp/types.mts').DHCPPacket,
  offeredIP: IPv4,
  _serverIP: IPv4,
  tftpServerIP: IPv4,
  bootFile: string,
  serverHostname: string,
  subnetMask: IPv4,
  router: IPv4,
  dnsServers?: IPv4[],
): Buffer {
  // Fixed portion (236 bytes)
  const fixed = Buffer.alloc(DHCP_FIXED_SIZE);
  fixed[0] = BOOTPOp.REPLY; // BOOTREPLY
  fixed[1] = 1; // Ethernet
  fixed[2] = 6; // Hardware address length
  fixed[3] = 0; // Hops
  fixed.writeUInt32BE(request.xid, 4); // Transaction ID
  fixed.writeUInt16BE(0, 8); // Seconds
  fixed.writeUInt16BE(BOOTP_BROADCAST_FLAG, 10); // Flags (broadcast)
  // ciaddr = 0 (client doesn't have an IP yet)
  writeIPv4(fixed, 16, offeredIP); // yiaddr
  writeIPv4(fixed, 20, tftpServerIP); // siaddr (TFTP server)
  // giaddr = 0
  writeMAC(fixed, 28, request.chaddr); // chaddr

  // Server hostname (sname field, 64 bytes at offset 44)
  const hostnameBuf = Buffer.from(serverHostname, 'ascii');
  hostnameBuf.copy(fixed, 44);

  // Boot filename (file field, 128 bytes at offset 108)
  const fileBuf = Buffer.from(bootFile, 'ascii');
  fileBuf.copy(fixed, 108);

  // Magic cookie
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(DHCP_MAGIC_COOKIE, 0);

  // BOOTP vendor extensions (RFC1497) — NO DHCP Message Type option
  const optList: RawDHCPOption[] = [
    // Subnet mask
    { code: DHCPOption.SubnetMask, data: ipv4ToBuffer(subnetMask) },
    // Gateway
    { code: DHCPOption.Router, data: ipv4ToBuffer(router) },
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

  // Build the packet
  const packet = Buffer.concat([fixed, cookie, optionsBuf]);

  // Pad to BOOTP_MIN_PACKET_SIZE (RFC951 §3)
  if (packet.length < BOOTP_MIN_PACKET_SIZE) {
    const padding = Buffer.alloc(BOOTP_MIN_PACKET_SIZE - packet.length);
    return Buffer.concat([packet, padding]);
  }

  return packet;
}

// ─── Helpers ────────────────────────────────────────────────────────
// writeIPv4, writeMAC, and encodeOptions are imported from ../shared/encoding.mjs
