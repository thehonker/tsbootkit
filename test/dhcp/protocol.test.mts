import { describe, it, expect } from 'vitest';
import {
  parseDHCPPacket,
  encodeDHCPReply,
  encodeRawDHCPFrame,
  ipv4ToBuffer,
  DHCPProtocolError,
} from '../../src/dhcp/protocol.mjs';
import {
  DHCPMessageType,
  DHCPOption,
  ClientArchitecture,
  DHCP_MAGIC_COOKIE,
  DHCP_FIXED_SIZE,
  DHCP_SERVER_PORT,
  DHCP_CLIENT_PORT,
} from '../../src/dhcp/types.mjs';
import { IPv4, MAC } from '../../src/shared/types.mjs';

// ── Helpers ────────────────────────────────────────────────────────

/** Build a minimal DHCPDISCOVER packet for testing. */
function buildDiscoverPacket(opts: {
  xid?: number;
  mac?: MAC;
  isPXE?: boolean;
  requestedIP?: IPv4;
  includeMessageType?: boolean;
} = {}): Buffer {
  const xid = opts.xid ?? 0x12345678;
  const mac = opts.mac ?? 'aa:bb:cc:dd:ee:ff' as MAC;
  const isPXE = opts.isPXE ?? true;
  const requestedIP = opts.requestedIP;
  const includeMessageType = opts.includeMessageType ?? true;

  // Fixed portion (236 bytes)
  const fixed = Buffer.alloc(DHCP_FIXED_SIZE);
  fixed[0] = 1; // BOOTREQUEST
  fixed[1] = 1; // Ethernet
  fixed[2] = 6; // HW addr length
  fixed.writeUInt32BE(xid, 4); // XID
  // ciaddr, yiaddr, siaddr, giaddr all zeros
  // chaddr
  const macParts = mac.split(':').map((h: string) => parseInt(h, 16));
  for (let i = 0; i < 6; i++) {
    fixed[28 + i] = macParts[i]!;
  }

  // Magic cookie
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(DHCP_MAGIC_COOKIE, 0);

  // Options
  const optBuffers: Buffer[] = [];

  if (includeMessageType) {
    // DHCP Message Type: DISCOVER
    optBuffers.push(Buffer.from([DHCPOption.MessageType, 1, DHCPMessageType.DISCOVER]));
  }

  if (isPXE) {
    // Vendor Class ID: "PXEClient"
    const vendor = Buffer.from('PXEClient', 'ascii');
    const opt = Buffer.alloc(2 + vendor.length);
    opt[0] = DHCPOption.VendorClassID;
    opt[1] = vendor.length;
    vendor.copy(opt, 2);
    optBuffers.push(opt);
  }

  if (requestedIP) {
    // Requested IP Address
    const ipBuf = ipv4ToBuffer(requestedIP);
    const opt = Buffer.alloc(2 + 4);
    opt[0] = DHCPOption.RequestedIP;
    opt[1] = 4;
    ipBuf.copy(opt, 2);
    optBuffers.push(opt);
  }

  // End option
  optBuffers.push(Buffer.from([DHCPOption.End]));

  return Buffer.concat([fixed, cookie, ...optBuffers]);
}

// ─── Packet parsing ────────────────────────────────────────────────

describe('parseDHCPPacket', () => {
  it('parses a DHCPDISCOVER packet', () => {
    const pkt = buildDiscoverPacket({ xid: 0xDEADBEEF });
    const parsed = parseDHCPPacket(pkt);

    expect(parsed.op).toBe(1); // BOOTREQUEST
    expect(parsed.htype).toBe(1); // Ethernet
    expect(parsed.hlen).toBe(6);
    expect(parsed.xid).toBe(0xDEADBEEF);
    expect(parsed.chaddr).toBe('aa:bb:cc:dd:ee:ff');
    expect(parsed.messageType).toBe(DHCPMessageType.DISCOVER);
    expect(parsed.isPXE).toBe(true);
  });

  it('parses a non-PXE DHCPDISCOVER', () => {
    const pkt = buildDiscoverPacket({ isPXE: false });
    const parsed = parseDHCPPacket(pkt);

    expect(parsed.isPXE).toBe(false);
  });

  it('parses a packet with a requested IP', () => {
    const pkt = buildDiscoverPacket({ requestedIP: '192.168.1.100' as IPv4 });
    const parsed = parseDHCPPacket(pkt);

    expect(parsed.requestedIP).toBe('192.168.1.100');
  });

  it('parses a packet with a specific MAC', () => {
    const pkt = buildDiscoverPacket({ mac: '11:22:33:44:55:66' as MAC });
    const parsed = parseDHCPPacket(pkt);

    expect(parsed.chaddr).toBe('11:22:33:44:55:66');
  });

  it('throws for a too-short packet', () => {
    expect(() => parseDHCPPacket(Buffer.alloc(100))).toThrow(DHCPProtocolError);
  });

  it('throws for an invalid magic cookie', () => {
    const pkt = buildDiscoverPacket();
    // Corrupt the magic cookie
    pkt.writeUInt32BE(0xBADBAD, DHCP_FIXED_SIZE);
    expect(() => parseDHCPPacket(pkt)).toThrow(DHCPProtocolError);
  });

  it('handles packets without a message type option', () => {
    const pkt = buildDiscoverPacket({ includeMessageType: false });
    const parsed = parseDHCPPacket(pkt);

    expect(parsed.messageType).toBeUndefined();
  });
});

