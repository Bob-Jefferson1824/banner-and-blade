#!/usr/bin/env node
'use strict';
/* Compression comparison tool. Reads the results files written by staging_load_test.js (one file per run) and judges
   compression ON versus OFF against fixed thresholds. It never contacts any server. Usage:
     node perf/compare.js <results-file-or-folder> [more files or folders]   [--no-fullmatch] [--out <folder>]
   Exit codes: 0 = a verdict was reached (RECOMMENDED or NOT RECOMMENDED), 1 = INCONCLUSIVE (missing, incomplete or inconsistent data), 2 = bad usage.
   IMPORTANT: results from a local loopback test describe ratios and relative CPU only. They say nothing about Render or real browsers. */
const fs = require('fs'), path = require('path');

const T = { minTrials: 3, bwMedian: 0.40, bwEach: 0.30, cpuRel: 0.25, cpuAbs: 0.05, rttP95Add: 25, gapP95Add: 10, rssAdd: 60, loopMax: 120, loopAdd: 30, minSpeed: 0.95 };
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const median = (a) => { const s = a.filter((x) => num(x) !== null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const spd = (v) => (num(v) !== null && v > 0 && v <= 3 ? v : null);   // a plausible game-speed ratio; anything else counts as missing
const f = (v, d = 2) => (num(v) === null ? 'n/a' : (Math.round(v * 10 ** d) / 10 ** d).toString());
const pc = (v) => (num(v) === null ? 'n/a' : f(v * 100, 1) + '%');

function loadFiles(args) {
  const files = [], notes = [];
  for (const a of args) {
    let st; try { st = fs.statSync(a); } catch (e) { notes.push(`not found: ${a}`); continue; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(a).sort()) if (/^results-.*\.json$/.test(n)) files.push(path.join(a, n)); }
    else files.push(a);
  }
  const runs = [];
  for (const file of files) {
    let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { notes.push(`unreadable or not valid JSON: ${file}`); continue; }
    if (!j || typeof j !== 'object' || !Array.isArray(j.results) || !j.extra || typeof j.extra !== 'object') { notes.push(`not a results file: ${file}`); continue; }
    const x = j.extra, ex = x.compressExpect;
    if (ex !== 'on' && ex !== 'off') { notes.push(`not a compression-test run (no on/off marker): ${file}`); continue; }
    const stages = j.results.filter((r) => r && typeof r === 'object');
    const bad = j.results.length === 0 || stages.length !== j.results.length || stages.some((r) => r.error || r.skipped || (r.stopReasons && r.stopReasons.length));
    runs.push({ file: path.basename(file), cond: ex, tag: x.tag || '', startedAt: x.startedAt || '', fp: x.planFingerprint || null, flags: x.flags || null, headline: x.headlineStage || null,
      complete: x.complete === true && !bad, exitCode: x.exitCode, stages, versions: stages.map((r) => r.compression && r.compression.versions).find(Boolean) || null, node: x.runnerNode || null,
      isFull: stages.length > 0 && stages.every((r) => r.fullMatch) });
  }
  runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return { runs, notes };
}

function evaluate(args, opts) {
  const { runs, notes } = loadFiles(args);
  const out = { thresholds: T, notes: notes.slice(), problems: [], failures: [], checks: [], files: runs.map((r) => ({ file: r.file, condition: r.cond, complete: r.complete })), verdict: null };
  const inconclusive = (m) => out.problems.push(m), fail = (m) => out.failures.push(m);
  if (!runs.length) { inconclusive('no usable compression-test results were found'); return finish(out); }

  /* group by plan fingerprint: the load plan and the full-match plan are two experiments */
  const groups = new Map(); for (const r of runs) { const k = r.fp || 'unknown'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const load = [], full = []; for (const g of groups.values()) (g.every((r) => r.isFull) ? full : load).push(g);
  if (load.length !== 1) inconclusive(load.length ? 'results from more than one load plan were mixed' : 'no load-test results were found');
  if (!opts.noFull) { if (full.length > 1) inconclusive('results from more than one full-match plan were mixed'); if (!full.length) inconclusive('no full-match results were found'); }
  if ([...groups.keys()].includes('unknown')) inconclusive('some results have no plan fingerprint, so identical conditions cannot be confirmed');

  /* every run must be complete; an incomplete run is judged by its condition */
  for (const r of runs) if (!r.complete) { if (r.cond === 'on') fail(`stability: compression-ON run ${r.file} did not complete (a stop rule fired, or a stage, match or measurement check failed)`); else inconclusive(`the compression-OFF run ${r.file} did not complete, so the baseline is unreliable`); }

  const settings = (g) => { const keys = new Set(g.map((r) => JSON.stringify([r.fp, Object.assign({}, r.flags, { compress: undefined }), r.versions, r.node]))); return keys.size === 1; };
  const checkGroup = (g, name) => {
    const on = g.filter((r) => r.cond === 'on'), off = g.filter((r) => r.cond === 'off');
    if (!settings(g)) inconclusive(`${name}: on and off runs did not use identical settings (plan, other switches, library or Node versions)`);
    const names = (r) => JSON.stringify(r.stages.map((s) => [s.name, s.players, s.rooms, s.n]));
    if (new Set(g.map(names)).size > 1) inconclusive(`${name}: the on and off runs did not use identical stages, player counts, rooms or soldier counts`);
    return { on, off };
  };

  if (load.length === 1) {
    const g = load[0], { on, off } = checkGroup(g, 'load test');
    if (on.length < T.minTrials || off.length < T.minTrials) inconclusive(`load test: need at least ${T.minTrials} runs per condition, found ${on.length} on and ${off.length} off`);
    const seq = g.map((r) => r.cond), runsOfSame = seq.filter((c, i) => i === 0 || c !== seq[i - 1]).length;
    if (runsOfSame < 4) inconclusive(`load test: the on and off runs were not interleaved (order: ${seq.join(', ')})`);
    out.order = seq;
    const okOn = on.filter((r) => r.complete), okOff = off.filter((r) => r.complete);
    if (okOn.length && okOff.length) {
      const names = okOn[0].stages.map((s) => s.name);
      const headline = (okOn[0].headline && names.includes(okOn[0].headline)) ? okOn[0].headline : okOn[0].stages.slice().sort((a, b) => b.players * b.rooms * b.n - a.players * a.rooms * a.n)[0].name;
      out.headlineStage = headline; out.stageTable = [];
      const get = (runsArr, stage, fn) => runsArr.map((r) => { const s = r.stages.find((q) => q.name === stage); try { return num(fn(s)); } catch (e) { return null; } });
      const metrics = { ratio: (s) => s.compression.wireUncompressedRatio, wire: (s) => s.server.wireKBpsOut, cpu: (s) => s.server.cpuCoresUsed, cpuSnap: (s) => s.compression.cpuMsPerDeliveredSnapshot, rtt: (s) => s.rttP95Worst, gap: (s) => s.gapP95Worst, rss: (s) => s.rssMaxSampledMB, loop: (s) => s.server.eventLoopDelayMs.p99, speed: (s) => spd(s.simSpeed), thr: (s) => s.server.cgroupThrottledSeconds };
      for (const st of names) {
        const M = {}; for (const k of Object.keys(metrics)) M[k] = { on: get(okOn, st, metrics[k]), off: get(okOff, st, metrics[k]) };
        const med = (k, c) => median(M[k][c]);
        const missing = ['ratio', 'wire', 'cpu', 'rtt', 'gap', 'rss', 'loop', 'speed'].filter((k) => M[k].on.some((v) => v === null) || M[k].off.some((v) => v === null));
        if (missing.length) { inconclusive(`stage "${st}": missing measurements (${missing.join(', ')}) in a completed run`); continue; }
        const refOff = med('ratio', 'off');
        const reductions = M.ratio.on.map((q) => 1 - q / refOff);   // in-run measure: what share of the decoded bytes was NOT sent
        const row = { stage: st, ratioOff: refOff, ratioOnMedian: med('ratio', 'on'), reductionMedian: median(reductions), reductionMin: Math.min(...reductions), reductions,
          wireOff: med('wire', 'off'), wireOn: med('wire', 'on'), cpuOff: med('cpu', 'off'), cpuOn: med('cpu', 'on'), cpuSnapOff: med('cpuSnap', 'off'), cpuSnapOn: med('cpuSnap', 'on'),
          rttOff: med('rtt', 'off'), rttOn: med('rtt', 'on'), gapOff: med('gap', 'off'), gapOn: med('gap', 'on'), rssOff: med('rss', 'off'), rssOn: med('rss', 'on'), loopOff: med('loop', 'off'), loopOn: med('loop', 'on'),
          speedOnMin: Math.min(...M.speed.on), thrOnMax: Math.max(...M.thr.on.filter((v) => v !== null), -Infinity) };
        row.cpuAdd = row.cpuOn - row.cpuOff; row.cpuRel = row.cpuOff > 0 ? row.cpuAdd / row.cpuOff : null;
        row.wireReductionCross = row.wireOff > 0 ? 1 - row.wireOn / row.wireOff : null;
        out.stageTable.push(row);
        const isH = st === headline, tag = `stage "${st}"`;
        if (isH) {
          const c1 = row.reductionMedian >= T.bwMedian, c2 = row.reductionMin >= T.bwEach;
          out.checks.push([`${tag} bandwidth: median reduction ${pc(row.reductionMedian)} (need at least ${pc(T.bwMedian)})`, c1]);
          out.checks.push([`${tag} bandwidth: weakest single trial ${pc(row.reductionMin)} (need at least ${pc(T.bwEach)})`, c2]);
          const cr = row.cpuRel !== null && row.cpuRel <= T.cpuRel, ca = row.cpuAdd <= T.cpuAbs;
          out.checks.push([`${tag} CPU: ${pc(row.cpuRel)} change versus off, median ${f(row.cpuOff, 3)} to ${f(row.cpuOn, 3)} cores (limit ${pc(T.cpuRel)})`, cr]);
          out.checks.push([`${tag} CPU: ${f(row.cpuAdd, 3)} extra cores (limit ${T.cpuAbs}); both CPU limits must pass`, ca]);
          if (row.wireReductionCross !== null && Math.abs(row.wireReductionCross - row.reductionMedian) > 0.15) out.notes.push(`${tag}: the cross-run wire reduction (${pc(row.wireReductionCross)}) differs from the in-run measure (${pc(row.reductionMedian)}) by more than 15 points; game content differed between runs. The in-run measure is used for the verdict.`);
        }
        out.checks.push([`${tag} latency: round-trip p95 ${f(row.rttOn, 1)} ms on vs ${f(row.rttOff, 1)} ms off (at most +${T.rttP95Add} ms)`, row.rttOn - row.rttOff <= T.rttP95Add]);
        out.checks.push([`${tag} snapshot gap p95: ${f(row.gapOn, 1)} ms on vs ${f(row.gapOff, 1)} ms off (at most +${T.gapP95Add} ms)`, row.gapOn - row.gapOff <= T.gapP95Add]);
        out.checks.push([`${tag} memory: peak RSS ${f(row.rssOn, 1)} MB on vs ${f(row.rssOff, 1)} MB off (at most +${T.rssAdd} MB)`, row.rssOn - row.rssOff <= T.rssAdd]);
        out.checks.push([`${tag} event-loop delay p99: ${f(row.loopOn, 1)} ms on vs ${f(row.loopOff, 1)} ms off (at most ${T.loopMax} ms and +${T.loopAdd} ms)`, row.loopOn <= T.loopMax && row.loopOn - row.loopOff <= T.loopAdd]);
        out.checks.push([`${tag} game speed with compression: slowest room ${f(row.speedOnMin, 3)}, every trial (at least ${T.minSpeed})`, row.speedOnMin >= T.minSpeed]);
        out.checks.push([`${tag} game speed in the compression-OFF baseline: slowest room ${f(Math.min(...M.speed.off), 3)} (at least ${T.minSpeed}, otherwise the baseline is unhealthy)`, Math.min(...M.speed.off) >= T.minSpeed]);
        if (isFinite(row.thrOnMax) && row.thrOnMax > 5) out.checks.push([`${tag} CPU throttling with compression: ${f(row.thrOnMax, 1)} s (at most 5 s)`, false]);
        else if (isFinite(row.thrOnMax)) { const thrOff = median(M.thr.off); out.checks.push([`${tag} CPU throttling: ${f(row.thrOnMax, 1)} s on vs ${f(thrOff, 1)} s off (at most off + 2 s and 5 s)`, thrOff === null || row.thrOnMax - thrOff <= 2]); }
      }
    }
  }
  if (!opts.noFull && full.length === 1) {
    const { on, off } = checkGroup(full[0], 'full match');
    if (!on.length || !off.length) inconclusive(`full match: need a run for each condition, found ${on.length} on and ${off.length} off`);
    for (const r of [...on, ...off]) if (r.complete) {
      const ms = r.stages.map((x) => spd(x.matchSpeed));
      if (ms.some((v) => v === null) || r.stages.some((x) => !(x.matchesFinished >= 1))) { inconclusive(`full match run ${r.file}: the whole-match game speed or the finished-match count is missing or invalid`); continue; }
      out.checks.push([`full match with compression ${r.cond.toUpperCase()} (${r.file}): finished normally with valid agreeing results`, true]);
      out.checks.push([`full match with compression ${r.cond.toUpperCase()} (${r.file}): whole-match game speed ${f(Math.min(...ms), 3)} (at least ${T.minSpeed})`, Math.min(...ms) >= T.minSpeed]);
    }
  }
  return finish(out);
}

function finish(out) {
  /* a RECOMMENDED verdict needs the headline bandwidth, CPU and game-speed checks to have actually been made */
  const has = (re) => out.checks.some(([m]) => re.test(m));
  if (!out.problems.length && !(has(/bandwidth: median/) && has(/CPU: .*change versus off/) && has(/game speed with compression/) && has(/game speed in the compression-OFF/))) out.problems.push('the required bandwidth, CPU and game-speed checks could not all be made');
  for (const [m, ok] of out.checks) if (!ok) out.failures.push(m);
  out.verdict = out.problems.length ? 'INCONCLUSIVE' : out.failures.length ? 'NOT RECOMMENDED' : 'RECOMMENDED';
  return out;
}

function render(out) {
  const L = [];
  L.push('# Compression test: on versus off'); L.push('');
  L.push('> Local loopback test on a GitHub runner with real Socket.IO. It measures byte ratios and relative CPU only. It does NOT establish Render performance (CPU limits, throttling, cold starts, internet latency, the proxy) or browser performance (browser deflate, phone decompression cost). Those need the separate Tier B staging test.'); L.push('');
  L.push(`## Verdict: ${out.verdict}`); L.push('');
  if (out.verdict === 'RECOMMENDED') L.push('Every threshold passed in this local test. This is not yet evidence for the live game.');
  if (out.verdict === 'NOT RECOMMENDED') L.push('At least one threshold failed. Compression should not be adopted on this evidence.');
  if (out.verdict === 'INCONCLUSIVE') L.push('The data cannot support a verdict. Nothing is claimed about compression.');
  L.push('');
  if (out.problems.length) { L.push('### Problems with the data'); for (const p of out.problems) L.push(`- ${p}`); L.push(''); }
  if (out.failures.length) { L.push('### Failed thresholds'); for (const p of out.failures) L.push(`- ${p}`); L.push(''); }
  if (out.checks.length) { L.push('### All checks'); L.push('| Result | Check |'); L.push('|---|---|'); for (const [m, ok] of out.checks) L.push(`| ${ok ? 'pass' : 'FAIL'} | ${m} |`); L.push(''); }
  if (out.stageTable && out.stageTable.length) {
    L.push(`### Measurements (medians; headline stage: ${out.headlineStage})`); L.push('');
    L.push('| Stage | Wire/decoded ratio off | on | Reduction median / weakest trial | Wire KB/s off / on | CPU cores off / on | CPU ms per snapshot off / on | RTT p95 off / on | RSS MB off / on |'); L.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of out.stageTable) L.push(`| ${r.stage} | ${f(r.ratioOff, 3)} | ${f(r.ratioOnMedian, 3)} | ${pc(r.reductionMedian)} / ${pc(r.reductionMin)} | ${f(r.wireOff, 1)} / ${f(r.wireOn, 1)} | ${f(r.cpuOff, 3)} / ${f(r.cpuOn, 3)} | ${f(r.cpuSnapOff, 3)} / ${f(r.cpuSnapOn, 3)} | ${f(r.rttOff, 1)} / ${f(r.rttOn, 1)} | ${f(r.rssOff, 1)} / ${f(r.rssOn, 1)} |`);
    L.push('');
  }
  L.push('### Files used'); for (const x of out.files) L.push(`- ${x.file}: compression ${x.condition.toUpperCase()}, ${x.complete ? 'complete' : 'INCOMPLETE'}`);
  if (out.order) L.push(`- Run order: ${out.order.join(', ')}`);
  for (const n of out.notes) L.push(`- Note: ${n}`);
  return L.join('\n') + '\n';
}

module.exports = { evaluate, render, T };
if (require.main === module) {
  const args = process.argv.slice(2), paths = []; const opts = { noFull: false, out: null };
  for (let i = 0; i < args.length; i++) { if (args[i] === '--no-fullmatch') opts.noFull = true; else if (args[i] === '--out') opts.out = args[++i]; else paths.push(args[i]); }
  if (!paths.length) { console.log('usage: node perf/compare.js <results files or folders> [--no-fullmatch] [--out folder]'); process.exit(2); }
  const o = evaluate(paths, opts), md = render(o); console.log(md);
  const dir = opts.out || __dirname;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'compare-verdict.json'), JSON.stringify(o, null, 1)); fs.writeFileSync(path.join(dir, 'compare-summary.md'), md); } catch (e) { console.log('(could not write the summary files: ' + e.message + ')'); }
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch (e) {}
  process.exit(o.verdict === 'INCONCLUSIVE' ? 1 : 0);
}
