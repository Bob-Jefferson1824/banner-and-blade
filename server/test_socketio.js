'use strict';
/* REAL Socket.IO test: starts server.js (real socket.io) on a free port and drives it with socket.io-client.
   Exit codes: 0 passed, 1 failed, 3 NOT RUN (packages missing). Needs: npm install. */
try { require('socket.io'); require('socket.io-client'); } catch (e) { console.log('NOT RUN: socket.io / socket.io-client are not installed (run npm install)'); process.exit(3); }
const { spawn } = require('child_process'); const path = require('path'); const { io } = require('socket.io-client');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 3900 + Math.floor(Math.random() * 90);
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  await sleep(1200);
  const mk = (name) => new Promise((res, rej) => { const s = io('http://localhost:' + PORT, { transports: ['websocket'], reconnection: false }); s.st = { snaps: 0, ev: 0, start: null, end: null, room: null }; s.on('snap', () => s.st.snaps++); s.on('ev', () => s.st.ev++); s.on('start', d => s.st.start = d); s.on('end', d => s.st.end = d); s.on('room', d => s.st.room = d); s.on('connect', () => res(s)); s.on('connect_error', rej); });
  const call = (s, ev, d) => new Promise(r => s.emit(ev, d || {}, r));
  try {
    const health = await fetch('http://localhost:' + PORT + '/health').then(r => r.text()).catch(() => ''); ok(health === 'ok', '/health answers over HTTP');
    const A = await mk('A'), B = await mk('B'); ok(!!A.id && A.id !== B.id, 'two real Socket.IO connections established');
    let r = await call(A, 'create', { name: 'Alice', cfg: { map: 'castle', mode: 'tdm', n: 6 } }); ok(r.ok && r.code.length === 4, 'create room with acknowledgement over the wire');
    r = await call(B, 'join', { code: r.code, name: 'Bob' }); ok(r.ok, 'join by code');
    await sleep(200); ok(A.st.room && A.st.room.players.length === 2, 'lobby broadcast reaches the host');
    r = await call(A, 'start'); ok(r.ok, 'host starts'); await sleep(300);
    ok(A.st.start && B.st.start && A.st.start.you !== B.st.start.you, 'start message (with each player\'s own slot) delivered');
    const iv = setInterval(() => { A.emit('input', { mx: 0, mz: 1, yaw: 0, sprint: true, attack: false }); B.emit('input', { mx: 1, mz: 0, yaw: 1, attack: true }); }, 33);
    await sleep(3000); clearInterval(iv);
    ok(A.st.snaps > 40 && B.st.snaps > 40, `snapshots stream at ~20 Hz (A got ${A.st.snaps} in 3 s)`);
    ok(A.st.ev > 0, 'combat events delivered');
    B.close(); await sleep(300); ok(A.st.room.players.length === 1, 'disconnect removes the player from the room');
    A.close();
  } catch (e) { fails++; console.log('FAIL crash', e.message); }
  srv.kill(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
