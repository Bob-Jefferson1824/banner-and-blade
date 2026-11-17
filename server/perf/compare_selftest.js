#!/usr/bin/env node
'use strict';
/* Self-test for compare.js using SYNTHETIC results files (no server, no network). It proves the judging logic, thresholds and the handling of
   missing, corrupt or incomplete files. It says nothing about real compression. */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { evaluate } = require('./compare.js');
let fails = 0, n = 0;
const check = (name, cond) => { n++; if (!cond) { fails++; console.log('FAILED: ' + name); } else console.log('ok: ' + name); };

const stage = (name, o) => ({ name, players: name.includes('8') ? 8 : 4, rooms: 1, n: 24,
  compression: { wireUncompressedRatio: o.ratio, cpuMsPerDeliveredSnapshot: 0.05, versions: { socketio: '4.8.4', engineio: '6.6.4', ws: '8.21.0' } },
  server: { wireKBpsOut: 100 * o.ratio, cpuCoresUsed: o.cpu, eventLoopDelayMs: { p99: 5 }, cgroupThrottledSeconds: null },
  rttP95Worst: o.rtt === undefined ? 40 : o.rtt, gapP95Worst: 60, rssMaxSampledMB: o.rss === undefined ? 120 : o.rss, simSpeed: 1 });
function run(dir, tag, cond, t, o = {}) {
  const on = cond === 'on', ratio = o.ratio !== undefined ? o.ratio : (on ? 0.3 : 1.003), cpu = o.cpu !== undefined ? o.cpu : (on ? 0.10 : 0.09);
  const stages = o.full ? [{ name: 'C4 full match', fullMatch: true, players: 4, rooms: 1, n: 10, matchSpeed: 1, matchesFinished: 1, compression: { versions: { socketio: '4.8.4', engineio: '6.6.4', ws: '8.21.0' } } }]
    : [stage('C1 4 players', { ratio, cpu, rtt: o.rtt, rss: o.rss }), stage('C2 8 players', { ratio, cpu, rtt: o.rtt, rss: o.rss }), stage('C3 two rooms', { ratio, cpu, rtt: o.rtt, rss: o.rss })];
  if (o.dropMetric) delete stages[1].server.cpuCoresUsed;
  if (o.mutate) o.mutate(stages);
  const j = { label: 'x', results: stages, extra: Object.assign({ flags: Object.assign({ fixedStep: false, broadcast: false, snapHz: 20, catchupCap: 0.1 }, { compress: on }), tag, startedAt: new Date(Date.UTC(2026, 10, 17, 1, t)).toISOString(),
    planFingerprint: o.fp || (o.full ? 'fullplan' : 'loadplan'), compressExpect: cond, complete: o.complete !== false, exitCode: o.complete === false ? 1 : 0, headlineStage: o.full ? null : 'C2 8 players', runnerNode: 'v20.1.0' }, o.extra || {}) };
  if (o.complete === false) j.results[0].stopReasons = ['a stop rule fired'];
  if (o.flagsOverride) j.extra.flags = Object.assign(j.extra.flags, o.flagsOverride);
  fs.writeFileSync(path.join(dir, `results-${tag}.json`), o.corrupt ? '{"results": [' : JSON.stringify(j));
}
const order = ['off', 'on', 'on', 'off', 'off', 'on'];
function set(mod) {   // a good experiment unless modified
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-')); const over = mod || (() => ({}));
  order.forEach((c, i) => run(d, `t${i}-${c}`, c, i, over(c, i) || {}));
  run(d, 'full-off', 'off', 10, { full: true }); run(d, 'full-on', 'on', 11, { full: true });
  return d;
}
/* every measurement the verdict depends on: removing it, in any run of either condition, must never leave a RECOMMENDED verdict */
const REQUIRED = { ratio: (st) => delete st.compression.wireUncompressedRatio, wire: (st) => delete st.server.wireKBpsOut, cpu: (st) => delete st.server.cpuCoresUsed, rtt: (st) => delete st.rttP95Worst, gap: (st) => delete st.gapP95Worst, rss: (st) => delete st.rssMaxSampledMB, loop: (st) => delete st.server.eventLoopDelayMs, speed: (st) => delete st.simSpeed };
const V = (d, opts) => evaluate([d], opts || {});

