/* Banner & Blade multiplayer server (Node.js + Socket.IO).
   Run:  npm install && npm start   (default port 3000, override with PORT)
   It also serves the game itself from ./public/index.html, so http://localhost:3000 just works. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const Sim = require('./sim.js');
const { createHub } = require('./hub.js');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
// Comma separated list of allowed web origins (e.g. your GitHub Pages address). Default: any origin.
const ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : '*';
const PUBLIC = path.join(__dirname, 'public');

// ---- STAGING-ONLY switches. Everything below is inert unless BB_STAGING_SECRET (24+ characters) is set, which only the
// separate staging service ever does. Without it: no /stats page, no flags honoured, behaviour identical to before.
const STAGING_SECRET = process.env.BB_STAGING_SECRET || '';
const gate = require('./perf/staging_gate.js').stagingGate(process.env);
const STAGING = gate.enabled;
if (STAGING_SECRET && !STAGING) console.log('STAGING MODE REFUSED: ' + gate.reason);
const flags = STAGING ? {
  fixedStep: process.env.BB_FIXED_STEP === '1',
  snapHz: process.env.BB_SNAP_HZ === '15' ? 15 : 20,
  catchupCap: Math.min(0.25, Math.max(0.05, +process.env.BB_CATCHUP_CAP || 0.1)),
  compress: process.env.BB_COMPRESS === '1',
  broadcast: process.env.BB_BROADCAST_ONCE === '1'
} : null;
let statsApi = null;

const server = http.createServer((req, res) => {
  if (STAGING && statsApi && (req.url === '/stats' || req.url.startsWith('/stats?'))) return statsApi.handle(req, res);
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    const f = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(f).pipe(res); }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Banner & Blade server is running. Put the game in server/public/index.html to serve it from here.');
  }
  res.writeHead(404); res.end('Not found');
});
const ioOpts = { cors: { origin: ORIGINS, methods: ['GET', 'POST'] }, maxHttpBufferSize: 1e5, pingInterval: 10000, pingTimeout: 15000 };
if (STAGING && flags.compress) ioOpts.perMessageDeflate = { threshold: 512 };   // staging test of message compression
const io = new Server(server, ioOpts);
const hubOpts = { log: (m) => console.log(new Date().toISOString(), m) };
let hub;
if (STAGING) {
  hubOpts.perf = { fixedStep: flags.fixedStep, snapHz: flags.snapHz, catchupCap: flags.catchupCap, broadcast: flags.broadcast };
  hubOpts.broadcast = (ids, ev, data) => io.to(ids).emit(ev, data);   // encodes once, sends to every listed socket
  const holder = { onStep() {}, onSnapshot() {}, onDiscard() {} };
  hubOpts.perf.stats = holder;
  hub = createHub(Sim, hubOpts);
  statsApi = require('./perf/stats.js').createStats({ hub, io, flags, secret: STAGING_SECRET });
  holder.onStep = statsApi.collector.onStep; holder.onSnapshot = statsApi.collector.onSnapshot; holder.onDiscard = statsApi.collector.onDiscard;
  console.log('STAGING MODE: switches ' + JSON.stringify(flags));
} else hub = createHub(Sim, hubOpts);
hub.start();
io.on('connection', (sock) => {
  const h = hub.connect(sock.id, (ev, data) => sock.emit(ev, data));
  sock.onAny((ev, ...args) => { const ack = typeof args[args.length - 1] === 'function' ? args.pop() : undefined; h.handle(ev, args[0], ack); });
  sock.on('disconnect', () => h.disconnect());
});
server.listen(PORT, () => console.log('Banner & Blade server listening on port ' + PORT));
