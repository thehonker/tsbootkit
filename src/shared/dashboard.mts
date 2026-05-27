/**
 * Web dashboard — single-page status UI for tsbootkit.
 *
 * Adds `/api/*` and `/ui/` routes to the health check HTTP server.
 * Zero dependencies — vanilla HTML + JS, served from a string constant.
 * 5-second polling, no WebSocket, no framework.
 */

import type { HealthCheckServer } from './health.mjs';

// ─── API data types ────────────────────────────────────────────────

export interface DashboardTransfer {
  filename: string;
  direction: 'rrq' | 'wrq';
  clientIP: string;
  clientPort: number;
  state: string;
  bytesSent: number;
  bytesReceived: number;
  filesize: number;
  progress: number;
}

export interface DashboardLease {
  ip: string;
  mac: string;
  expires: number;
  uuid?: string;
}

export interface DashboardReservation {
  mac: string;
  ip: string;
  bootFile?: string;
  hostname?: string;
}

export interface DashboardStatus {
  status: 'ok' | 'degraded' | 'down';
  uptime: number;
  pid: number;
  version: string;
  mode: string;
  interface: string;
  bootFile: string;
  tftp: {
    activeTransfers: number;
    transfers: DashboardTransfer[];
  } | null;
  dhcp: {
    activeLeases: number;
    leases: DashboardLease[];
    reservations: DashboardReservation[];
  } | null;
  bootp: {
    allocated: number;
  } | null;
  http: {
    enabled: boolean;
  } | null;
  mdns: {
    enabled: boolean;
  } | null;
}

// ─── Dashboard data provider ───────────────────────────────────────

/**
 * Function that gathers dashboard data from server internals.
 * The PXE server provides this — it has access to TFTP + DHCP state.
 */
export type DashboardDataProvider = () => DashboardStatus;

// ─── Route handler ─────────────────────────────────────────────────

/**
 * Register dashboard routes on the health check server's HTTP instance.
 *
 * Routes:
 *   GET /api/status   — JSON status with transfers, leases, reservations
 *   GET /ui/          — Single-page dashboard HTML
 *   GET /ui           — Redirect to /ui/
 */
