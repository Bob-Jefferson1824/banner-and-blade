/* STAGING-ONLY statistics page. server.js loads this ONLY when the environment variable BB_STAGING_SECRET is set
   (24+ characters). Production never sets it, so there /stats does not exist (404) and none of this code runs.
   It reports aggregate numbers only: no player names, room codes, addresses, environment variables or secrets. */
'use strict';
const fs = require('fs'), os = require('os'), crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');

const readNum = (p) => { try { const v = fs.readFileSync(p, 'utf8').trim(); return v === 'max' ? null : +v; } catch (e) { return undefined; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return undefined; } };
const cgStat = () => { const o = {}; const t = readText('/sys/fs/cgroup/cpu.stat'); if (t) for (const l of t.split('\n')) { const [k, v] = l.split(' '); o[k] = +v; } return o; };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r3 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1000) / 1000 : v);

function createStats({ hub, io, flags, secret }) {
  const LOOP_RES_MS = 10;   // monitorEventLoopDelay records the whole timer interval, so an idle process reads about 10 ms; we subtract it
  const loop = monitorEventLoopDelay({ resolution: LOOP_RES_MS }); loop.enable();
  const extraMs = (ns) => Math.max(0, ns / 1e6 - LOOP_RES_MS);
  let w;
  const bytesNow = () => { const m = new Map(); try { for (const [id, c] of Object.entries(io.engine.clients || {})) { const s = c.request && c.request.socket; if (s) m.set(id, s.bytesWritten || 0); } } catch (e) {} return m; };
  /* how many connected players actually negotiated permessage-deflate (read from the live websocket objects; null = could not be read) */
  const deflateNow = () => { let total = 0, known = 0, deflate = 0; try { for (const c of Object.values(io.engine.clients || {})) { total++; const ws = c.transport && c.transport.socket; const ex = ws && ws.extensions; if (ex === undefined || ex === null) continue; known++; const str = typeof ex === 'string' ? ex : Object.keys(ex).join(','); if (/permessage-deflate/.test(str)) deflate++; } } catch (e) {} return { total, known, deflate }; };
  const ver = (name) => { try { return require(name + '/package.json').version; } catch (e) { return null; } };
  function reset() {
    loop.reset();
    w = { t: Date.now(), cpu: process.cpuUsage(), cg: cgStat(), steps: [], stepN: 0, stepSum: 0, stepMax: 0, simSum: 0, discCap: 0, discStall: 0, rooms: new Map(), snaps: 0, bytes0: bytesNow(), rssMax: 0 };
  }
  reset();
  const rssTimer = setInterval(() => { try { const r = process.memoryUsage().rss; if (r > w.rssMax) w.rssMax = r; } catch (e) {} }, 1000); if (rssTimer.unref) rssTimer.unref();   // memory sampled once a second
  const collector = {
    onStep(ms, dt, code) { w.stepN++; w.stepSum += ms; w.simSum += dt || 0;
      if (code !== undefined) { let r = w.rooms.get(code); if (!r) { r = { sim: 0, since: Date.now(), cap: 0 }; w.rooms.set(code, r); } r.sim += dt || 0; } if (ms > w.stepMax) w.stepMax = ms; if (w.steps.length < 20000) w.steps.push(ms); else w.steps[w.stepN % 20000] = ms; },
    onDiscard(sec, kind, code) { if (kind === 'cap') { w.discCap += sec; if (code !== undefined) { let r = w.rooms.get(code); if (!r) { r = { sim: 0, since: Date.now(), cap: 0 }; w.rooms.set(code, r); } r.cap += sec; } } else w.discStall += sec; },
    onSnapshot() { w.snaps++; }
  };
  function report() {
    const secs = (Date.now() - w.t) / 1000, cpu = process.cpuUsage(w.cpu), cg = cgStat(), mem = process.memoryUsage();
    if (mem.rss > w.rssMax) w.rssMax = mem.rss;
    let wire = 0; const now = bytesNow(); for (const [id, b] of now) wire += b - (w.bytes0.get(id) || 0);
    let humans = 0, matches = 0; const speeds = []; let worstCap = 0, nowMs = Date.now();
    for (const r of hub.rooms.values()) { humans += r.members.size; if (r.match && !r.match.ended) { matches++; const rs = w.rooms.get(r.code); if (rs) { const sec = (nowMs - Math.max(w.t, rs.since)) / 1000; if (sec >= 3) speeds.push(rs.sim / sec); } } }
    for (const rs of w.rooms.values()) if (rs.cap > worstCap) worstCap = rs.cap;
    const cgMax = readNum('/sys/fs/cgroup/memory.max'), cgCur = readNum('/sys/fs/cgroup/memory.current');
    return {
      role: 'staging', flags,
      instance: { node: process.version, platform: process.platform, cpusVisible: os.cpus().length, totalMemMB: Math.round(os.totalmem() / 1048576), cgroupCpuMax: readText('/sys/fs/cgroup/cpu.max') || null, cgroupMemMaxMB: cgMax ? Math.round(cgMax / 1048576) : cgMax, uptimeS: Math.round(process.uptime()), versions: { socketio: ver('socket.io'), engineio: ver('engine.io'), ws: ver('ws') } },
      window: {
        seconds: r3(secs),
        cpuCoresUsed: r3((cpu.user + cpu.system) / 1e6 / secs), cpuUserS: r3(cpu.user / 1e6), cpuSystemS: r3(cpu.system / 1e6),
        cgroupThrottledPeriods: cg.nr_throttled !== undefined && w.cg.nr_throttled !== undefined ? cg.nr_throttled - w.cg.nr_throttled : null,
        cgroupThrottledSeconds: cg.throttled_usec !== undefined && w.cg.throttled_usec !== undefined ? r3((cg.throttled_usec - w.cg.throttled_usec) / 1e6) : null,
        steps: w.stepN, stepsPerSec: r3(w.stepN / secs), stepMsMean: r3(w.stepN ? w.stepSum / w.stepN : null), stepMsP95: r3(pct(w.steps, 0.95)), stepMsMax: r3(w.stepMax),
        discardedByCatchupCapS: r3(w.discCap), discardedByStallLimitS: r3(w.discStall), gameSpeedSlowestRoom: speeds.length ? r3(Math.min(...speeds)) : null, gameSpeedMeanRoom: speeds.length ? r3(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null, roomsMeasured: speeds.length, discardedByCatchupCapWorstRoomS: r3(worstCap), snapshots: w.snaps, snapshotsPerSec: r3(w.snaps / secs),
        eventLoopDelayMs: { p50: r3(extraMs(loop.percentile(50))), p99: r3(extraMs(loop.percentile(99))), max: r3(extraMs(loop.max)), note: 'delay beyond the 10 ms timer interval' },
        wireBytesOut: wire, wireKBpsOut: r3(wire / 1024 / secs)
      },
      memory: { rssMB: r3(mem.rss / 1048576), rssMaxSampledMB: r3(w.rssMax / 1048576), rssSampleIntervalS: 1, heapUsedMB: r3(mem.heapUsed / 1048576), cgroupCurrentMB: cgCur ? Math.round(cgCur / 1048576) : cgCur },
      load: { deflate: deflateNow(), connectedClients: Object.keys((io.engine && io.engine.clients) || {}).length, rooms: hub.rooms.size, humansInRooms: humans, matchesRunning: matches }
    };
  }
  function ok(req) {
    const h = String(req.headers['x-staging-secret'] || '');
    const a = crypto.createHash('sha256').update(h).digest(), b = crypto.createHash('sha256').update(secret).digest();
    return crypto.timingSafeEqual(a, b);
  }
  function handle(req, res) {
    if (!ok(req)) { res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('unauthorised'); }
    const out = report();
    if (/[?&]reset=1\b/.test(req.url)) reset();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
  }
  return { collector, handle };
}
module.exports = { createStats };