// ─── Reply encoding ────────────────────────────────────────────────

describe('encodeDHCPReply', () => {
  it('encodes a DHCPOFFER reply', () => {
    const request = parseDHCPPacket(buildDiscoverPacket({ xid: 0xAAAABBBB }));

    const reply = encodeDHCPReply(
      request,
      '192.168.1.50' as IPv4,   // offeredIP
      '192.168.1.1' as IPv4,    // serverIP
      '192.168.1.1' as IPv4,    // tftpServerIP
      'pxelinux.0',             // bootFile
      DHCPMessageType.OFFER,    // replyType
      '255.255.255.0' as IPv4,  // subnetMask
      '192.168.1.1' as IPv4,    // router
      600,                      // leaseTime
    );

    // Parse the reply to verify
    const parsed = parseDHCPPacket(reply);

    expect(parsed.op).toBe(2); // BOOTREPLY
    expect(parsed.xid).toBe(0xAAAABBBB);
    expect(parsed.yiaddr).toBe('192.168.1.50');
    expect(parsed.siaddr).toBe('192.168.1.1');
    expect(parsed.chaddr).toBe('aa:bb:cc:dd:ee:ff');
    expect(parsed.file).toBe('pxelinux.0');
    expect(parsed.messageType).toBe(DHCPMessageType.OFFER);
  });

  it('encodes a DHCPACK reply', () => {
    const request = parseDHCPPacket(buildDiscoverPacket({ xid: 0xCCCCDDDD }));

    const reply = encodeDHCPReply(
      request,
      '10.0.0.50' as IPv4,
      '10.0.0.1' as IPv4,
      '10.0.0.1' as IPv4,
      'boot/grub2.efi',
      DHCPMessageType.ACK,
      '255.255.0.0' as IPv4,
      '10.0.0.1' as IPv4,
      600,
    );

    const parsed = parseDHCPPacket(reply);

    expect(parsed.messageType).toBe(DHCPMessageType.ACK);
    expect(parsed.yiaddr).toBe('10.0.0.50');
    expect(parsed.file).toBe('boot/grub2.efi');
  });

  it('includes DNS servers in reply options', () => {
    const request = parseDHCPPacket(buildDiscoverPacket());

    const reply = encodeDHCPReply(
      request,
      '192.168.1.50' as IPv4,
      '192.168.1.1' as IPv4,
      '192.168.1.1' as IPv4,
      'pxelinux.0',
      DHCPMessageType.OFFER,
      '255.255.255.0' as IPv4,
      '192.168.1.1' as IPv4,
      600,
      ['8.8.8.8' as IPv4, '8.8.4.4' as IPv4],
    );

    const parsed = parseDHCPPacket(reply);
    const dnsOpt = parsed.options.get(DHCPOption.DNS);
    expect(dnsOpt).toBeDefined();
    expect(dnsOpt!.data.length).toBe(8); // 2 IPs × 4 bytes
  });

  it('reply includes lease time, subnet mask, router, server ID', () => {
    const request = parseDHCPPacket(buildDiscoverPacket());

    const reply = encodeDHCPReply(
      request,
      '192.168.1.50' as IPv4,
      '192.168.1.1' as IPv4,
      '192.168.1.1' as IPv4,
      'pxelinux.0',
      DHCPMessageType.OFFER,
      '255.255.255.0' as IPv4,
      '192.168.1.1' as IPv4,
      600,
    );

    const parsed = parseDHCPPacket(reply);

    expect(parsed.options.has(DHCPOption.LeaseTime)).toBe(true);
    expect(parsed.options.has(DHCPOption.SubnetMask)).toBe(true);
    expect(parsed.options.has(DHCPOption.Router)).toBe(true);
    expect(parsed.options.has(DHCPOption.ServerID)).toBe(true);
  });
});

// ─── Round-trip ────────────────────────────────────────────────────

