# tsbootkit

[![npm](https://img.shields.io/npm/v/tsbootkit)](https://www.npmjs.com/package/tsbootkit)

A TypeScript PXE/TFTP toolkit — TFTP, DHCP, BOOTP, and PXE servers for network booting.

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
  - [PXE Daemon (recommended)](#pxe-daemon-recommended)
  - [Individual Servers](#individual-servers)
  - [Docker](#docker)
- [Configuration](#configuration)
- [Architecture-Aware Boot Files](#architecture-aware-boot-files)
- [Netconsole](#netconsole)
  - [Configuration](#configuration-1)
  - [Kernel-side Setup](#kernel-side-setup)
  - [Netconsole Hooks](#netconsole-hooks)
- [Log Stream](#log-stream)
  - [Buffer Configuration](#buffer-configuration)
  - [Runtime Level Selection](#runtime-level-selection)
- [Static Reservations](#static-reservations)
- [Lifecycle Hooks](#lifecycle-hooks)
  - [TFTP Hook Arguments](#tftp-hook-arguments)
  - [DHCP Hook Arguments](#dhcp-hook-arguments)
  - [BOOTP Hook Arguments](#bootp-hook-arguments)
  - [Cross-Protocol Hooks](#cross-protocol-hooks)
- [CLI Reference](#cli-reference)
  - [`tsbootkit-pxed`](#tsbootkit-pxed--combined-pxe-daemon)
  - [`tsbootkit-dhcpd`](#tsbootkit-dhcpd--dhcp-server)
  - [`tsbootkit-bootpd`](#tsbootkit-bootpd--bootp-server)
  - [`tsbootkit-netconsoled`](#tsbootkit-netconsoled--netconsole-listener)
  - [Config vs. CLI Flags](#config-vs-cli-flags)
  - [PID File and Stale Process Detection](#pid-file-and-stale-process-detection)
- [Programmatic API](#programmatic-api)
- [Web Dashboard](#web-dashboard)
  - [API Endpoints](#api-endpoints)
- [Health Check](#health-check)
- [Docker](#docker-1)
  - [Custom TFTP Port](#custom-tftp-port)
  - [mDNS in Docker](#mdns-in-docker)
  - [Volumes](#volumes)
  - [Ports](#ports)
- [RFC Compliance](#rfc-compliance)
- [Development](#development)
- [TODO](#todo)
- [License](#license)

Inspired by [pTFTPd](https://github.com/mpetazzoni/ptftpd).

## Features

- **TFTP server + client** — RRQ/WRQ, option negotiation (blksize, timeout, tsize, windowsize), windowed transfers, retransmit with backoff
- **DHCP server** — PXE-aware, architecture-aware boot file selection (option 93), client hostname (option 12), static reservations, lease tracking
- **BOOTP server** — RFC951, cross-platform (pTFTPd was Linux-only), reservations and architecture-aware boot files
- **PXE daemon** — Single-process DHCP/BOOTP + TFTP + HTTP + mDNS, one command to light up a lab
- **HTTP fallback** — UEFI firmware that prefers HTTP over TFTP just works, range request support (RFC7233)
- **mDNS advertisement** — `_tftp._udp` and `_http._tcp` via DNS-SD, customizable address for Docker
- **Architecture-aware boot files** — BIOS machines get `pxelinux.0`, UEFI x86 gets `bootx64.efi`, ARM gets `grubaa64.efi` — all from one config
- **Lifecycle hooks** — Execute any script on TFTP transfer events, DHCP protocol events, BOOTP events, or netconsole messages
- **Netconsole listener** — Receive kernel log messages over UDP, integrated with logging and hooks
- **Web dashboard** — Live status at `/ui/`, transfers with progress, DHCP leases, reservations
- **SBOM** — CycloneDX in the npm package, Docker manifest, and GitHub release

## Quick Start

### PXE Daemon (recommended)

The PXE daemon runs TFTP + DHCP (or BOOTP) in a single process — one command to light up a PXE environment:

```bash
# With a config file
npx tsbootkit-pxed --config tsbootkit.yaml

# Or with positional args (no config file)
npx tsbootkit-pxed eth0 pxelinux.0 /tftpboot
```

### Individual Servers

Each server can run standalone:

```bash
# TFTP server (config file)
npx tsbootkit-tftpd --config tsbootkit.yaml

# TFTP server (positional args)
npx tsbootkit-tftpd /tftpboot

# DHCP server
npx tsbootkit-dhcpd --config tsbootkit.yaml
npx tsbootkit-dhcpd eth0 pxelinux.0

# BOOTP server
npx tsbootkit-bootpd --config tsbootkit.yaml
npx tsbootkit-bootpd eth0 pxelinux.0
```

### Docker

```bash
docker run --net=host \
  -v ./config.yaml:/etc/tsbootkit.yaml \
  -v ./tftpboot:/tftpboot \
  ghcr.io/thehonker/tsbootkit:latest
```

## Configuration

Create a `tsbootkit.yaml`. Only `interface`, `bootFile`, and `tftpRoot` are required — everything else is optional with sensible defaults.

```yaml
# ── Required ────────────────────────────────────────────────────

interface: eth0                # Network interface to listen on
bootFile: pxelinux.0           # Default PXE boot filename
tftpRoot: /tftpboot            # TFTP server root directory

# ── Network (auto-detected from interface if omitted) ───────────

# mode: dhcp                   # dhcp (default) or bootp
# serverIP: 192.168.1.1
# subnetMask: 255.255.255.0
# router: 192.168.1.1
# tftpServer: 192.168.1.1      # TFTP server IP (if different from this host)
# dnsServers:
#   - 8.8.8.8
#   - 8.8.4.4

# ── DHCP options ────────────────────────────────────────────────

# dhcp:
#   leaseTime: 600             # seconds (60–86400)
#   answerAll: false            # respond to non-PXE DHCP requests?

# ── BOOTP options ────────────────────────────────────────────────

# bootp:
#   allocationLifetime: 86400  # seconds before reclaiming unused IPs (60–604800, default 86400 = 24h)

# ── TFTP options ────────────────────────────────────────────────

# tftp:
#   port: 69
#   maxTransfers: 16
#   allowWrite: false

# ── Security ──────────────────────────────────────────────────────

# Whether to follow symbolic links in TFTP/HTTP file serving.
# Default: false — symlinks pointing outside the root directory are blocked.
# followSymlinks: false

# ── Interface wait ────────────────────────────────────────────

# wait: false                   # Wait for the interface to come up before starting?
# waitTimeout: 0                # Max seconds to wait (0 = forever, requires wait: true)

# ── Logging ─────────────────────────────────────────────────────

# logging:
#   level: info                 # error | warn | info | debug | trace
#   file: /var/log/tsbootkit.log
#   buffer: 500                  # max log entries in dashboard ring buffer (0 = disabled, default 500)

# ── Health check & HTTP ─────────────────────────────────────────

# healthPort: 9470              # Health check + dashboard port (0 = disabled)
# httpPort: 80                  # HTTP fallback port for UEFI (0 = disabled)
# http:                         # HTTP fallback server options
#   host: 0.0.0.0              # host to bind (must be reachable by PXE clients)
#   maxFileSize: 1073741824     # max bytes to serve (default 1GB)
# mdnsAddress: 192.168.1.1      # mDNS address (defaults to serverIP, "" = disabled)
```

See [`config.example.yaml`](config.example.yaml) for the full schema with all options.

## Architecture-Aware Boot Files

DHCP option 93 (RFC 4578) tells the server whether a client is BIOS or UEFI. Instead of one `bootFile` for everything, configure per-architecture defaults:

```yaml
bootFile: pxelinux.0          # fallback for unknown architectures
bootFiles:
  bios: pxelinux.0
  efiX86_64: bootx64.efi
  efiARM64: grubaa64.efi
```

Per-reservation overrides take priority:

```yaml
reservations:
  - mac: aa:bb:cc:dd:ee:01
    ip: 192.168.1.50
    bootFile: ipxe.efi              # exact override, ignores architecture

  - mac: 11:22:33:44:55:66
    ip: 192.168.1.51
    bootFiles:                      # per-client architecture map
      bios: alt/pxelinux.0
      efiX86_64: alt/bootx64.efi
```

**Resolution priority:** reservation `bootFile` → reservation `bootFiles` → global `bootFiles` → global `bootFile`.

## Netconsole

tsbootkit can listen for [kernel netconsole](https://docs.kernel.org/networking/netconsole.html) messages over UDP. This is useful for capturing kernel log output from machines that are PXE booting — before they have disk or serial console access.

### Configuration

```yaml
netconsole:
  port: 6666              # UDP port (default 6666, 0 = disabled)
  address: 192.168.1.1   # defaults to serverIP
  level: info             # log level for received messages
```

Or via CLI:

```bash
npx tsbootkit-pxed --config tsbootkit.yaml --netconsole-port 6666
```

### Kernel-side Setup

Configure the booting kernel to send netconsole messages to tsbootkit:

**Module parameter (runtime):**
```bash
modprobe netconsole netconsole=6666@/eth0,6666@192.168.1.1/
```

**Kernel cmdline (boot-time):**
```
netconsole=6666@/eth0,6666@192.168.1.1/
```

The format is `<src-port>@/<src-iface>,<dst-port>@<dst-ip>/`.

Messages are logged at the configured level (`info` by default) with the sender's IP:

```
10:30:15 netconsole info: <192.168.1.50> Kernel panic - not syncing: VFS
```

### Netconsole Hooks

Hook into netconsole messages to trigger alerts on kernel panics or other events:

```yaml
hooks:
  - exec: /usr/local/bin/alert-kernel-panic.sh
    events: [message]             # netconsole message event
```

Netconsole hook arguments: `<event> <source> <message>`

**Example:**
```
message 192.168.1.50:6666 Kernel panic - not syncing: VFS
```

## Log Stream

The dashboard includes a live log stream that shows recent messages from **all** tsbootkit components — TFTP transfers, DHCP handshakes, BOOTP replies, netconsole messages, errors, and lifecycle events. No need to SSH into the server to check logs.

### Buffer Configuration

```yaml
logging:
  buffer: 500    # max entries in the ring buffer (0 = disabled, default 500)
```

The buffer is an in-memory ring buffer — oldest entries are discarded when the limit is reached. Default 500 entries (~100KB memory).

### Runtime Level Selection

The dashboard has a **level dropdown** that changes the log level at runtime without restarting the daemon:

```bash
# Or via the API directly
curl -X PUT http://localhost:9470/api/log/level \
  -H 'Content-Type: application/json' \
  -d '{"level": "debug"}'
```

Valid levels: `error`, `warn`, `info`, `debug`, `trace`. The change affects all loggers immediately.

## Static Reservations

Map known MAC addresses to fixed IPs. Reserved clients always get the same address — no lease database needed.

```yaml
reservations:
  - mac: aa:bb:cc:dd:ee:01
    ip: 192.168.1.50
    hostname: build-server
    bootFile: custom/boot.efi       # optional: exact boot file override

  - mac: 11:22:33:44:55:66
    ip: 192.168.1.51
    hostname: test-client
    bootFiles:                      # optional: per-architecture boot files
      bios: pxelinux.0
      efiX86_64: bootx64.efi

  - mac: 33:44:55:66:77:88
    ip: 192.168.1.52                # minimal: just MAC → IP
```

Reservations work in both DHCP and BOOTP modes.

## Lifecycle Hooks

Execute any program on server lifecycle events. Hooks are fire-and-forget — failures are logged but never block the event flow.

```yaml
hooks:
  - exec: /usr/local/bin/notify-boot.sh
    events: [post]                    # only on successful TFTP transfer
  - exec: /usr/local/bin/log-error.py
    events: [on-error]                # only on TFTP failures
    extraArgs: ["--channel", "#ops"]  # appended to the command
  - exec: /usr/local/bin/dhcp-notify.sh
    events: [ack]                     # only on DHCP ACK
  - exec: /usr/local/bin/asset-track.sh
    events: [reply]                   # BOOTP reply
  - exec: /usr/local/bin/alert-panic.sh
    events: [message]                  # netconsole message
  - exec: /usr/local/bin/log-all.sh  # no events filter = all events
```

### TFTP Hook Arguments

```none
<event> <direction> <client-ip> <client-port> <filename> [extra...]
```

| Event | Extra args |
| --- | --- |
| `pre` | — |
| `post` | `<bytes-sent> <bytes-received>` |
| `on-error` | `<error-code> <error-message>` |

**Example:**
```
post rrq 192.168.1.50 54321 bootx64.efi 262144 0
on-error wrq 192.168.1.51 54322 upload.bin 4 "Access violation"
```

### DHCP Hook Arguments

```none
<event> <client-mac> [extra...]
```

| Event | Extra args |
| --- | --- |
| `discover` | `<hostname>` (if provided) |
| `offer` | `<offered-ip>` |
| `request` | `<requested-ip> <hostname>` (if provided) |
| `ack` | `<assigned-ip> <hostname>` (if provided) |
| `nak` | `<reason>` |

**Example:**
```
discover aa:bb:cc:dd:ee:01 build-server
ack aa:bb:cc:dd:ee:01 192.168.1.50 build-server
```

### BOOTP Hook Arguments

```none
<event> <client-mac> [extra...]
```

| Event | Extra args |
| --- | --- |
| `request` | — |
| `reply` | `<assigned-ip>` |

**Example:**
```
reply aa:bb:cc:dd:ee:01 192.168.1.50
```

### Cross-Protocol Hooks

A single hook can match events from multiple protocols:

```yaml
hooks:
  - exec: /usr/local/bin/log-everything.sh
    events: [post, ack, reply, message]  # TFTP + DHCP + BOOTP + netconsole
```

## CLI Reference

### `tsbootkit-pxed` — Combined PXE Daemon

```bash
npx tsbootkit-pxed --config tsbootkit.yaml
npx tsbootkit-pxed <interface> <bootfile> <tftproot> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | — | Path to YAML config file |
| `--mode <mode>` | `dhcp` | IP assignment mode: `dhcp` or `bootp` |
| `--tftp-server <ip>` | server IP | TFTP server IP address |
| `--gateway <ip>` | server IP | Default gateway IP |
| `--dns <ip>...` | — | DNS server IP(s) |
| `--lease-time <sec>` | `600` | DHCP lease time in seconds |
| `--answer-all` | `false` | Respond to non-PXE DHCP requests |
| `--tftp-port <port>` | `69` | TFTP server port |
| `--max-transfers <n>` | `16` | Maximum concurrent TFTP transfers |
| `--allow-write` | `false` | Allow TFTP write (WRQ) requests |
| `--health-port <port>` | `9470` | Health check + dashboard port (0 = disabled) |
| `--http-port <port>` | `0` | HTTP fallback port (0 = disabled) |
| `--mdns-address <ip>` | server IP | mDNS address to advertise (empty = disabled) |
| `--netconsole-port <port>` | `0` | UDP port for netconsole listener (0 = disabled) |
| `--pid-file <path>` | — | Write PID to file (stale PID auto-cleaned) |
| `-v, --verbose` | — | Increase verbosity (`-v` debug, `-vv` trace) |
| `--wait` | `false` | Wait for the interface to come up before starting |
| `--wait-timeout <sec>` | `0` | Max seconds to wait for interface (0 = forever, requires `--wait`) | — TFTP Server

```bash
npx tsbootkit-tftpd --config tsbootkit.yaml
npx tsbootkit-tftpd <root> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | — | Path to YAML config file |
| `--port <port>` | `69` | TFTP server port |
| `--max-transfers <n>` | `16` | Maximum concurrent transfers |
| `--allow-write` | `false` | Allow WRQ (upload) requests |
| `--pid-file <path>` | — | Write PID to file (stale PID auto-cleaned) |
| `-v, --verbose` | — | Increase verbosity |

### `tsbootkit-dhcpd` — DHCP Server

```bash
npx tsbootkit-dhcpd --config tsbootkit.yaml
npx tsbootkit-dhcpd <interface> <bootfile> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | — | Path to YAML config file |
| `--tftp-server <ip>` | server IP | TFTP server IP address |
| `--gateway <ip>` | server IP | Default gateway IP |
| `--dns <ip>...` | — | DNS server IP(s) |
| `--lease-time <sec>` | `600` | DHCP lease time in seconds |
| `--answer-all` | `false` | Respond to non-PXE DHCP requests |
| `--pid-file <path>` | — | Write PID to file (stale PID auto-cleaned) |
| `-v, --verbose` | — | Increase verbosity |
| `--wait` | `false` | Wait for the interface to come up before starting |
| `--wait-timeout <sec>` | `0` | Max seconds to wait for interface (0 = forever, requires `--wait`) |

### `tsbootkit-bootpd` — BOOTP Server

```bash
npx tsbootkit-bootpd --config tsbootkit.yaml
npx tsbootkit-bootpd <interface> <bootfile> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | — | Path to YAML config file |
| `--tftp-server <ip>` | server IP | TFTP server IP address |
| `--gateway <ip>` | server IP | Default gateway IP |
| `--dns <ip>...` | — | DNS server IP(s) |
| `--pid-file <path>` | — | Write PID to file (stale PID auto-cleaned) |
| `-v, --verbose` | — | Increase verbosity |
| `--wait` | `false` | Wait for the interface to come up before starting |
| `--wait-timeout <sec>` | `0` | Max seconds to wait for interface (0 = forever, requires `--wait`) |

### `tsbootkit-netconsoled` — Netconsole Listener

```bash
npx tsbootkit-netconsoled --port 6666 --address 0.0.0.0
npx tsbootkit-netconsoled --config tsbootkit.yaml
```

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | — | Path to YAML config file |
| `--port <port>` | `6666` | UDP port to listen on (0 = disabled) |
| `--address <ip>` | `0.0.0.0` | Address to bind |
| `--level <level>` | `info` | Log level for received messages |
| `--pid-file <path>` | — | Write PID to file (stale PID auto-cleaned) |
| `-v, --verbose` | — | Increase verbosity |

### Config vs. CLI Flags

When both `--config` and CLI flags are provided:

- **`--verbose` always wins** over `logging.level` in the config file
- `--health-port` and `--http-port` override config values
- `--mdns-address` overrides the config value
- Other CLI flags are defaults when `--config` is absent; the config file takes precedence when present

### PID File and Stale Process Detection

All daemons support `--pid-file <path>` for process tracking. On startup:

1. If the PID file doesn't exist, it's created with the current PID
2. If the file exists and the listed PID is still running, the daemon **refuses to start** (prevents duplicate instances)
3. If the file exists but the listed PID is **not running** (stale PID from a crash), the file is **automatically overwritten** and the daemon starts normally

The PID file is cleaned up on graceful shutdown. If the process is killed (`kill -9`), the stale file will be cleaned up on the next start.

## Programmatic API

Everything works as a library:

```typescript
import {
  PXEServer, TFTPServer, DHCPServer, BOOTPServer,
  NetconsoleServer,
  TFTPClient,
  createLogger, createLogBuffer, setLogBuffer,
  type HookConfig,
  type TsbootkitLevel,
  type BufferedLogEntry,
} from 'tsbootkit';

// ── Full PXE daemon ──────────────────────────────────────────

const pxe = new PXEServer({
  interface: 'eth0',
  bootFile: 'pxelinux.0',
  tftpRoot: '/tftpboot',
  mode: 'dhcp',                   // 'dhcp' or 'bootp'
  bootFiles: {
    bios: 'pxelinux.0',
    efiX86_64: 'bootx64.efi',
  },
  reservations: [
    { mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.1.50', hostname: 'build-server' },
  ],
  hooks: [
    { exec: '/usr/local/bin/on-boot.sh', events: ['post', 'ack'] },
  ],
  healthPort: 9470,
  httpPort: 80,
});
await pxe.start();

// ── Standalone TFTP server ───────────────────────────────────

const tftp = new TFTPServer({
  root: '/tftpboot',
  port: 69,
  maxTransfers: 16,
  allowWrite: false,
  hooks: [
    { exec: '/usr/local/bin/on-transfer.sh', events: ['post'] },
  ],
});
await tftp.start();

// ── Standalone DHCP server ───────────────────────────────────

const dhcp = new DHCPServer({
  interface: 'eth0',
  bootFile: 'pxelinux.0',
  leaseTime: 600,
  answerAll: false,
  hooks: [
    { exec: '/usr/local/bin/on-ack.sh', events: ['ack'] },
  ],
});
dhcp.addReservation('aa:bb:cc:dd:ee:01', '192.168.1.50', 'bootx64.efi');
await dhcp.start();

// ── Standalone BOOTP server ──────────────────────────────────

const bootp = new BOOTPServer({
  interface: 'eth0',
  bootFile: 'pxelinux.0',
  hooks: [
    { exec: '/usr/local/bin/on-reply.sh', events: ['reply'] },
  ],
});
bootp.addReservation('11:22:33:44:55:66', '192.168.1.51');
await bootp.start();

// ── Netconsole listener ──────────────────────────────────────

const netconsole = new NetconsoleServer({
  port: 6666,
  address: '192.168.1.1',
  level: 'info',
  hooks: [
    { exec: '/usr/local/bin/on-panic.sh', events: ['message'] },
  ],
});
netconsole.on('message', (msg) => {
  console.log(`[${msg.source}] ${msg.text}`);
});
await netconsole.start();

// ── Log buffer for dashboard/API ────────────────────────────

const buffer = createLogBuffer(500);
setLogBuffer(buffer);  // all future createLogger() calls attach it

// Read the buffer at any time
const entries: BufferedLogEntry[] = buffer.getEntries();
console.log(`Buffer has ${buffer.size}/${buffer.capacity} entries`);

// ── TFTP client ──────────────────────────────────────────────

const client = new TFTPClient({ host: '192.168.1.1', port: 69 });

// Download
const result = await client.get('bootx64.efi', '/tmp/bootx64.efi');
console.log(`Downloaded ${result.bytes} bytes in ${result.durationMs}ms`);

// Upload
await client.put('/tmp/report.txt', 'upload/report.txt');

// Ping (check if server is responding)
const alive = await client.ping();

// LAN-optimized transfer (blksize=1400, windowsize=8)
const lanClient = new TFTPClient({ host: '192.168.1.1', port: 69, lan: true });

// RFC 1350 strict mode (no option negotiation)
const rfcClient = new TFTPClient({ host: '192.168.1.1', port: 69, rfc1350: true });

// ── Logging ──────────────────────────────────────────────────

const logger = createLogger('my-app', {
  level: 'debug',                 // error | warn | info | debug | trace
  file: '/var/log/tsbootkit.log', // optional: JSON log file
});
```

## Web Dashboard

Hit `http://your-pxe-server:9470/ui/` for a live status page:

- Server status, uptime, mode, interface
- Active TFTP transfers with progress bars
- DHCP leases with expiry countdowns
- Configured reservations
- Service indicators (TFTP, DHCP, HTTP, mDNS, netconsole)
- **Log stream** — live scrolling log output from all components with a runtime level selector

The dashboard runs on the health check server — no extra port needed.

### API Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /health` | Health check (JSON, for Docker/init) |
| `GET /api/status` | Full status with transfers, leases, reservations, log entries |
| `PUT /api/log/level` | Change log level at runtime (`{ "level": "debug" }`) |
| `GET /ui/` | Dashboard HTML |

## Health Check

```bash
curl http://localhost:9470/health
```

Returns JSON with status (`ok`/`degraded`/`down`), uptime, active transfers, DHCP leases. Includes an `interface` field with the interface name, status (`up`/`down`/`missing`/`ip-changed`), and address. Returns 503 when status is `down` or `degraded`.

## Docker

Multi-arch image (amd64 + arm64) with tini as PID 1 and a built-in HEALTHCHECK:

```bash
docker run --net=host \
  -v ./config.yaml:/etc/tsbootkit.yaml \
  -v ./tftpboot:/tftpboot \
  ghcr.io/thehonker/tsbootkit:latest
```

### Custom TFTP Port

```bash
docker run --net=host \
  -v ./config.yaml:/etc/tsbootkit.yaml \
  -v ./tftpboot:/tftpboot \
  ghcr.io/thehonker/tsbootkit:latest \
  node dist/cli/pxed.mjs --config /etc/tsbootkit.yaml --tftp-port 6969
```

### mDNS in Docker

Containers on `0.0.0.0` need to advertise the host IP:

```yaml
mdnsAddress: 192.168.1.1   # your host IP
```

### Volumes

| Mount | Description |
| --- | --- |
| `/etc/tsbootkit.yaml` | Config file (set `TSBOOTKIT_CONFIG` env var to change path) |
| `/tftpboot` | TFTP root directory with boot files |

### Ports

| Port | Protocol | Description |
| --- | --- | --- |
| 67 | UDP | DHCP server |
| 69 | UDP | TFTP server |
| 9470 | TCP | Health check + dashboard |
| 6666 | UDP | Netconsole listener (when enabled) |

Note: DHCP (port 67) requires `--net=host` or `NET_ADMIN` capability.

The image includes a CycloneDX SBOM annotation. Pull the SBOM from the GitHub release assets.

## RFC Compliance

| RFC | Title |
| --- | --- |
| 951 | BOOTP |
| 1497 | BOOTP Extensions |
| 1533 | DHCP Options and BOOTP Vendor Extensions |
| 2131 | Dynamic Host Configuration Protocol |
| 1350 | TFTP Protocol (Rev 2) |
| 2347 | TFTP Option Extension |
| 2348 | TFTP Blocksize Option |
| 2349 | TFTP Timeout Interval & Transfer Size |
| 4578 | DHCP Client Architecture (option 93) |
| 7233 | HTTP Range Requests |
| 7440 | TFTP Windowsize Option |

## Development

```bash
npm install          # install dependencies
npm test             # run tests (vitest)
npm run build        # build + generate SBOM (tsup)
npx tsc --noEmit     # type check
npm run lint         # lint
```

## TODO

- [ ] Multicast TFTP (RFC 2090) — one-to-many firmware pushes
- [ ] DHCPv6 / PXE over IPv6 — ground-up new protocol
- [ ] Syslinux/iPXE config parser — walk `pxelinux.cfg/` for auto-discovered boot menus
- [ ] Plugin system — loadable modules for custom request handling
- [ ] Track total bytes transferred across all TFTP sessions

## License

GPL-3.0