let r = V(set());                                   check('good data: RECOMMENDED', r.verdict === 'RECOMMENDED');
r = V(set((c, i) => (c === 'on' && i === 2 ? { ratio: 0.75 } : {})));    check('one trial with only 25% reduction: NOT RECOMMENDED', r.verdict === 'NOT RECOMMENDED' && r.failures.some((x) => /weakest single trial/.test(x)));
r = V(set((c) => (c === 'on' ? { ratio: 0.64 } : {})));                  check('median reduction 36%: NOT RECOMMENDED', r.verdict === 'NOT RECOMMENDED' && r.failures.some((x) => /median reduction/.test(x)));
r = V(set((c) => (c === 'on' ? { ratio: 0.6 } : {})));                   check('median reduction exactly about 40% passes bandwidth', !r.failures.some((x) => /bandwidth/.test(x)));
r = V(set((c) => ({ cpu: c === 'on' ? 0.117 : 0.09 })));                 check('CPU +30% relative, +0.027 cores: NOT RECOMMENDED (relative limit)', r.verdict === 'NOT RECOMMENDED' && r.failures.some((x) => /change versus off/.test(x)));
r = V(set((c) => ({ cpu: c === 'on' ? 0.60 : 0.50 })));                  check('CPU +20% relative but +0.10 cores: NOT RECOMMENDED (absolute limit)', r.verdict === 'NOT RECOMMENDED' && r.failures.some((x) => /extra cores/.test(x)));
r = V(set((c) => ({ cpu: c === 'on' ? 0.52 : 0.50 })));                  check('CPU +4% and +0.02 cores: passes both', !r.failures.some((x) => /CPU/.test(x)));
r = V(set((c) => ({ rtt: c === 'on' ? 70 : 40 })));                      check('latency +30 ms: NOT RECOMMENDED', r.verdict === 'NOT RECOMMENDED' && r.failures.some((x) => /latency/.test(x)));
r = V(set((c) => ({ rss: c === 'on' ? 200 : 120 })));                    check('memory +80 MB: NOT RECOMMENDED', r.verdict === 'NOT RECOMMENDED' && r.failures.some((x) => /memory/.test(x)));
r = V(set((c, i) => (c === 'on' && i === 1 ? { complete: false } : {}))); check('an incomplete compression-ON run: NOT RECOMMENDED (stability)', r.verdict === 'NOT RECOMMENDED' && r.failures.some((x) => /stability/.test(x)));
r = V(set((c, i) => (c === 'off' && i === 0 ? { complete: false } : {}))); check('an incomplete compression-OFF run: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE');
r = V(set((c, i) => (i === 5 ? { corrupt: true } : {})));                check('a corrupt results file is reported and not trusted (INCONCLUSIVE)', r.verdict === 'INCONCLUSIVE' && r.notes.some((x) => /not valid JSON/.test(x)));
r = V(set((c, i) => (i === 3 ? { dropMetric: true } : {})));             check('a missing measurement in a complete run: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE' && r.problems.some((x) => /missing measurements/.test(x)));
r = V(set((c, i) => (c === 'off' && i === 4 ? { fp: 'otherplan' } : {})));check('a run with a different plan fingerprint: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE');
r = V(set((c, i) => (c === 'on' && i === 5 ? { flagsOverride: { broadcast: true } } : {})));  check('a different switch besides compression: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE' && r.problems.some((x) => /identical settings/.test(x)));
r = V(set((c, i) => (c === 'on' && i === 5 ? { extra: { runnerNode: 'v22.0.0' } } : {})));    check('a different Node version: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE');
let d = set(); for (const f of fs.readdirSync(d)) if (/t5-on|t4-off/.test(f)) fs.unlinkSync(path.join(d, f));
r = V(d);                                                                check('only 2 runs per condition: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE' && r.problems.some((x) => /at least 3 runs/.test(x)));
d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-')); ['off', 'off', 'off', 'on', 'on', 'on'].forEach((c, i) => run(d, `b${i}-${c}`, c, i)); run(d, 'full-off', 'off', 10, { full: true }); run(d, 'full-on', 'on', 11, { full: true });
r = V(d);                                                                check('all-off-then-all-on (not interleaved): INCONCLUSIVE', r.verdict === 'INCONCLUSIVE' && r.problems.some((x) => /interleaved/.test(x)));
d = set(); for (const f of fs.readdirSync(d)) if (/^results-full/.test(f)) fs.unlinkSync(path.join(d, f));
r = V(d);                                                                check('no full-match results: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE' && r.problems.some((x) => /full-match/.test(x)));
r = V(d, { noFull: true });                                              check('--no-fullmatch skips that requirement', r.verdict === 'RECOMMENDED');
d = set(); for (const f of fs.readdirSync(d)) if (/^results-full-on/.test(f)) { const j = JSON.parse(fs.readFileSync(path.join(d, f))); j.extra.complete = false; j.results[0].fullReasons = ['x']; j.results[0].stopReasons = ['x']; fs.writeFileSync(path.join(d, f), JSON.stringify(j)); }
r = V(d);                                                                check('an unfinished full match with compression ON: NOT RECOMMENDED', r.verdict === 'NOT RECOMMENDED');
r = evaluate([path.join(os.tmpdir(), 'does-not-exist-xyz')], {});        check('a missing path is handled (INCONCLUSIVE, no crash)', r.verdict === 'INCONCLUSIVE' && r.notes.some((x) => /not found/.test(x)));
d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
r = evaluate([d], {});                                                   check('an empty folder is handled (INCONCLUSIVE, no crash)', r.verdict === 'INCONCLUSIVE');
fs.writeFileSync(path.join(d, 'results-plain.json'), JSON.stringify({ label: 'x', results: [{ name: 'a' }], extra: { flags: {}, complete: true } }));
r = evaluate([d], {});                                                   check('a results file from a non-compression run is ignored safely', r.verdict === 'INCONCLUSIVE' && r.notes.some((x) => /not a compression-test run/.test(x)));
const mut = (fn, stageIdx) => ({ mutate: (stages) => { for (let k = 0; k < stages.length; k++) if (stageIdx === undefined || stageIdx === k) fn(stages[k]); } });
r = V(set((c, i) => (c === 'on' && i === 1 ? mut(REQUIRED.speed, 1) : {})));  check('simSpeed missing from ONE stage of ONE ON run: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE' && r.problems.some((x) => /missing measurements \(speed\)/.test(x)));
r = V(set((c) => (c === 'on' ? mut(REQUIRED.speed) : {})));                 check('simSpeed missing from EVERY ON run: INCONCLUSIVE, never RECOMMENDED', r.verdict === 'INCONCLUSIVE');
r = V(set((c, i) => (c === 'off' && i === 0 ? mut(REQUIRED.speed, 0) : {}))); check('simSpeed missing from one OFF run: INCONCLUSIVE (the baseline needs it too)', r.verdict === 'INCONCLUSIVE');
r = V(set((c) => (c === 'off' ? mut(REQUIRED.speed) : {})));                check('simSpeed missing from every OFF run: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE');
for (const bad of [0, -1, 'fast', null, NaN, 99]) { r = V(set((c, i) => (c === 'on' && i === 2 ? mut((st) => { st.simSpeed = bad; }, 1) : {}))); check(`invalid simSpeed (${String(bad)}) counts as missing: INCONCLUSIVE`, r.verdict === 'INCONCLUSIVE'); }
r = V(set((c) => (c === 'on' ? mut((st) => { st.simSpeed = 0.90; }) : {}))); check('valid but slow simSpeed (0.90) with compression: NOT RECOMMENDED', r.verdict === 'NOT RECOMMENDED' && r.failures.some((x) => /game speed with compression/.test(x)));
r = V(set((c) => (c === 'off' ? mut((st) => { st.simSpeed = 0.90; }) : {}))); check('slow simSpeed in the OFF baseline: NOT RECOMMENDED (baseline unhealthy, flagged)', r.verdict !== 'RECOMMENDED');
for (const [name, fn] of Object.entries(REQUIRED)) {
  r = V(set((c, i) => (c === 'on' && i === 2 ? mut(fn, 1) : {})));            check(`${name} missing from one ON run: never RECOMMENDED`, r.verdict === 'INCONCLUSIVE');
  r = V(set((c, i) => (c === 'off' && i === 3 ? mut(fn, 1) : {})));           check(`${name} missing from one OFF run: never RECOMMENDED`, r.verdict === 'INCONCLUSIVE');
  r = V(set(() => mut(fn)));                                                  check(`${name} missing from every run: never RECOMMENDED`, r.verdict === 'INCONCLUSIVE');
}
d = set(); for (const f of fs.readdirSync(d)) if (/^results-full-on/.test(f)) { const j = JSON.parse(fs.readFileSync(path.join(d, f))); delete j.results[0].matchSpeed; fs.writeFileSync(path.join(d, f), JSON.stringify(j)); }
r = V(d);                                                                    check('full match without a valid whole-match speed: INCONCLUSIVE', r.verdict === 'INCONCLUSIVE');
d = set(); for (const f of fs.readdirSync(d)) if (/^results-full-off/.test(f)) { const j = JSON.parse(fs.readFileSync(path.join(d, f))); j.results[0].matchSpeed = 0.5; fs.writeFileSync(path.join(d, f), JSON.stringify(j)); }
r = V(d);                                                                    check('full match with slow whole-match speed: not RECOMMENDED', r.verdict !== 'RECOMMENDED');
/* exit codes of the command line tool */
const good = set(), bad = set((c) => (c === 'on' ? { ratio: 0.9 } : {})), out = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-out-'));
const exit = (args) => cp.spawnSync(process.execPath, [path.join(__dirname, 'compare.js'), ...args], { encoding: 'utf8' }).status;
check('CLI exit 0 for RECOMMENDED', exit([good, '--out', out]) === 0 && fs.existsSync(path.join(out, 'compare-verdict.json')));
check('CLI exit 0 for NOT RECOMMENDED (a valid verdict)', exit([bad, '--out', out]) === 0);
check('CLI exit 1 for INCONCLUSIVE', exit([fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-')), '--out', out]) === 1);
check('CLI exit 2 without arguments', exit([]) === 2);
console.log(fails ? `FAILED ${fails} of ${n}` : `ALL PASSED (${n})`); process.exit(fails ? 1 : 0);
