/**
 * Web dashboard — single-page status UI for tsbootkit.
 *
 * Adds `/api/*` and `/ui/` routes to the health check HTTP server.
 * Zero dependencies — vanilla HTML + JS, served from a string constant.
 * 5-second polling, no WebSocket, no framework.
 */

import type { HealthCheckServer } from './health.mjs';
import type { BufferedLogEntry } from './log-buffer.mjs';

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

export interface DashboardHTTPTransfer {
  id: number;
  method: string;
  path: string;
  clientIP: string;
  state: string;
  bytesSent: number;
  fileSize: number;
  startedAt: number;
  statusCode?: number;
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
    activeTransfers: number;
    transfers: DashboardHTTPTransfer[];
  } | null;
  mdns: {
    enabled: boolean;
  } | null;
  netconsole: {
    enabled: boolean;
    port: number;
    messageCount: number;
  } | null;
  log: {
    entries: BufferedLogEntry[];
    bufferSize: number;
    level: string;
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
 *   GET /api/status    — JSON status with transfers, leases, reservations, log
 *   PUT /api/log/level — Change log level at runtime
 *   GET /ui/           — Single-page dashboard HTML
 *   GET /ui            — Redirect to /ui/
 */
export function registerDashboardRoutes(
  server: HealthCheckServer,
  provider: DashboardDataProvider,
  onLogLevelChange?: (level: string) => void,
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

  server.addRoute('PUT', '/api/log/level', async (req, res) => {
    try {
      const body = await new Promise<string>((resolve, reject) => {
        let data = '';
        req.on('data', (chunk: string) => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });

      const parsed = JSON.parse(body);
      const level = parsed.level;
      const validLevels = ['error', 'warn', 'info', 'debug', 'trace'];

      if (!level || !validLevels.includes(level)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid level. Must be one of: ${validLevels.join(', ')}` }));
        return;
      }

      if (onLogLevelChange) {
        onLogLevelChange(level);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ level }));
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
.badge-http{background:#0d419d;color:#58a6ff}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#8b949e;font-weight:500;padding:8px 4px;border-bottom:1px solid #30363d}
td{padding:8px 4px;border-bottom:1px solid #21262d}
.progress-bar{background:#21262d;border-radius:4px;height:6px;overflow:hidden;width:100px;display:inline-block;vertical-align:middle}
.progress-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#1f6feb,#58a6ff);transition:width .3s}
.empty{color:#484f58;font-style:italic;padding:12px 0}
.refresh{color:#484f58;font-size:11px}
.log-controls{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.log-controls label{color:#8b949e;font-size:13px}
.log-controls select{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:13px}
.log-panel{background:#010409;border:1px solid #30363d;border-radius:8px;padding:12px;max-height:350px;overflow-y:auto;font-family:'SF Mono',Monaco,'Courier New',monospace;font-size:12px;line-height:1.6}
.log-line{white-space:pre-wrap;word-break:break-all}
.log-ts{color:#484f58}
.log-error{color:#f85149}
.log-warn{color:#d29922}
.log-info{color:#58a6ff}
.log-debug{color:#8b949e}
.log-trace{color:#484f58}
.log-label{color:#7ee787}
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
<h2 style="font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin:24px 0 12px">HTTP Transfers</h2>
<div id="http-transfers"></div>
<h2 style="font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin:24px 0 12px">Reservations</h2>
<div id="reservations"></div>
<div id="netconsole-section"></div>
<h2 style="font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin:24px 0 12px">Log Stream</h2>
<div class="log-controls">
  <label>Level:</label>
  <select id="log-level">
    <option value="error">error</option>
    <option value="warn">warn</option>
    <option value="info" selected>info</option>
    <option value="debug">debug</option>
    <option value="trace">trace</option>
  </select>
  <span id="log-count" style="color:#484f58;font-size:12px"></span>
</div>
<div class="log-panel" id="log-panel"><div class="empty">No log entries yet</div></div>
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
    if(data.http)stats+='<div class="stat"><span class="label">HTTP</span><span class="value">'+(data.http.activeTransfers?data.http.activeTransfers+' transfers':badge('enabled','ok'))+'</span></div>';
    if(data.mdns)stats+='<div class="stat"><span class="label">mDNS</span><span class="value">'+badge('enabled','ok')+'</span></div>';
    if(data.netconsole)stats+='<div class="stat"><span class="label">Netconsole</span><span class="value">'+badge('enabled','ok')+' port '+data.netconsole.port+'</span></div>';
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
    if(data.http&&data.http.transfers&&data.http.transfers.length>0){
      let h='<table><tr><th>Path</th><th>Method</th><th>Client</th><th>Size</th><th>Status</th><th>State</th></tr>';
      data.http.transfers.forEach(x=>{
        h+='<tr><td>'+esc(x.path)+'</td><td>'+esc(x.method)+'</td><td>'+esc(x.clientIP)+'</td>';
        h+='<td>'+fmt(x.bytesSent)+'</td><td>'+(x.statusCode?x.statusCode:'-')+'</td><td>'+badge(x.state,'state')+'</td></tr>';
      });
      h+='</table>';document.getElementById('http-transfers').innerHTML=h;
    }else{
      document.getElementById('http-transfers').innerHTML='<div class="empty">No HTTP transfers</div>';
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
    if(data.netconsole&&data.netconsole.enabled){
      document.getElementById('netconsole-section').innerHTML='<h2 style="font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin:24px 0 12px">Netconsole</h2><div class="card"><div class="stat"><span class="label">Port</span><span class="value">'+data.netconsole.port+'</span></div><div class="stat"><span class="label">Messages</span><span class="value">'+data.netconsole.messageCount+'</span></div></div>';
    }else{
      document.getElementById('netconsole-section').innerHTML='';
    }
    // Log stream
    if(data.log){
      const sel=document.getElementById('log-level');
      if(sel&&data.log.level&&sel.value!==data.log.level){sel.value=data.log.level;}
      const panel=document.getElementById('log-panel');
      const countEl=document.getElementById('log-count');
      if(countEl)countEl.textContent=data.log.bufferSize+' entries';
      if(panel){
        const wasAtBottom=panel.scrollHeight-panel.clientHeight-panel.scrollTop<30;
        if(data.log.entries.length>0){
          let html='';
          data.log.entries.forEach(e=>{
            html+='<div class="log-line"><span class="log-ts">'+esc(e.timestamp)+'</span> <span class="log-'+esc(e.level)+'">'+esc(e.level.toUpperCase().padEnd(5))+'</span> <span class="log-label">'+esc(e.label)+'</span> '+esc(e.message)+'</div>';
          });
          panel.innerHTML=html;
        }else{
          panel.innerHTML='<div class="empty">No log entries yet</div>';
        }
        if(wasAtBottom){panel.scrollTop=panel.scrollHeight;}
      }
    }
    document.getElementById('refresh').textContent='Updated '+new Date().toLocaleTimeString();
  }).catch(err=>{
    document.getElementById('refresh').textContent='Error: '+err.message;
  });
}
// Log level selector
(function(){
  const sel=document.getElementById('log-level');
  if(sel){
    sel.addEventListener('change',function(){
      fetch('/api/log/level',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({level:sel.value})}).catch(()=>{});
    });
  }
})();
refresh();setInterval(refresh,5000);
</script>
</body>
</html>`;
