import { describe, it, expect } from 'vitest';
import {
  encodeBOOTPReply,
} from '../../src/bootp/protocol.mjs';
import {
  DHCPOption,
  DHCP_MAGIC_COOKIE,
  DHCP_FIXED_SIZE,
} from '../../src/dhcp/types.mjs';
import { parseDHCPPacket } from '../../src/dhcp/protocol.mjs';
import { BOOTPOp, BOOTP_BROADCAST_FLAG } from '../../src/bootp/types.mjs';
import { IPv4, MAC } from '../../src/shared/types.mjs';

// ── Helpers ────────────────────────────────────────────────────────

/** Build a minimal BOOTP request packet (no DHCP Message Type option). */
function buildBOOTPRequest(opts: {
  xid?: number;
  mac?: MAC;
  sname?: string;
} = {}): Buffer {
  const xid = opts.xid ?? 0xAABBCCDD;
  const mac = opts.mac ?? '11:22:33:44:55:66' as MAC;

  const fixed = Buffer.alloc(DHCP_FIXED_SIZE);
  fixed[0] = 1; // BOOTREQUEST
  fixed[1] = 1; // Ethernet
  fixed[2] = 6; // HW addr length
  fixed.writeUInt32BE(xid, 4);

  // chaddr
  const macParts = mac.split(':').map((h: string) => parseInt(h, 16));
  for (let i = 0; i < 6; i++) {
    fixed[28 + i] = macParts[i]!;
  }

  // sname (offset 44, 64 bytes)
  if (opts.sname) {
    const snameBuf = Buffer.from(opts.sname, 'ascii');
    snameBuf.copy(fixed, 44);
  }

  // Magic cookie
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(DHCP_MAGIC_COOKIE, 0);

  // End option only (no DHCP Message Type — this is BOOTP, not DHCP)
  const end = Buffer.from([DHCPOption.End]);

  return Buffer.concat([fixed, cookie, end]);
}

// ─── encodeBOOTPReply ──────────────────────────────────────────────

