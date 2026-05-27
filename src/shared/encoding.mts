/**
 * Shared encoding helpers for DHCP/BOOTP packet construction.
 *
 * These are low-level buffer writers used by both the DHCP and BOOTP
 * protocol modules. Extracted here to avoid duplication.
 */

import type { IPv4, MAC } from './types.mjs';
import type { RawDHCPOption } from '../dhcp/types.mjs';
import { DHCPOption } from '../dhcp/types.mjs';

/**
 * Write an IPv4 address string into a buffer at the given offset.
 */
export function writeIPv4(buf: Buffer, offset: number, ip: IPv4): void {
  const parts = ip.split('.').map(Number);
  buf[offset] = parts[0]!;
  buf[offset + 1] = parts[1]!;
  buf[offset + 2] = parts[2]!;
  buf[offset + 3] = parts[3]!;
}

/**
 * Write a MAC address string into a 6-byte buffer at the given offset.
 */
export function writeMAC(buf: Buffer, offset: number, mac: MAC): void {
  const parts = mac.split(':').map((x: string) => parseInt(x, 16));
  for (let i = 0; i < 6; i++) {
    buf[offset + i] = parts[i]!;
  }
}

/**
 * Encode a list of DHCP/BOOTP options into a buffer.
 *
 * Produces a binary blob with each option as [code, length, data...],
 * terminated by the End option (255).
 */
export function encodeOptions(options: RawDHCPOption[]): Buffer {
  const bufs: Buffer[] = [];

  for (const opt of options) {
    if (opt.code === DHCPOption.Pad) {
      bufs.push(Buffer.from([0]));
      continue;
    }
    const header = Buffer.alloc(2);
    header[0] = opt.code;
    header[1] = opt.data.length;
    bufs.push(header);
    bufs.push(opt.data);
  }

  // End option
  bufs.push(Buffer.from([DHCPOption.End]));

  return Buffer.concat(bufs);
}
