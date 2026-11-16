#!/usr/bin/env node
'use strict';
/* STAGING-ONLY progressive load test for the Banner & Blade server. Runs on GitHub's servers (see the workflow).
   SAFETY: refuses to run unless (1) the address is https and its host name is exactly banner-and-blade-staging[-suffix].onrender.com
   (or localhost for the local self-test only), AND (2) the server itself answers /stats with role "staging" using the staging secret.
   The production server has no /stats page, so it can never pass check (2).
   Environment: STAGING_URL, STAGING_STATS_SECRET. Settings: perf/plan.json. Output: perf/results.json and a Markdown table. */
const fs = require('fs'), path = require('path');
let io; // socket.io-client is loaded only after the safety checks pass
const plan = JSON.parse(fs.readFileSync(process.env.BB_PLAN || path.join(__dirname, 'plan.json'), 'utf8'));
const URLSTR = process.env.STAGING_URL || '', SECRET = process.env.STAGING_STATS_SECRET || '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const f2 = (v) => (typeof v === 'number' && isFinite(v) ? (Math.round(v * 100) / 100).toString() : 'n/a');
const f1 = (v) => (typeof v === 'number' && isFinite(v) ? (Math.round(v * 10) / 10).toString() : 'n/a');
const { monitorEventLoopDelay } = require('perf_hooks');
const runnerLoop = monitorEventLoopDelay({ resolution: 10 }); runnerLoop.enable();   // how busy the TEST RUNNER itself is (a busy runner distorts snapshot gaps)
const runnerLagMs = () => Math.max(0, runnerLoop.percentile(99) / 1e6 - 10);
const out = []; const say = (m) => { console.log(m); out.push(m); };
const refuse = (m) => { console.log('REFUSED: ' + m); process.exit(2); };

