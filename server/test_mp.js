/* Hub test: drives the real lobby/match logic with in-process fake sockets (no network needed). */
'use strict';
const Sim = require('./sim.js'); const { createHub } = require('./hub.js');
const hub = createHub(Sim, {}); hub.start();
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
function mk(id, name) {
  const c = { id, name, ev: [], snaps: 0, last: null, start: null, end: null, room: null, closed: null };
  const h = hub.connect(id, (ev, d) => { c.ev.push(ev); if (ev === 'snap') { c.snaps++; c.last = d; } if (ev === 'start') c.start = d; if (ev === 'end') c.end = d; if (ev === 'room') c.room = d; if (ev === 'closed') c.closed = d; });
  c.call = (ev, d) => new Promise(r => { h.handle(ev, d, r); setTimeout(() => r(null), 50); });
  c.h = h; return c;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const A = mk('a1', 'Alice'), B = mk('b1', 'Bob'), C = mk('c1', 'Cara');
  let r = await A.call('create', { name: 'Alice', isPrivate: false, cfg: { map: 'castle', mode: 'tdm', n: 6 } });
  ok(r && r.ok && r.code.length === 4, 'create room ' + (r && r.code));
  const code = r.code;
  r = await B.call('list'); ok(r.rooms.some(x => x.code === code), 'public room listed');
  r = await B.call('join', { code: 'ZZZZ', name: 'Bob' }); ok(!r.ok, 'join unknown code rejected');
  r = await B.call('join', { code: code.toLowerCase(), name: 'Bob' }); ok(r.ok, 'join by code');
  r = await C.call('join', { code, name: 'Alice' }); ok(r.ok && C.room.players.some(p => p.name !== 'Alice'), 'duplicate names made unique: ' + C.room.players.map(p => p.name));
  ok(A.room.players.length === 3, 'lobby shows 3 players');
  ok(new Set(A.room.players.map(p => p.team)).size === 2, 'auto team balance');
  r = await B.call('setClass', { cls: 'archer' }); ok(r.ok, 'set class');
  r = await B.call('setClass', { cls: 'dragon' }); ok(!r.ok, 'bad class rejected');
  r = await C.call('setClass', { cls: 'spearman' });
  r = await B.call('setConfig', { cfg: { map: 'village' } }); ok(!r.ok, 'non-host cannot change config');
  r = await A.call('setConfig', { cfg: { map: 'palace', mode: 'ironsquad', n: 99999, duration: 5 } });
  ok(r.ok && A.room.cfg.map === 'palace' && A.room.cfg.mode === 'ironsquad' && A.room.cfg.n === 24 && A.room.cfg.duration === 360, 'host config sanitised ' + JSON.stringify(A.room.cfg));
  r = await A.call('setConfig', { cfg: { map: 'castle', mode: 'manhunt' } }); ok(A.room.cfg.mode === 'ironsquad', 'unsupported mode refused');
  r = await A.call('setConfig', { cfg: { map: 'castle', mode: 'tdm', n: 6 } });
  r = await B.call('start'); ok(!r.ok, 'non-host cannot start');
  r = await A.call('start'); ok(r.ok, 'host starts');
  ok(A.start && B.start && C.start, 'all clients got start');
  ok(A.start.init.length === 12, 'soldier list = 12 (3 humans + AI fill): ' + A.start.init.length);
  const ia = A.start.you, ib = B.start.you;
  ok(ia >= 0 && ib >= 0 && ia !== ib, 'distinct fighter slots ' + ia + ',' + ib);
  ok(B.start.init[ib][1] === 'archer' && C.start.init[C.start.you][1] === 'spearman', 'classes carried into the match');
  ok(A.start.init.filter(s => s[4]).length === 3, 'exactly 3 human fighters');
  await sleep(400);
  ok(A.snaps >= 4, 'snapshots streaming (' + A.snaps + ')');
  const x0 = A.last.s[ia][0], z0 = A.last.s[ia][2], hpB0 = B.last.s[ib][4];
  // Alice walks forward, validated; Bob sends junk
  const feed = setInterval(() => { A.h.handle('input', { mx: 0, mz: 1, yaw: 0, attack: false, block: false, sprint: true, jump: false }); B.h.handle('input', { mx: 9e9, mz: NaN, yaw: 'x', attack: 1, block: 0, aim: { x: 1e9, y: 0, z: 0 } }); }, 33);
  await sleep(2500);
  const s = A.last.s[ia], dist = Math.hypot(s[0] - x0, s[2] - z0);
  ok(dist > 4 && dist < 40, 'Alice moved by server physics: ' + dist.toFixed(1) + ' m');
  ok(isFinite(B.last.s[ib][0]) && isFinite(B.last.s[ib][3]), 'junk input did not corrupt state');
  // cheating attempts must not change authoritative state
  A.h.handle('input', { mx: 0, mz: 0, yaw: 0, hp: 9999, score: 999, x: 500, z: 500, speed: 99, kills: 50 });
  A.h.handle('setScore', { s: 99 }); A.h.handle('hit', { target: 1, dmg: 1e6 });
  await sleep(300);
  ok(A.last.s[ia][4] <= 141 && Math.abs(A.last.s[ia][0]) < 200 && A.last.sc[1] < 50, 'client-supplied hp/score/position ignored');
  // events flow
  await sleep(2500);
  ok(A.ev.includes('ev'), 'combat events delivered');
  // disconnect -> bot takes over
  B.h.disconnect(); await sleep(200);
  const room = hub.rooms.get(code);
  ok(room.members.size === 2 && !room.match.soldiers.some(q => q.hid === 'b1') && room.match.soldiers[ib].isPlayer === false, 'disconnect handled; AI takes the fighter');
  ok(A.room.players.length === 2, 'lobby list updated after disconnect');
  // end of match
  room.match.time = 0.05; await sleep(400);
  ok(A.end && C.end && typeof A.end.winner === 'number' && A.end.board.length === 12, 'end message with scoreboard (winner ' + A.end.winner + ')');
  // host leaves -> host migrates
  A.h.disconnect(); await sleep(50);
  ok(hub.rooms.get(code).host === 'c1', 'host migrated');
  clearInterval(feed);
  C.h.disconnect(); await sleep(50);
  ok(!hub.rooms.has(code), 'empty room destroyed');

  // FFA + Iron Squad + Conquest quick runs, 2 humans each, all maps
  for (const [mode, map] of [['ffa', 'village'], ['ironsquad', 'palace'], ['ironsquad', 'fortress'], ['tdm', 'castle'], ['conquest', 'palace']]) {
    const P = mk('p' + mode + map, 'P1'), Q = mk('q' + mode + map, 'P2');
    const cr = await P.call('create', { name: 'P1', isPrivate: true, cfg: { map, mode, n: 8 } });
    const pub = (await Q.call('list')).rooms.some(x => x.code === cr.code);
    await Q.call('join', { code: cr.code, name: 'P2' });
    const st = await P.call('start');
    const f2 = setInterval(() => { for (const X of [P, Q]) X.h.handle('input', { mx: Math.random() - .5, mz: 1, yaw: Math.random() * 6, attack: Math.random() < .5, block: false, sprint: true }); }, 33);
    await sleep(2500); clearInterval(f2);
    const rm = hub.rooms.get(cr.code);
    ok(st.ok && !pub && P.snaps > 20 && rm.match && rm.state === 'playing', `${mode}/${map}: private, started, ${P.snaps} snaps, tick ok`);
    P.h.disconnect(); Q.h.disconnect();
  }
  hub.stop(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
