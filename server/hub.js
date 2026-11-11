/* Banner & Blade multiplayer hub: lobby + authoritative match logic, independent of the transport.
   server.js plugs Socket.IO into it; the tests plug in plain in-process "sockets".
   The server runs the very same Sim as the browser (sim.js is generated from the game file), so the
   server decides every hit, death, respawn and score. Clients only send their controls. */
'use strict';
const MAPS = ['castle', 'village', 'fortress', 'palace'];
const MODES = ['tdm', 'ffa', 'ironsquad', 'conquest'];          // modes supported online
const CLASSES = ['knight', 'archer', 'crossbowman', 'scout', 'spearman'];
const MAX_HUMANS = 8, MIN_HUMANS = 1;
const TICK = 1 / 30, SNAP_EVERY = 1 / 20, LOBBY_IDLE_MS = 30 * 60 * 1000;
const r2 = (v) => Math.round(v * 100) / 100;
const fin = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clampN = (v, a, b, d) => Math.min(b, Math.max(a, fin(v, d)));

function createHub(Sim, opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const rooms = new Map();     // code -> room
  const clients = new Map();   // id -> client
  let timer = null, last = Date.now();

  function code() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; if (!rooms.has(c)) return c; } }
  const cleanName = (n, fb) => { n = String(n == null ? '' : n).replace(/[^\w \-.]/g, '').trim().slice(0, 16); return n || fb; };
  const humansOf = (room) => [...room.members.values()];

  function lobbyState(room) {
    return {
      code: room.code, isPrivate: room.isPrivate, state: room.state, host: room.host,
      cfg: room.cfg, max: MAX_HUMANS,
      players: humansOf(room).map(m => ({ id: m.id, name: m.name, team: m.team, cls: m.cls, host: m.id === room.host }))
    };
  }
  function broadcastRoom(room) { const st = lobbyState(room); for (const m of room.members.values()) m.client.send('room', st); }
  function listRooms() {
    return [...rooms.values()].filter(r => !r.isPrivate).map(r => ({ code: r.code, host: (r.members.get(r.host) || {}).name || '?', players: r.members.size, max: MAX_HUMANS, map: r.cfg.map, mode: r.cfg.mode, state: r.state }));
  }
  function sanitizeCfg(src, base) {
    const c = Object.assign({}, base);
    if (src) {
      if (MAPS.includes(src.map)) c.map = src.map;
      if (MODES.includes(src.mode)) c.mode = src.mode;
      if (src.n != null) c.n = Math.round(clampN(src.n, 4, 24, 10));
      if (src.duration != null) c.duration = [180, 360, 600].includes(+src.duration) ? +src.duration : 360;
      if (['easy', 'normal', 'hard'].includes(src.difficulty)) c.difficulty = src.difficulty;
    }
    if (c.map === 'fortress' && c.mode === 'conquest') c.mode = 'tdm'; // the fortress has no capture flags
    return c;
  }
  function autoTeam(room) { let b = 0, r = 0; for (const m of room.members.values()) m.team === 1 ? b++ : r++; return b <= r ? 1 : 2; }

  function addMember(room, client, name) {
    const m = { id: client.id, name: cleanName(name, 'Player'), team: autoTeam(room), cls: 'knight', client, input: null, inputAt: 0 };
    // unique display names inside a room
    let base = m.name, k = 2; while ([...room.members.values()].some(o => o.name === m.name)) m.name = (base.slice(0, 13) + ' ' + k++);
    room.members.set(client.id, m); client.room = room; return m;
  }
  function removeMember(client) {
    const room = client.room; if (!room) return;
    client.room = null; room.members.delete(client.id);
    if (room.match) { // an AI takes over the fighter
      const s = room.match.soldiers.find(q => q.hid === client.id);
      if (s) { s.isPlayer = false; s.hid = null; s.name = s.name + ' (bot)'; for (const k of ['attack', 'block', 'sprint', 'jump']) s.input[k] = false; s.input.aim = null; }
    }
    if (!room.members.size) return destroyRoom(room);
    if (room.host === client.id) room.host = room.members.keys().next().value;
    broadcastRoom(room);
  }
  function destroyRoom(room) { room.dead = true; rooms.delete(room.code); log('room closed ' + room.code); }

  /* ---------- match life-cycle ---------- */
  function startMatch(room) {
    const ms = humansOf(room), cfg = room.cfg;
    const ffa = cfg.mode === 'ffa';
    let n = cfg.n;
    if (ffa) n = Math.max(n, ms.length); else { const b = ms.filter(m => m.team === 1).length, r = ms.length - b; n = Math.max(n, b, r); }
    const humans = ms.map(m => ({ id: m.id, name: m.name, team: m.team, cls: m.cls }));
    const mcfg = { map: cfg.map, mode: cfg.mode, team: 1, n, duration: cfg.duration, difficulty: cfg.difficulty, humans };
    const match = new Sim.Match(mcfg);
    room.match = match; room.mcfg = mcfg; room.state = 'playing'; room.evq = []; room.snapAcc = 0; room.seq = 0; room.endSent = false;
    const ser = (v) => ser1(room, v);
    match.on((type, d) => { if (type === 'end') return; const sd = ser(d); if (sd !== undefined) room.evq.push([type, sd]); });
    const init = match.soldiers.map(s => [s.team, s.cls, s.name, s.look, s.hid || null, r2(s.maxHp)]);
    for (const m of ms) { const idx = match.soldiers.findIndex(s => s.hid === m.id); m.client.send('start', { cfg: mcfg, init, you: idx }); }
    broadcastRoom(room);
    log(`match started in ${room.code}: ${cfg.map}/${cfg.mode} humans=${ms.length} n=${n}`);
  }
  // events carry soldier objects: replace them by indices (clients rebuild them from their mirror)
  function ser1(room, v, depth) {
    depth = depth || 0;
    if (v == null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    const S = room.match.soldiers;
    if (v.m && v.cls && v.cdef) return { $s: S.indexOf(v) };
    if (v.idx !== undefined && v.owner !== undefined && v.bCount !== undefined) return { $p: v.idx, owner: v.owner };
    if (depth > 2) return undefined;
    if (Array.isArray(v)) return v.map(x => ser1(room, x, depth + 1));
    const o = {}; for (const k of Object.keys(v)) { if (k === 'm' || (k === 'owner' && typeof v[k] === 'object')) continue; const x = ser1(room, v[k], depth + 1); if (x !== undefined) o[k] = x; }
    return o;
  }
  function snapshot(room) {
    const m = room.match;
    return {
      q: ++room.seq, t: r2(m.time), el: r2(m.elapsed), sc: m.scores,
      s: m.soldiers.map(s => [r2(s.x), r2(s.y), r2(s.z), r2(s.yaw), Math.round(s.hp), s.alive ? 1 : 0, r2(s.atkT), s.blocking ? 1 : 0, r2(s.stagger), Math.round(s.stamina), r2(s.drawT), s.loaded ? 1 : 0, r2(s.reloadT), s.kills, s.deaths, r2(s.vx), r2(s.vz), s.sprinting ? 1 : 0, r2(s.respawnT), r2(s.deadT), s.atkSeq, s.isPlayer ? 1 : 0, s.dmgDealt | 0, s.teamKills | 0]),
      a: m.arrows.map(a => [a.id, r2(a.x), r2(a.y), r2(a.z), r2(a.vx), r2(a.vy), r2(a.vz), r2(a.stuck), a.team, a.big ? 1 : 0, a.fire ? 1 : 0, a.stone ? 1 : 0]),
      p: m.points.map(p => [r2(p.v), p.owner, p.bCount, p.rCount])
    };
  }
  function finishRoom(room) {
    const m = room.match; if (!m || room.endSent) return; room.endSent = true;
    const board = m.soldiers.map(s => ({ name: s.name, team: s.team, cls: s.cls, kills: s.kills, deaths: s.deaths, dmg: Math.round(s.dmgDealt || 0), human: !!s.hid }));
    const payload = { winner: m.winner, scores: m.scores, board, elapsed: r2(m.elapsed), s: snapshot(room) };
    for (const mem of room.members.values()) mem.client.send('end', payload);
    setTimeout(() => { // back to the lobby so the group can play again or leave
      if (room.dead) return; room.match = null; room.state = 'lobby'; broadcastRoom(room);
    }, 9000);
  }
  function stepRoom(room, dt) {
    const m = room.match; if (!m) return;
    const now = Date.now();
    // apply the latest validated controls of every human
    for (const mem of room.members.values()) {
      const s = m.soldiers.find(q => q.hid === mem.id); if (!s) continue;
      const i = mem.input, inp = s.input;
      if (!i || now - mem.inputAt > 1500) { inp.mx = inp.mz = 0; inp.attack = inp.block = inp.sprint = inp.jump = false; inp.aim = null; continue; } // no news: stand still
      inp.mx = i.mx; inp.mz = i.mz; inp.yaw = i.yaw; inp.attack = i.attack; inp.block = i.block; inp.sprint = i.sprint; inp.jump = i.jump;
      inp.aim = i.aim ? { x: i.aim.x, y: i.aim.y, z: i.aim.z } : null;
    }
    m.step(dt);
    room.snapAcc += dt;
    if (room.snapAcc >= SNAP_EVERY) {
      room.snapAcc = 0;
      const snap = snapshot(room), ev = room.evq; room.evq = [];
      for (const mem of room.members.values()) { mem.client.send('snap', snap); if (ev.length) mem.client.send('ev', ev); }
    }
    if (m.ended) { if (room.evq.length) { for (const mem of room.members.values()) mem.client.send('ev', room.evq); room.evq = []; } finishRoom(room); }
  }
  function tick() {
    const now = Date.now(); let el = Math.min(0.25, (now - last) / 1000); last = now;
    for (const room of [...rooms.values()]) {
      if (room.dead) continue;
      if (room.match && !room.match.ended) {
        let t = el; try { while (t > 1e-6) { const d = Math.min(TICK, t); stepRoom(room, d); t -= d; } } catch (e) { log('match crashed: ' + (e && e.stack || e)); for (const mem of room.members.values()) mem.client.send('error', { msg: 'Match crashed on the server; returning to lobby.' }); room.match = null; room.state = 'lobby'; broadcastRoom(room); }
      } else if (room.match && room.match.ended) { try { stepRoom(room, 0); } catch (e) {} }
      if (room.state === 'lobby' && now - room.touched > LOBBY_IDLE_MS) { for (const mem of room.members.values()) { mem.client.send('closed', { msg: 'Room closed (idle).' }); mem.client.room = null; } destroyRoom(room); }
    }
  }

  /* ---------- per-connection handler ---------- */
  function connect(id, sendFn) {
    const client = { id, room: null, name: 'Player', msgs: 0, send: (ev, d) => { try { sendFn(ev, d); } catch (e) {} } };
    clients.set(id, client);
    const rl = setInterval(() => { client.msgs = 0; }, 1000); if (rl.unref) rl.unref();
    function handle(ev, data, ack) {
      if (++client.msgs > 200) return;            // flood protection
      ack = typeof ack === 'function' ? ack : () => {};
      data = data && typeof data === 'object' ? data : {};
      const room = client.room;
      if (room) room.touched = Date.now();
      switch (ev) {
        case 'list': return ack({ ok: true, rooms: listRooms() });
        case 'create': {
          if (room) return ack({ ok: false, err: 'Already in a room' });
          const r = { code: code(), isPrivate: !!data.isPrivate, state: 'lobby', host: client.id, members: new Map(), cfg: sanitizeCfg(data.cfg, { map: 'castle', mode: 'tdm', n: 10, duration: 360, difficulty: 'normal' }), match: null, touched: Date.now() };
          rooms.set(r.code, r); addMember(r, client, data.name); broadcastRoom(r); log('room created ' + r.code);
          return ack({ ok: true, code: r.code, you: client.id });
        }
        case 'join': {
          if (room) return ack({ ok: false, err: 'Already in a room' });
          const r = rooms.get(String(data.code || '').toUpperCase().trim());
          if (!r) return ack({ ok: false, err: 'No such room' });
          if (r.state !== 'lobby') return ack({ ok: false, err: 'That match has already started' });
          if (r.members.size >= MAX_HUMANS) return ack({ ok: false, err: 'Room is full' });
          addMember(r, client, data.name); broadcastRoom(r); return ack({ ok: true, code: r.code, you: client.id });
        }
        case 'leave': removeMember(client); return ack({ ok: true });
        case 'setTeam': { if (!room || room.state !== 'lobby') return ack({ ok: false }); const m = room.members.get(client.id); m.team = +data.team === 2 ? 2 : 1; broadcastRoom(room); return ack({ ok: true }); }
        case 'setClass': { if (!room || room.state !== 'lobby') return ack({ ok: false }); if (!CLASSES.includes(data.cls)) return ack({ ok: false, err: 'Bad class' }); room.members.get(client.id).cls = data.cls; broadcastRoom(room); return ack({ ok: true }); }
        case 'setConfig': { if (!room || room.state !== 'lobby' || room.host !== client.id) return ack({ ok: false, err: 'Host only' }); room.cfg = sanitizeCfg(data.cfg, room.cfg); if (typeof data.isPrivate === 'boolean') room.isPrivate = data.isPrivate; broadcastRoom(room); return ack({ ok: true }); }
        case 'kick': { if (!room || room.state !== 'lobby' || room.host !== client.id) return ack({ ok: false }); const t = room.members.get(String(data.id)); if (!t || t.id === client.id) return ack({ ok: false }); t.client.send('closed', { msg: 'You were removed from the room by the host.' }); removeMember(t.client); return ack({ ok: true }); }
        case 'start': {
          if (!room || room.host !== client.id) return ack({ ok: false, err: 'Only the host can start' });
          if (room.state !== 'lobby') return ack({ ok: false, err: 'Already started' });
          if (room.members.size < MIN_HUMANS) return ack({ ok: false, err: 'Need more players' });
          try { startMatch(room); } catch (e) { log('start failed ' + (e && e.stack || e)); room.match = null; room.state = 'lobby'; return ack({ ok: false, err: 'Server could not start the match' }); }
          return ack({ ok: true });
        }
        case 'input': {
          if (!room || !room.match || room.match.ended) return;
          const mem = room.members.get(client.id); if (!mem) return;
          const s = room.match.soldiers.find(q => q.hid === client.id); if (!s) return;
          let mx = fin(data.mx, 0), mz = fin(data.mz, 0); const L = Math.hypot(mx, mz); if (L > 1) { mx /= L; mz /= L; }
          let aim = null;
          if (data.aim && typeof data.aim === 'object') { const a = { x: fin(data.aim.x, NaN), y: fin(data.aim.y, NaN), z: fin(data.aim.z, NaN) }; if (isFinite(a.x + a.y + a.z) && Math.hypot(a.x - s.x, a.z - s.z) < 400) aim = a; }
          mem.input = { mx, mz, yaw: fin(data.yaw, s.yaw), attack: !!data.attack, block: !!data.block, sprint: !!data.sprint, jump: !!data.jump, aim }; mem.inputAt = Date.now();
          return;
        }
        case 'order': { // call / send teammates
          if (!room || !room.match || room.match.ended) return;
          const s = room.match.soldiers.find(q => q.hid === client.id); if (!s || !s.alive || room.match.ffa) return;
          if (data.type === 'call') room.match.call(s);
          else if (data.type === 'send') { const x = fin(data.x, NaN), z = fin(data.z, NaN); if (isFinite(x + z)) room.match.send(s, x, z); }
          return;
        }
        case 'ping': return ack({ ok: true, t: Date.now() });
        default: return;
      }
    }
    return { handle, disconnect() { clearInterval(rl); removeMember(client); clients.delete(id); } };
  }
  function start() { if (!timer) { last = Date.now(); timer = setInterval(tick, 1000 * TICK); } }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { connect, start, stop, tick, rooms, clients, listRooms };
}
module.exports = { createHub, MAPS, MODES, CLASSES };