describe('DHCP round-trip', () => {
  it('discover → offer → request → ack round-trip preserves XID and MAC', () => {
    const xid = 0x11223344;
    const mac = 'de:ad:be:ef:00:01' as MAC;

    // DISCOVER
    const discoverPkt = buildDiscoverPacket({ xid, mac });
    const discover = parseDHCPPacket(discoverPkt);

    // OFFER
    const offer = encodeDHCPReply(
      discover,
      '192.168.1.100' as IPv4,
      '192.168.1.1' as IPv4,
      '192.168.1.1' as IPv4,
      'pxelinux.0',
      DHCPMessageType.OFFER,
      '255.255.255.0' as IPv4,
      '192.168.1.1' as IPv4,
      600,
    );
    const offerParsed = parseDHCPPacket(offer);
    expect(offerParsed.xid).toBe(xid);
    expect(offerParsed.chaddr).toBe(mac);
    expect(offerParsed.yiaddr).toBe('192.168.1.100');

    // REQUEST (simulated — client would send this)
    const requestPkt = buildDiscoverPacket({
      xid,
      mac,
      requestedIP: '192.168.1.100' as IPv4,
    });
    // Manually set message type to REQUEST
    requestPkt[DHCP_FIXED_SIZE + 4 + 2] = DHCPMessageType.REQUEST; // offset after cookie + opt code + len
    const request = parseDHCPPacket(requestPkt);

    // ACK
    const ack = encodeDHCPReply(
      request,
      '192.168.1.100' as IPv4,
      '192.168.1.1' as IPv4,
      '192.168.1.1' as IPv4,
      'pxelinux.0',
      DHCPMessageType.ACK,
      '255.255.255.0' as IPv4,
      '192.168.1.1' as IPv4,
      600,
    );
    const ackParsed = parseDHCPPacket(ack);
    expect(ackParsed.xid).toBe(xid);
    expect(ackParsed.yiaddr).toBe('192.168.1.100');
    expect(ackParsed.messageType).toBe(DHCPMessageType.ACK);
  });
});

// ─── Raw frame encoding ────────────────────────────────────────────

describe('encodeRawDHCPFrame', () => {
  it('produces a frame with correct structure', () => {
    const discover = parseDHCPPacket(buildDiscoverPacket());
    const dhcpPayload = encodeDHCPReply(
      discover,
      '192.168.1.50' as IPv4,
      '192.168.1.1' as IPv4,
      '192.168.1.1' as IPv4,
      'pxelinux.0',
      DHCPMessageType.OFFER,
      '255.255.255.0' as IPv4,
      '192.168.1.1' as IPv4,
      600,
    );

    const frame = encodeRawDHCPFrame(
      dhcpPayload,
      'aa:bb:cc:dd:ee:01' as MAC, // srcMAC (server)
      'ff:ff:ff:ff:ff:ff' as MAC,  // dstMAC (broadcast)
      '192.168.1.1' as IPv4,       // srcIP
      '255.255.255.255' as IPv4,   // dstIP
    );

    // Ethernet header: 14 bytes
    // IP header: 20 bytes
    // UDP header: 8 bytes
    // DHCP payload
    const expectedLen = 14 + 20 + 8 + dhcpPayload.length;
    expect(frame.length).toBe(expectedLen);

    // Check Ethernet type (IP = 0x0800)
    expect(frame.readUInt16BE(12)).toBe(0x0800);

    // Check IP version + IHL
    expect(frame[14]!).toBe(0x45);

    // Check IP protocol (UDP = 0x11)
    expect(frame[23]!).toBe(0x11);

    // Check UDP ports
    expect(frame.readUInt16BE(34)).toBe(DHCP_SERVER_PORT);
    expect(frame.readUInt16BE(36)).toBe(DHCP_CLIENT_PORT);
  });
});

// ─── ipv4ToBuffer ─────────────────────────────────────────────────

describe('ipv4ToBuffer', () => {
  it('converts IPv4 string to 4-byte buffer', () => {
    const buf = ipv4ToBuffer('192.168.1.1' as IPv4);
    expect(buf.length).toBe(4);
    expect(buf[0]).toBe(192);
    expect(buf[1]).toBe(168);
    expect(buf[2]).toBe(1);
    expect(buf[3]).toBe(1);
  });

  it('handles 0.0.0.0', () => {
    const buf = ipv4ToBuffer('0.0.0.0' as IPv4);
    expect(buf).toEqual(Buffer.from([0, 0, 0, 0]));
  });
});

// ─── Option 93 (Client Architecture) ──────────────────────────────────