export function registerDashboardRoutes(
  server: HealthCheckServer,
  provider: DashboardDataProvider,
): void {
  server.addRoute('GET', '/api/status', async (_req, res) => {
    try {
      const status = provider();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.addRoute('GET', '/ui', async (_req, res) => {
    res.writeHead(302, { Location: '/ui/' });
    res.end();
  });

  server.addRoute('GET', '/ui/', async (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(DASHBOARD_HTML);
  });
}

// ─── Dashboard HTML ────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tsbootkit</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px}
h1{font-size:20px;color:#58a6ff;margin-bottom:4px}
.subtitle{color:#8b949e;font-size:13px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
@media(max-width:768px){.grid{grid-template-columns:1fr}}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
.card h2{font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
.stat{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #21262d}
.stat:last-child{border-bottom:none}
.stat .label{color:#8b949e;font-size:13px}
.stat .value{color:#c9d1d9;font-size:13px;font-weight:600}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
.badge-ok{background:#0d419d;color:#58a6ff}
.badge-down{background:#6e1616;color:#f85149}
.badge-wrq{background:#6e5b14;color:#d29922}
.badge-rrq{background:#0d419d;color:#58a6ff}
.badge-state{background:#21262d;color:#8b949e}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#8b949e;font-weight:500;padding:8px 4px;border-bottom:1px solid #30363d}
td{padding:8px 4px;border-bottom:1px solid #21262d}
.progress-bar{background:#21262d;border-radius:4px;height:6px;overflow:hidden;width:100px;display:inline-block;vertical-align:middle}
.progress-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#1f6feb,#58a6ff);transition:width .3s}
.empty{color:#484f58;font-style:italic;padding:12px 0}
.refresh{color:#484f58;font-size:11px}
</style>
</head>
<body>
<h1>tsbootkit</h1>
<div class="subtitle">PXE/TFTP Toolkit Dashboard</div>
<div class="grid" id="stats"></div>
<h2 style="font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Active Transfers</h2>
<div id="transfers"></div>
<h2 style="font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin:24px 0 12px">DHCP Leases</h2>
<div id="leases"></div>
<h2 style="font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin:24px 0 12px">Reservations</h2>
<div id="reservations"></div>
<div class="refresh" id="refresh"></div>
<script>
function fmt(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(2)+' GB'}
function fmtTime(s){s=Math.floor(s);const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),ss=s%60;let r='';if(d)r+=d+'d ';if(h)r+=h+'h ';if(m)r+=m+'m ';r+=ss+'s';return r}
function fmtExpires(ts){if(!ts)return '-';const d=ts-Date.now();if(d<=0)return 'expired';return Math.floor(d/60000)+'m'}
function esc(s){const d=document.createElement('span');d.textContent=s;return d.innerHTML}
function badge(text,cls){return '<span class="badge badge-'+cls+'">'+esc(text)+'</span>'}
function refresh(){
  fetch('/api/status').then(r=>r.json()).then(data=>{
    let stats='<div class="card"><h2>Server</h2>';
    stats+='<div class="stat"><span class="label">Status</span><span class="value">'+badge(data.status,data.status)+'</span></div>';
    stats+='<div class="stat"><span class="label">Uptime</span><span class="value">'+fmtTime(data.uptime)+'</span></div>';
    stats+='<div class="stat"><span class="label">Mode</span><span class="value">'+esc(data.mode)+'</span></div>';
    stats+='<div class="stat"><span class="label">Interface</span><span class="value">'+esc(data.interface)+'</span></div>';
    stats+='<div class="stat"><span class="label">Boot File</span><span class="value">'+esc(data.bootFile)+'</span></div>';
    stats+='<div class="stat"><span class="label">PID</span><span class="value">'+data.pid+'</span></div>';
    stats+='</div>';
    stats+='<div class="card"><h2>Services</h2>';
    if(data.tftp)stats+='<div class="stat"><span class="label">TFTP</span><span class="value">'+data.tftp.activeTransfers+' transfers</span></div>';
    if(data.dhcp)stats+='<div class="stat"><span class="label">DHCP</span><span class="value">'+data.dhcp.activeLeases+' leases</span></div>';
    if(data.bootp)stats+='<div class="stat"><span class="label">BOOTP</span><span class="value">'+data.bootp.allocated+' allocated</span></div>';
    if(data.http)stats+='<div class="stat"><span class="label">HTTP</span><span class="value">'+badge('enabled','ok')+'</span></div>';
    if(data.mdns)stats+='<div class="stat"><span class="label">mDNS</span><span class="value">'+badge('enabled','ok')+'</span></div>';
    stats+='</div>';
    document.getElementById('stats').innerHTML=stats;
    if(data.tftp&&data.tftp.transfers.length>0){
      let t='<table><tr><th>File</th><th>Dir</th><th>Client</th><th>Progress</th><th>Size</th><th>State</th></tr>';
      data.tftp.transfers.forEach(x=>{
        const pct=x.progress;
        t+='<tr><td>'+esc(x.filename)+'</td><td>'+badge(x.direction,x.direction)+'</td><td>'+esc(x.clientIP)+':'+x.clientPort+'</td>';
        t+='<td><div class="progress-bar"><div class="progress-fill" style="width:'+pct+'%"></div></div> '+pct+'%</td>';
        t+='<td>'+fmt(x.bytesSent||x.bytesReceived)+'</td><td>'+badge(x.state,'state')+'</td></tr>';
      });
      t+='</table>';document.getElementById('transfers').innerHTML=t;
    }else{
      document.getElementById('transfers').innerHTML='<div class="empty">No active transfers</div>';
    }
    if(data.dhcp&&data.dhcp.leases.length>0){
      let l='<table><tr><th>IP</th><th>MAC</th><th>Expires</th><th>UUID</th></tr>';
      data.dhcp.leases.forEach(x=>{
        l+='<tr><td>'+esc(x.ip)+'</td><td>'+esc(x.mac)+'</td><td>'+fmtExpires(x.expires)+'</td><td>'+(x.uuid?esc(x.uuid):'-')+'</td></tr>';
      });
      l+='</table>';document.getElementById('leases').innerHTML=l;
    }else{
      document.getElementById('leases').innerHTML='<div class="empty">No active leases</div>';
    }
    if(data.dhcp&&data.dhcp.reservations.length>0){
      let r='<table><tr><th>MAC</th><th>IP</th><th>Boot File</th><th>Hostname</th></tr>';
      data.dhcp.reservations.forEach(x=>{
        r+='<tr><td>'+esc(x.mac)+'</td><td>'+esc(x.ip)+'</td><td>'+(x.bootFile?esc(x.bootFile):'-')+'</td><td>'+(x.hostname?esc(x.hostname):'-')+'</td></tr>';
      });
      r+='</table>';document.getElementById('reservations').innerHTML=r;
    }else{
      document.getElementById('reservations').innerHTML='<div class="empty">No reservations</div>';
    }
    document.getElementById('refresh').textContent='Updated '+new Date().toLocaleTimeString();
  }).catch(err=>{
    document.getElementById('refresh').textContent='Error: '+err.message;
  });
}
refresh();setInterval(refresh,5000);
</script>
</body>
</html>`;