/* ---------- safety checks ---------- */
function verifyHost() {
  let u; try { u = new URL(URLSTR); } catch (e) { refuse('STAGING_URL is not a valid address'); }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) refuse('STAGING_URL must be just the address (https://name.onrender.com) with no path, query or login');
  const host = u.hostname.toLowerCase(), local = host === 'localhost' || host === '127.0.0.1';
  if (local) { if (process.env.BB_RUNNER_ALLOW_LOCALHOST !== '1') refuse('localhost is only allowed for the local self-test'); return u; }
  if (u.protocol !== 'https:') refuse('address must be https');
  if (u.port) refuse('address must not specify a port');
  if (host === 'banner-and-blade.onrender.com') refuse('that is the production host');
  if (!/^banner-and-blade-staging(-[a-z0-9]+)?\.onrender\.com$/.test(host)) refuse('host name is not a banner-and-blade-staging service');
  return u;
}
async function getJson(p, headers) {
  const r = await fetch(new URL(p, URLSTR), { headers: headers || {}, signal: AbortSignal.timeout(15000), redirect: 'error' });
  return { status: r.status, body: r.status === 200 && (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
}
const stats = async (reset) => { const r = await getJson('/stats' + (reset ? '?reset=1' : ''), { 'x-staging-secret': SECRET }); if (r.status !== 200 || !r.body) throw new Error('stats status ' + r.status); return r.body; };

/* ---------- bots ---------- */
class Bot {
  constructor(i) { this.i = i; this.dead = false; this.snaps = []; this.rtt = []; this.bytes = 0; this.disc = 0; this.started = false; this.errs = 0; }
  connect() {
    return new Promise((res, rej) => {
      if (!io) io = require('socket.io-client').io;
      this.s = io(URLSTR, { transports: ['websocket'], reconnection: false, timeout: 20000 });
      const t = setTimeout(() => rej(new Error('connect timeout')), 25000);
      this.s.on('connect', () => { clearTimeout(t); res(); });
      this.s.on('connect_error', (e) => { clearTimeout(t); rej(e); });
      this.s.on('disconnect', () => { this.disc++; });
      this.s.on('snap', () => { this.snaps.push(now()); });
      this.s.on('start', () => { this.started = true; this.startT = now(); });
      this.s.on('error', () => { this.errs++; });
      this.s.on('closed', (m) => { this.closed = (m && m.msg) || 'closed'; this.errs++; });
      this.s.on('end', (p) => { if (this.ended) { this.dupEnd = (this.dupEnd || 0) + 1; return; } this.ended = true; this.endT = now(); this.endInfo = p && typeof p === 'object' ? { winner: p.winner, elapsed: p.elapsed, scores: p.scores } : null; });   // the server sends 'end' exactly once per player; a second one is itself a fault
      try { this.s.io.engine.on('data', (d) => { this.bytes += typeof d === 'string' ? d.length : (d.byteLength || 0); }); } catch (e) {}
    });
  }
  call(ev, d) { return new Promise((r) => { const t = setTimeout(() => r(null), 5000); this.s.emit(ev, d, (a) => { clearTimeout(t); r(a); }); }); }
  play() {
    let k = Math.random() * 6, n = 0;
    this.tm = setInterval(() => { if (!this.s.connected) return; k += 0.033; n++; const mx = Math.cos(k), mz = Math.sin(k); this.s.emit('input', { mx, mz, yaw: k, attack: (n % 40) < 12, block: false, sprint: (n % 90) < 45, jump: false, aim: null }); }, 33);
    this.om = setInterval(() => { if (!this.s.connected) return; this.s.emit('order', Math.random() < 0.5 ? { type: 'call' } : { type: 'send', x: Math.cos(k) * 30, z: Math.sin(k) * 30 }); }, 4000);
    this.pm = setInterval(async () => { if (!this.s.connected) return; const t0 = now(); const a = await this.call('ping'); if (a) this.rtt.push(now() - t0); }, 1000);
  }
  stop() { if (this.dead) return; this.dead = true; clearInterval(this.tm); clearInterval(this.om); clearInterval(this.pm); try { this.s.emit('leave'); this.s.close(); } catch (e) {} }
}
async function startRoom(roomIdx, players, n, duration) {
  const bots = [];
  try { return await startRoomInner(bots, roomIdx, players, n, duration || 360); } catch (e) { for (const b of bots) b.stop(); throw e; }   // never leave connected bots behind when a room fails to start
}
async function startRoomInner(bots, roomIdx, players, n, duration) {
  for (let i = 0; i < players; i++) { const b = new Bot(roomIdx * 10 + i); bots.push(b); await b.connect(); }
  const classes = ['knight', 'archer', 'crossbowman', 'scout', 'spearman'];
  const r = await bots[0].call('create', { name: 'bot' + roomIdx + 'a', isPrivate: true, cfg: { map: 'castle', mode: 'tdm', n, duration, difficulty: 'normal' } });
  if (!r || !r.ok) throw new Error('create failed');
  for (let i = 1; i < players; i++) { const j = await bots[i].call('join', { code: r.code, name: 'bot' + roomIdx + String.fromCharCode(97 + i) }); if (!j || !j.ok) throw new Error('join failed'); }
  for (const b of bots) await b.call('setClass', { cls: classes[Math.floor(Math.random() * 5)] });
  const st = await bots[0].call('start'); if (!st || !st.ok) throw new Error('start failed');
  for (let t = 0; t < 100 && !bots.every(b => b.started); t++) await sleep(100);
  if (!bots.every(b => b.started)) throw new Error('match did not start');
  for (const b of bots) b.play();
  return bots;
}

/* ---------- stages ---------- */
async function runStage(st, flags, label) {
  const expectHz = flags.fixedStep ? flags.snapHz : 15;   // the current server really sends about 15 a second
  const rooms = []; let bots = [];
  try {
    for (let r = 0; r < st.rooms; r++) { const b = await startRoom(r, st.players, st.n); rooms.push(b); bots = bots.concat(b); }
    await sleep(plan.startupSeconds * 1000);
    runnerLoop.reset(); await stats(true);               // start of the measured window
    const marks = bots.map(b => ({ s: b.snaps.length, bytes: b.bytes, rtt: b.rtt.length, t: now() }));
    const samples = []; const W = (st.seconds || plan.windowSeconds) * 1000, t0 = Date.now();
    let earlyStop = null;
    while (Date.now() - t0 < W) { await sleep(Math.min(5000, W)); if (bots.some(b => b.errs > 0 || b.closed)) { earlyStop = 'server error event received'; break; } if (bots.some(b => !b.s.connected)) { earlyStop = 'a player was disconnected'; break; } try { samples.push(await stats(false)); } catch (e) { samples.push(null); } }
    const server = await stats(false);
    const per = bots.map((b, i) => {
      const m = marks[i], secs = (now() - m.t) / 1000, sn = b.snaps.slice(m.s), gaps = []; for (let k = 1; k < sn.length; k++) gaps.push(sn[k] - sn[k - 1]);
      const rtt = b.rtt.slice(m.rtt);
      return { rate: sn.length / secs, gapMean: gaps.length ? gaps.reduce((a, c) => a + c, 0) / gaps.length : null, gapP95: pct(gaps, 0.95), gapMax: gaps.length ? Math.max(...gaps) : null, kbps: (b.bytes - m.bytes) / 1024 / secs, rttP50: pct(rtt, 0.5), rttP95: pct(rtt, 0.95), rttMax: rtt.length ? Math.max(...rtt) : null, disc: b.disc, errs: b.errs, ended: !!b.ended, closed: b.closed || null };
    });
    const min = (k) => Math.min(...per.map(p => p[k] == null ? Infinity : p[k])), max = (k) => Math.max(...per.map(p => p[k] == null ? -Infinity : p[k]));
    const res = { name: st.name, rooms: st.rooms, players: st.players, n: st.n, soldiersPerRoom: st.n * 2, expectHz,
      clientRateMin: min('rate'), clientRateMean: per.reduce((a, p) => a + p.rate, 0) / per.length, gapP95Worst: max('gapP95'), gapMaxWorst: max('gapMax'), kbpsUncompressedPerPlayer: per.reduce((a, p) => a + p.kbps, 0) / per.length,
      rttP50Worst: max('rttP50'), rttP95Worst: max('rttP95'), rttMaxWorst: max('rttMax'), disconnects: per.reduce((a, p) => a + p.disc, 0), errors: per.reduce((a, p) => a + p.errs, 0), matchEndedEarly: per.some(p => p.ended), serverClosed: per.some(p => p.closed),
      server: server.window, serverMemory: server.memory, serverLoad: server.load, rssMaxSampledMB: server.memory.rssMaxSampledMB, simSpeed: server.window.gameSpeedSlowestRoom, roomsMeasured: server.window.roomsMeasured, runnerLagP99Ms: runnerLagMs(), earlyStop };
    return res;
  } finally { for (const b of bots) b.stop(); await sleep(plan.pauseBetweenStagesSeconds * 1000); }
}

/* ---------- full-match stage ---------- */
/* Plays ONE complete match per room, from the start message to the server's own 'end' message. The match length is the game's real rule:
   the game ends a match when the time limit runs out (the game's own options are 180, 360 or 600 s) or when a score target is reached,
   so the runner invents no duration of its own. A match only counts as finished if EVERY player received the server's 'end' message. */
async function runFullMatchStage(st, flags) {
  const expectHz = flags.fixedStep ? flags.snapHz : 15;
  const duration = st.matchDuration || 180;
  if (![180, 360, 600].includes(duration)) throw new Error('matchDuration must be 180, 360 or 600 (the game\'s own match lengths)');
  const minSpd = plan.abort.minSimSpeed == null ? 0.95 : plan.abort.minSimSpeed;
  const grace = st.graceSeconds == null ? 30 : st.graceSeconds;
  const maxWait = st.maxWaitSeconds || Math.ceil(duration / minSpd + grace);   // the slowest acceptable match, plus a grace period
  const rooms = []; let bots = [];
  try {
    runnerLoop.reset(); await stats(true);
    const tStart = Date.now();   // the deadline counts from before the first room is created, so slow room set-up cannot hide a match that never ends
    for (let r = 0; r < st.rooms; r++) { const b = await startRoom(r, st.players, st.n, duration); rooms.push(b); bots = bots.concat(b); }
    const marks = bots.map(b => ({ s: b.snaps.length, bytes: b.bytes, rtt: b.rtt.length, t: now() }));
    let earlyStop = null, timedOut = false, lastSpeed = null, lastRooms = 0;
    while (!bots.every(b => b.ended)) {
      if (Date.now() - tStart > maxWait * 1000) { timedOut = true; break; }
      await sleep(2000);
      if (bots.some(b => b.errs > 0 || b.closed)) { earlyStop = 'server error event received'; break; }
      if (bots.some(b => !b.s.connected && !b.ended)) { earlyStop = 'a player was disconnected'; break; }
      try { const s = await stats(false); if (s.window.gameSpeedSlowestRoom != null) { lastSpeed = s.window.gameSpeedSlowestRoom; lastRooms = s.window.roomsMeasured; } } catch (e) {}   // last reading taken while matches were still running
    }
    const server = await stats(false);
    const reasons = [];
    const per = bots.map((b, i) => {
      const m = marks[i], secs = ((b.endT || now()) - m.t) / 1000, sn = b.snaps.slice(m.s).filter(t => !b.endT || t <= b.endT), gaps = []; for (let k = 1; k < sn.length; k++) gaps.push(sn[k] - sn[k - 1]);
      const rtt = b.rtt.slice(m.rtt);
      return { rate: sn.length / secs, gapP95: pct(gaps, 0.95), gapMax: gaps.length ? Math.max(...gaps) : null, kbps: (b.bytes - m.bytes) / 1024 / secs, rttP50: pct(rtt, 0.5), rttP95: pct(rtt, 0.95), rttMax: rtt.length ? Math.max(...rtt) : null, disc: b.disc, errs: b.errs, ended: !!b.ended, closed: b.closed || null };
    });
    const min = (k) => Math.min(...per.map(p => p[k] == null ? Infinity : p[k])), max = (k) => Math.max(...per.map(p => p[k] == null ? -Infinity : p[k]));
    /* match facts, per room, from the server's own 'end' message */
    let matchSpeed = null, wallS = null, gameS = null, endedBy = null, winners = null;
    const neverEnded = bots.filter(b => !b.ended).length;
    if (timedOut) reasons.push(`the match did not finish within ${maxWait} s (game length ${duration} s, minimum speed ${minSpd}, grace ${grace} s)`);
    else if (neverEnded) reasons.push(`${neverEnded} of ${bots.length} players never received the end-of-match message`);
    const speeds = [], walls = [], games = [], endings = [];
    for (let r = 0; r < rooms.length; r++) {
      const rb = rooms[r]; if (!rb.every(b => b.ended)) continue;
      const infos = rb.map(b => b.endInfo);
      const sc = (i, t) => (i && i.scores && typeof i.scores === 'object') ? i.scores[t] : undefined;
      const bad = infos.map(i => !i || typeof i.elapsed !== 'number' || !isFinite(i.elapsed) || i.elapsed <= 0 || i.elapsed > duration + 1 || ![0, 1, 2].includes(i.winner) || typeof sc(i, 1) !== 'number' || typeof sc(i, 2) !== 'number' || !isFinite(sc(i, 1)) || !isFinite(sc(i, 2))).some(Boolean);
      if (bad) { reasons.push(`room ${r + 1}: the end-of-match message was missing or invalid (needs winner 0/1/2, scores, and elapsed time between 0 and ${duration + 1} s)`); continue; }
      if (infos.some(i => i.winner !== infos[0].winner || i.elapsed !== infos[0].elapsed || sc(i, 1) !== sc(infos[0], 1) || sc(i, 2) !== sc(infos[0], 2))) { reasons.push(`room ${r + 1}: players received conflicting end-of-match results`); continue; }
      const b1 = sc(infos[0], 1), r2s = sc(infos[0], 2), expect = b1 > r2s ? 1 : r2s > b1 ? 2 : 0;   // team deathmatch: the higher score wins, level is a draw
      if (infos[0].winner !== expect) { reasons.push(`room ${r + 1}: the announced winner (${infos[0].winner}) does not match the final scores (${b1} v ${r2s})`); continue; }
      if (rb.some(b => b.dupEnd)) { reasons.push(`room ${r + 1}: a player received the end-of-match message more than once`); continue; }
      const wall = (rb[0].endT - rb[0].startT) / 1000, game = infos[0].elapsed;
      walls.push(wall); games.push(game); speeds.push(game / wall);
      endings.push(game >= duration - 0.6 ? 'time limit' : 'score or objective reached');
    }
    if (!timedOut && !neverEnded && speeds.length !== rooms.length && !reasons.length) reasons.push(`only ${speeds.length} of ${rooms.length} matches could be validated`);
    if (speeds.length) { winners = rooms.filter(rb => rb.every(b => b.ended) && rb[0].endInfo).map(rb => `winner ${rb[0].endInfo.winner} (${rb[0].endInfo.winner === 0 ? 'draw' : rb[0].endInfo.winner === 1 ? 'blue' : 'red'}), score ${rb[0].endInfo.scores && rb[0].endInfo.scores[1]} v ${rb[0].endInfo.scores && rb[0].endInfo.scores[2]}`).join('; '); matchSpeed = Math.min(...speeds); wallS = Math.max(...walls); gameS = Math.max(...games); endedBy = [...new Set(endings)].join(' / '); }
    if (matchSpeed != null && matchSpeed < minSpd) reasons.push(`whole-match game speed ${f2(matchSpeed)} is below the minimum ${minSpd} (${f2(gameS)} game seconds took ${f2(wallS)} real seconds)`);
    if (earlyStop) reasons.push(earlyStop + ' (match cut short)');
    return { name: st.name, fullMatch: true, rooms: st.rooms, players: st.players, n: st.n, soldiersPerRoom: st.n * 2, expectHz,
      matchLengthSetting: duration, matchWallSeconds: wallS, matchGameSeconds: gameS, matchSpeed, endedBy, winners, maxWaitSeconds: maxWait, matchesFinished: speeds.length, matchesStarted: rooms.length,
      clientRateMin: min('rate'), clientRateMean: per.reduce((a, p) => a + p.rate, 0) / per.length, gapP95Worst: max('gapP95'), gapMaxWorst: max('gapMax'), kbpsUncompressedPerPlayer: per.reduce((a, p) => a + p.kbps, 0) / per.length,
      rttP50Worst: max('rttP50'), rttP95Worst: max('rttP95'), rttMaxWorst: max('rttMax'), disconnects: per.reduce((a, p) => a + p.disc, 0), errors: per.reduce((a, p) => a + p.errs, 0), matchEndedEarly: false, serverClosed: per.some(p => p.closed),
      server: server.window, serverMemory: server.memory, serverLoad: server.load, rssMaxSampledMB: server.memory.rssMaxSampledMB, simSpeed: lastSpeed, roomsMeasured: lastRooms, runnerLagP99Ms: runnerLagMs(), earlyStop, fullReasons: reasons };
  } finally { for (const b of bots) b.stop(); await sleep(plan.pauseBetweenStagesSeconds * 1000); }   // every bot is closed, whatever happened
}

const results = [];
const watchdog = setTimeout(() => { say('FAILED: overall time limit reached; stopping.'); finish(4, results, {}); }, (plan.maxTotalMinutes || 25) * 60000); watchdog.unref();
process.on('uncaughtException', (e) => { say('FAILED: unexpected error: ' + (e && e.message)); finish(1, results, {}); });
process.on('unhandledRejection', (e) => { say('FAILED: unexpected error: ' + (e && e.message)); finish(1, results, {}); });
process.on('SIGTERM', () => { say('Cancelled.'); finish(1, results, {}); });
(async () => {
  verifyHost();
  if (!SECRET || SECRET.length < 24) refuse('STAGING_STATS_SECRET missing or too short');
  say(`# Staging performance test: ${plan.label}`);
  say(`Started ${new Date().toISOString()} (UTC). Staging host verified by name; production is refused.`);
  /* the server must identify itself as staging */
  let id; try { id = await getJson('/stats', { 'x-staging-secret': SECRET }); } catch (e) { id = { status: 0 }; }
  if (id.status === 0) { say('Server not answering yet (probably asleep); waking it up first.'); }
  /* warm-up: cold start of a sleeping Render Free service */
  const tCold = Date.now(); let up = false;
  while (Date.now() - tCold < plan.warmup.maxColdStartSeconds * 1000) { try { const h = await getJson('/health'); if (h.status === 200) { up = true; break; } } catch (e) {} await sleep(3000); }
  if (!up) { say('FAILED: the staging service did not wake within the allowed time.'); finish(1); return; }
  const coldS = (Date.now() - tCold) / 1000; say(`Cold start: ${f1(coldS)} s until /health answered${coldS < 5 ? ' (already awake)' : ''}.`);
  let idr; try { idr = await getJson('/stats', { 'x-staging-secret': SECRET }); } catch (e) { idr = { status: 0 }; }
  if (idr.status !== 200 || !idr.body || idr.body.role !== 'staging') refuse('the server did not identify itself as a staging server (production has no /stats page)');
  const flags = idr.body.flags, inst = idr.body.instance;
  for (const [k, v] of Object.entries(plan.expectFlags || {})) if (flags[k] !== v) { say(`STOPPED: server switch ${k} is ${flags[k]} but the plan expects ${v}. Change the staging environment variable or the plan, then re-run.`); finish(3); return; }
  say(`Server switches: ${JSON.stringify(flags)}`);
  say(`Instance as reported by the server: Node ${inst.node}, ${inst.cpusVisible} CPU(s) visible, cgroup CPU limit ${inst.cgroupCpuMax}, memory ${inst.totalMemMB} MB (cgroup limit ${inst.cgroupMemMaxMB} MB).`);
  say(`Warm-up: ${plan.warmup.idleSeconds} s idle, then a ${plan.warmup.warmupMatchSeconds} s practice match. NOT counted in the results.`);
  await sleep(plan.warmup.idleSeconds * 1000);
  try { const wr = await runStage({ name: 'warm-up', rooms: 1, players: 2, n: 8, seconds: plan.warmup.warmupMatchSeconds }, flags, 'warm'); if (wr.errors || wr.disconnects) say(`Warm-up note (not counted): ${wr.errors} error event(s), ${wr.disconnects} disconnect(s) during the practice match.`); } catch (e) { say('Warm-up match problem (continuing): ' + e.message); }
  let stopped = null, incomplete = false;
  for (const st of plan.stages) {
    if (stopped) { results.push({ name: st.name, skipped: stopped }); continue; }
    say(`Running ${st.name}: ${st.rooms} room(s) x ${st.players} human(s), ${st.n} per side...`);
    try {
      const r = st.fullMatch ? await runFullMatchStage(st, flags) : await runStage(st, flags); results.push(r);
      const reasons = [];
      if (r.server.eventLoopDelayMs.p99 > plan.abort.eventLoopP99Ms) reasons.push(`event-loop delay p99 ${f1(r.server.eventLoopDelayMs.p99)} ms`);
      if (r.clientRateMin < plan.abort.minSnapshotRatio * r.expectHz) reasons.push(`slowest player got ${f1(r.clientRateMin)} snapshots/s`);
      if (r.disconnects > plan.abort.maxDisconnects) reasons.push(`${r.disconnects} disconnects`);
      const maxErr = plan.abort.maxErrors == null ? 0 : plan.abort.maxErrors; if (r.errors > maxErr) reasons.push(`${r.errors} server error event(s) received (allowed ${maxErr})`);
      const minSpd = plan.abort.minSimSpeed == null ? 0.95 : plan.abort.minSimSpeed;
      if (r.simSpeed == null) reasons.push('game speed could not be measured (no match was running long enough in the window)'); else if (r.simSpeed < minSpd) reasons.push(`game speed ${f2(r.simSpeed)} (slowest room) is below the minimum ${minSpd}; ${f2(r.server.discardedByCatchupCapS)} s of game time in total (${f2(r.server.discardedByCatchupCapWorstRoomS)} s in the worst room) was discarded by the catch-up cap and ${f2(r.server.discardedByStallLimitS)} s by the 0.25 s stall limit`);
      const maxLag = plan.abort.runnerLoopP99Ms == null ? 100 : plan.abort.runnerLoopP99Ms; if (r.runnerLagP99Ms > maxLag) reasons.push(`the test runner itself was overloaded (event-loop delay p99 ${f1(r.runnerLagP99Ms)} ms), so client-side numbers are unreliable`);
      if (r.roomsMeasured !== undefined && r.roomsMeasured < r.rooms && r.simSpeed != null) reasons.push(`game speed was measured for only ${r.roomsMeasured} of ${r.rooms} rooms`);
      if (r.fullReasons) for (const x of r.fullReasons) reasons.push(x);
      else if (r.earlyStop) reasons.push(r.earlyStop + ' (stage cut short)');
      if (r.serverClosed) reasons.push('server closed a player');
      if (r.matchEndedEarly) reasons.push('match ended before the window finished');
      if (r.server.cgroupThrottledSeconds != null && r.server.cgroupThrottledSeconds > plan.abort.maxThrottledSeconds) reasons.push(`CPU throttled ${f1(r.server.cgroupThrottledSeconds)} s`);
      if (reasons.length) { r.stopReasons = reasons; incomplete = true; stopped = 'not run: stopped after ' + st.name + ' (' + reasons.join('; ') + ')'; say('STOP RULE TRIGGERED after ' + st.name + ': ' + reasons.join('; ')); }
    } catch (e) { results.push({ name: st.name, error: e.message }); incomplete = true; stopped = 'not run: ' + st.name + ' failed (' + e.message + ')'; say('STAGE FAILED: ' + e.message); }
  }
  say('');
  say(`| Stage | Players x rooms | Soldiers/room | Snapshots/s (slowest player, expected) | Gap p95 / max ms | Message KB/s per player (uncompressed) | Wire KB/s out (server total) | RTT p50 / p95 ms | Server CPU cores used | Throttled s | Server loop delay p99 beyond 10 ms timer (ms) | Step mean / p95 / max ms | Sim steps/s per room (30 = normal) | Game speed, slowest room (min allowed ${plan.abort.minSimSpeed == null ? 0.95 : plan.abort.minSimSpeed}; 1.00 = normal) | Game time discarded: catch-up cap total / worst room / stall limit per match (s) | Errors | Runner lag p99 ms | RSS max, sampled 1/s (MB) | Disconnects |`);
  say('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.skipped || r.error) { say(`| ${r.name} | ${r.skipped || 'FAILED: ' + r.error} |||||||||||||||||||`); continue; }
    const s = r.server;
    say(`| ${r.name} | ${r.players} x ${r.rooms} | ${r.soldiersPerRoom} | ${f1(r.clientRateMin)} (${r.expectHz}) | ${f1(r.gapP95Worst)} / ${f1(r.gapMaxWorst)} | ${f1(r.kbpsUncompressedPerPlayer)} | ${f1(s.wireKBpsOut)} | ${f1(r.rttP50Worst)} / ${f1(r.rttP95Worst)} | ${f2(s.cpuCoresUsed)} | ${s.cgroupThrottledSeconds == null ? 'n/a' : f1(s.cgroupThrottledSeconds)} | ${f1(s.eventLoopDelayMs.p99)} | ${f1(s.stepMsMean)} / ${f1(s.stepMsP95)} / ${f1(s.stepMsMax)} | ${f1(s.stepsPerSec / r.rooms)} | ${f2(r.simSpeed)} | ${f2(s.discardedByCatchupCapS)} / ${f2(s.discardedByCatchupCapWorstRoomS)} / ${f2(s.discardedByStallLimitS)} | ${r.errors} | ${f1(r.runnerLagP99Ms)} | ${f1(r.rssMaxSampledMB)} | ${r.disconnects} |`);
  }
  for (const r of results) if (r.fullMatch) say(`Full match ${r.name}: ${r.matchesFinished} of ${r.matchesStarted} match(es) finished normally (setting ${r.matchLengthSetting} s; ended by ${r.endedBy || 'n/a'}; ${r.winners || 'no valid result'}); game time ${f1(r.matchGameSeconds)} s in ${f1(r.matchWallSeconds)} real s = speed ${f2(r.matchSpeed)}; server-measured speed before the end ${f2(r.simSpeed)}; longest wait allowed ${r.maxWaitSeconds} s.`);
  say('');
  say('Notes: results describe this staging instance at this moment only. They do not guarantee identical production performance. Step times and CPU come from the server itself; snapshot rates, gaps and RTT come from the test players, whose own network (GitHub to Render) adds latency.');
  const bad = incomplete || results.some(r => r.error || r.skipped || r.stopReasons);
  say(bad ? 'RESULT: INCOMPLETE — a stage failed or a stop rule fired (see above). Exit code 1.' : 'RESULT: all stages completed.');
  finish(bad ? 1 : 0, results, { flags, inst, coldS });
})().catch((e) => { console.log('ERROR: ' + (e && e.message)); process.exit(1); });

function finish(code, results, extra) {
  try { fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ label: plan.label, results, extra }, null, 1)); } catch (e) {}
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n'); } catch (e) {}
  process.exit(code);
}
