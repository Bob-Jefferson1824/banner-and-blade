'use strict';
/* Local, no-network, no-secret check of the staging switches. Runs the real hub in-process with fake clients.
   Confirms: baseline behaves as before; each switch keeps the simulation at real time, sends the expected snapshot rate, and never crashes.
   Usage: node perf/regression_local.js [secondsPerVariant]   (default 10) */
const path = require('path');
const Sim = require(path.join(__dirname, '..', 'sim.js')); const { createHub } = require(path.join(__dirname, '..', 'hub.js'));
const SECS = +process.argv[2] || 10, sleep = (ms) => new Promise(r => setTimeout(r, ms));
let simTime = 0, steps = 0; const origStep = Sim.Match.prototype.step;
Sim.Match.prototype.step = function (dt) { simTime += dt; steps++; return origStep.call(this, dt); };
const variants = [
  { name: 'baseline (original timing)', perf: null, wantHz: 15, ratio: [0.9, 1.1] },
  { name: 'fixed step, 20 snapshots/s', perf: { fixedStep: true, snapHz: 20 }, wantHz: 20, ratio: [0.97, 1.03] },
  { name: 'fixed step, 15 snapshots/s', perf: { fixedStep: true, snapHz: 15 }, wantHz: 15, ratio: [0.97, 1.03] },
  { name: 'fixed step 20 + broadcast-once', perf: { fixedStep: true, snapHz: 20, broadcast: true }, wantHz: 20, ratio: [0.97, 1.03], broadcast: true },
];
(async () => {
  let failed = 0; const rows = [];
  for (const v of variants) {
    const errs = []; const hubOpts = { log: (m) => { if (/fail|error/i.test(m)) errs.push(m); } };
    const clients = new Map();
    if (v.perf) { hubOpts.perf = Object.assign({ stats: { onStep() {}, onSnapshot() {} } }, v.perf); }
    if (v.broadcast) hubOpts.broadcast = (ids, ev, d) => { for (const id of ids) { const c = clients.get(id); if (c) c.got(ev, d); } };
    const hub = createHub(Sim, hubOpts); hub.start();
    let snaps = 0, bytes = 0, nonFinite = 0;
    const mk = (i) => { const c = { id: 'c' + i, got: (ev, d) => { if (i === 0 && ev === 'snap') { snaps++; const s = JSON.stringify(d); bytes += s.length; if (/NaN|Infinity/.test(s)) nonFinite++; } } };
      c.h = hub.connect(c.id, (ev, d) => c.got(ev, d)); c.call = (ev, d) => new Promise(r => { c.h.handle(ev, d, r); setTimeout(() => r(null), 50); }); clients.set(c.id, c); return c; };
    const cl = [0, 1, 2, 3].map(mk);
    const r = await cl[0].call('create', { name: 'A', cfg: { map: 'castle', mode: 'tdm', n: 10 } });
    for (let i = 1; i < 4; i++) await cl[i].call('join', { code: r.code, name: 'P' + i });
    await cl[0].call('start');
    await sleep(1000); simTime = 0; steps = 0; snaps = 0; bytes = 0;
    let k = 0; const inp = setInterval(() => { k += 0.03; for (const c of cl) c.h.handle('input', { mx: Math.cos(k), mz: Math.sin(k), yaw: k, attack: (Math.floor(k * 10) % 4) === 0, sprint: true }); }, 33);
    const t0 = Date.now(); await sleep(SECS * 1000); const wall = (Date.now() - t0) / 1000; clearInterval(inp);
    const ratio = simTime / wall, hz = snaps / wall, ok = ratio >= v.ratio[0] && ratio <= v.ratio[1] && Math.abs(hz - v.wantHz) <= v.wantHz * 0.15 && nonFinite === 0 && errs.length === 0 && snaps > 0;
    if (!ok) failed++;
    rows.push(`${ok ? 'PASSED' : 'FAILED'} | ${v.name} | sim-time/real-time ${ratio.toFixed(3)} (want ${v.ratio[0]}-${v.ratio[1]}) | snapshots/s ${hz.toFixed(1)} (want ~${v.wantHz}) | ${(bytes / snaps / 1024).toFixed(1)} KB/snapshot | bad numbers ${nonFinite} | errors ${errs.length}`);
    hub.stop();
  }
  console.log(rows.join('\n')); console.log(failed ? `\n${failed} variant(s) FAILED` : '\nAll variants PASSED');
  process.exit(failed ? 1 : 0);
})();