describe('Client Architecture (option 93)', () => {
  it('parses option 93 from a DHCPDISCOVER', () => {
    // Build packet with option 93 directly
    const archBuf = Buffer.alloc(4); // 2 bytes header + 2 bytes data
    archBuf[0] = DHCPOption.ClientArch;
    archBuf[1] = 2; // data length
    archBuf.writeUInt16BE(ClientArchitecture.EFI_x86_64, 2);

    // Rebuild the packet with option 93 before the End marker
    // For simplicity, rebuild from scratch with the option
    const fixed = Buffer.alloc(DHCP_FIXED_SIZE);
    fixed[0] = 1; fixed[1] = 1; fixed[2] = 6;
    fixed.writeUInt32BE(0xBEEFCAFE, 4);
    const macParts = 'aa:bb:cc:dd:ee:ff'.split(':').map((h: string) => parseInt(h, 16));
    for (let i = 0; i < 6; i++) fixed[28 + i] = macParts[i]!;

    const cookie = Buffer.alloc(4);
    cookie.writeUInt32BE(DHCP_MAGIC_COOKIE, 0);

    const opts = Buffer.concat([
      Buffer.from([DHCPOption.MessageType, 1, DHCPMessageType.DISCOVER]),
      Buffer.from([DHCPOption.ClientArch, 2]),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(ClientArchitecture.EFI_x86_64, 0); return b; })(),
      Buffer.from([DHCPOption.End]),
    ]);

    const fullPkt = Buffer.concat([fixed, cookie, opts]);
    const parsed = parseDHCPPacket(fullPkt);

    expect(parsed.clientArch).toBe(ClientArchitecture.EFI_x86_64);
  });

  it('returns undefined when option 93 is absent', () => {
    const pkt = buildDiscoverPacket();
    const parsed = parseDHCPPacket(pkt);
    expect(parsed.clientArch).toBeUndefined();
  });

  it('parses BIOS architecture (0)', () => {
    const fixed = Buffer.alloc(DHCP_FIXED_SIZE);
    fixed[0] = 1; fixed[1] = 1; fixed[2] = 6;
    const cookie = Buffer.alloc(4);
    cookie.writeUInt32BE(DHCP_MAGIC_COOKIE, 0);
    const opts = Buffer.concat([
      Buffer.from([DHCPOption.MessageType, 1, DHCPMessageType.DISCOVER]),
      Buffer.from([DHCPOption.ClientArch, 2]),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(ClientArchitecture.BIOS, 0); return b; })(),
      Buffer.from([DHCPOption.End]),
    ]);
    const parsed = parseDHCPPacket(Buffer.concat([fixed, cookie, opts]));
    expect(parsed.clientArch).toBe(ClientArchitecture.BIOS);
  });

  it('parses EFI ARM64 architecture (8)', () => {
    const fixed = Buffer.alloc(DHCP_FIXED_SIZE);
    fixed[0] = 1; fixed[1] = 1; fixed[2] = 6;
    const cookie = Buffer.alloc(4);
    cookie.writeUInt32BE(DHCP_MAGIC_COOKIE, 0);
    const opts = Buffer.concat([
      Buffer.from([DHCPOption.MessageType, 1, DHCPMessageType.DISCOVER]),
      Buffer.from([DHCPOption.ClientArch, 2]),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(ClientArchitecture.EFI_ARM64, 0); return b; })(),
      Buffer.from([DHCPOption.End]),
    ]);
    const parsed = parseDHCPPacket(Buffer.concat([fixed, cookie, opts]));
    expect(parsed.clientArch).toBe(ClientArchitecture.EFI_ARM64);
  });
});

describe('Client Hostname (option 12)', () => {
  function buildDiscoverWithHostname(hostname: string): Buffer {
    const hostnameBytes = Buffer.from(hostname, 'ascii');
    const fixed = Buffer.alloc(DHCP_FIXED_SIZE);
    fixed[0] = 1; fixed[1] = 1; fixed[2] = 6;
    fixed.writeUInt32BE(0xCAFEBABE, 4);
    const macParts = 'aa:bb:cc:dd:ee:ff'.split(':').map((h: string) => parseInt(h, 16));
    for (let i = 0; i < 6; i++) fixed[28 + i] = macParts[i]!;
    const cookie = Buffer.alloc(4);
    cookie.writeUInt32BE(DHCP_MAGIC_COOKIE, 0);
    const opts = Buffer.concat([
      Buffer.from([DHCPOption.MessageType, 1, DHCPMessageType.DISCOVER]),
      Buffer.from([DHCPOption.Hostname, hostnameBytes.length]),
      hostnameBytes,
      Buffer.from([DHCPOption.End]),
    ]);
    return Buffer.concat([fixed, cookie, opts]);
  }

  it('parses option 12 from a DHCPDISCOVER', () => {
    const result = parseDHCPPacket(buildDiscoverWithHostname('build-server'));
    expect(result.hostname).toBe('build-server');
  });

  it('returns undefined when option 12 is absent', () => {
    const result = parseDHCPPacket(buildDiscoverPacket());
    expect(result.hostname).toBeUndefined();
  });

  it('trims whitespace from hostname', () => {
    const result = parseDHCPPacket(buildDiscoverWithHostname('  my-host  '));
    expect(result.hostname).toBe('my-host');
  });
});