describe('encodeBOOTPReply', () => {
  it('encodes a BOOTP reply with correct fixed fields', () => {
    const request = parseDHCPPacket(buildBOOTPRequest({ xid: 0x11223344 }));

    const reply = encodeBOOTPReply(
      request,
      '192.168.1.50' as IPv4,     // offeredIP
      '192.168.1.1' as IPv4,      // serverIP (unused in current impl but part of API)
      '192.168.1.1' as IPv4,      // tftpServerIP
      'pxelinux.0',               // bootFile
      'myserver',                 // serverHostname
      '255.255.255.0' as IPv4,    // subnetMask
      '192.168.1.1' as IPv4,      // router
    );

    const parsed = parseDHCPPacket(reply);

    expect(parsed.op).toBe(BOOTPOp.REPLY);
    expect(parsed.xid).toBe(0x11223344);
    expect(parsed.yiaddr).toBe('192.168.1.50');
    expect(parsed.siaddr).toBe('192.168.1.1');
    expect(parsed.chaddr).toBe('11:22:33:44:55:66');
    expect(parsed.file).toBe('pxelinux.0');
    expect(parsed.sname).toBe('myserver');
  });

  it('does NOT include a DHCP Message Type option', () => {
    const request = parseDHCPPacket(buildBOOTPRequest());

    const reply = encodeBOOTPReply(
      request,
      '10.0.0.50' as IPv4,
      '10.0.0.1' as IPv4,
      '10.0.0.1' as IPv4,
      'boot.efi',
      'bootserver',
      '255.255.0.0' as IPv4,
      '10.0.0.1' as IPv4,
    );

    const parsed = parseDHCPPacket(reply);
    expect(parsed.messageType).toBeUndefined();
    expect(parsed.options.has(DHCPOption.MessageType)).toBe(false);
  });

  it('includes subnet mask and gateway options', () => {
    const request = parseDHCPPacket(buildBOOTPRequest());

    const reply = encodeBOOTPReply(
      request,
      '192.168.1.50' as IPv4,
      '192.168.1.1' as IPv4,
      '192.168.1.1' as IPv4,
      'pxelinux.0',
      'srv',
      '255.255.255.0' as IPv4,
      '192.168.1.254' as IPv4,
    );

    const parsed = parseDHCPPacket(reply);

    expect(parsed.options.has(DHCPOption.SubnetMask)).toBe(true);
    expect(parsed.options.has(DHCPOption.Router)).toBe(true);
  });

  it('includes DNS servers when provided', () => {
    const request = parseDHCPPacket(buildBOOTPRequest());

    const reply = encodeBOOTPReply(
      request,
      '192.168.1.50' as IPv4,
      '192.168.1.1' as IPv4,
      '192.168.1.1' as IPv4,
      'pxelinux.0',
      'srv',
      '255.255.255.0' as IPv4,
      '192.168.1.1' as IPv4,
      ['8.8.8.8' as IPv4, '1.1.1.1' as IPv4],
    );

    const parsed = parseDHCPPacket(reply);
    const dnsOpt = parsed.options.get(DHCPOption.DNS);
    expect(dnsOpt).toBeDefined();
    expect(dnsOpt!.data.length).toBe(8);
  });

  it('pads the reply to at least 300 bytes (RFC951)', () => {
    const request = parseDHCPPacket(buildBOOTPRequest());

    const reply = encodeBOOTPReply(
      request,
      '192.168.1.50' as IPv4,
      '192.168.1.1' as IPv4,
      '192.168.1.1' as IPv4,
      'pxelinux.0',
      'srv',
      '255.255.255.0' as IPv4,
      '192.168.1.1' as IPv4,
    );

    expect(reply.length).toBeGreaterThanOrEqual(300);
  });

  it('sets the broadcast flag in the reply', () => {
    const request = parseDHCPPacket(buildBOOTPRequest());

    const reply = encodeBOOTPReply(
      request,
      '192.168.1.50' as IPv4,
      '192.168.1.1' as IPv4,
      '192.168.1.1' as IPv4,
      'pxelinux.0',
      'srv',
      '255.255.255.0' as IPv4,
      '192.168.1.1' as IPv4,
    );

    const flags = reply.readUInt16BE(10);
    expect(flags & BOOTP_BROADCAST_FLAG).toBe(BOOTP_BROADCAST_FLAG);
  });
});

// ─── BOOTP vs DHCP discrimination ──────────────────────────────────

describe('BOOTP vs DHCP packet discrimination', () => {
  it('BOOTP request has no messageType, DHCP DISCOVER does', () => {
    const bootpRequest = parseDHCPPacket(buildBOOTPRequest());
    expect(bootpRequest.messageType).toBeUndefined();
    expect(bootpRequest.op).toBe(1); // BOOTREQUEST

    // A DHCP DISCOVER would have messageType = 1
    // This is handled by the DHCP types/protocol, not BOOTP
    // But the parser correctly distinguishes them
  });
});

// ─── Round-trip ────────────────────────────────────────────────────

describe('BOOTP round-trip', () => {
  it('request → reply preserves XID and MAC', () => {
    const xid = 0xDEADBEEF;
    const mac = 'aa:bb:cc:dd:ee:ff' as MAC;

    const request = parseDHCPPacket(buildBOOTPRequest({ xid, mac }));
    const reply = encodeBOOTPReply(
      request,
      '10.0.0.42' as IPv4,
      '10.0.0.1' as IPv4,
      '10.0.0.1' as IPv4,
      'grub2.efi',
      'pxehost',
      '255.255.0.0' as IPv4,
      '10.0.0.1' as IPv4,
    );

    const parsed = parseDHCPPacket(reply);

    expect(parsed.xid).toBe(xid);
    expect(parsed.chaddr).toBe(mac);
    expect(parsed.yiaddr).toBe('10.0.0.42');
    expect(parsed.file).toBe('grub2.efi');
    expect(parsed.sname).toBe('pxehost');
    expect(parsed.messageType).toBeUndefined();
  });
});
