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

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    const f = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(f).pipe(res); }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Banner & Blade server is running. Put the game in server/public/index.html to serve it from here.');
  }
  res.writeHead(404); res.end('Not found');
});
const io = new Server(server, { cors: { origin: ORIGINS, methods: ['GET', 'POST'] }, maxHttpBufferSize: 1e5, pingInterval: 10000, pingTimeout: 15000 });
const hub = createHub(Sim, { log: (m) => console.log(new Date().toISOString(), m) });
hub.start();
io.on('connection', (sock) => {
  const h = hub.connect(sock.id, (ev, data) => sock.emit(ev, data));
  sock.onAny((ev, ...args) => { const ack = typeof args[args.length - 1] === 'function' ? args.pop() : undefined; h.handle(ev, args[0], ack); });
  sock.on('disconnect', () => h.disconnect());
});
server.listen(PORT, () => console.log('Banner & Blade server listening on port ' + PORT));
