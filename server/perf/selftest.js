'use strict';
/* Deterministic self-tests for the staging helpers. No network, no Socket.IO, no secrets.  Run: node perf/selftest.js */
const { stagingGate } = require('./staging_gate.js'); const { createStats } = require('./stats.js');
let bad = 0; const t = (name, ok, extra) => { if (!ok) bad++; console.log((ok ? 'PASSED' : 'FAILED') + '  ' + name + (extra ? '  ' + extra : '')); };
/* 1. staging gate */
const S = 'x'.repeat(24);
for (const [n, env, want] of [['no secret', {}, false], ['short secret', { BB_STAGING_SECRET: 'short' }, false], ['secret only', { BB_STAGING_SECRET: S }, true],
  ['production service name', { BB_STAGING_SECRET: S, RENDER_SERVICE_NAME: 'banner-and-blade' }, false], ['staging service name', { BB_STAGING_SECRET: S, RENDER_SERVICE_NAME: 'banner-and-blade-staging' }, true],
  ['look-alike name', { BB_STAGING_SECRET: S, RENDER_SERVICE_NAME: 'banner-and-blade-staging.evil' }, false], ['database present', { BB_STAGING_SECRET: S, DATABASE_URL: 'postgres://u@h/db' }, false]])
  t('gate: ' + n, stagingGate(env).enabled === want);
/* 2. per-room game speed and discard accounting with a fake clock */
const realNow = Date.now; let clock = 1e12; Date.now = () => clock;
const mk = (code, ended) => [code, { code, members: new Map(), match: { ended } }];
const hub = { rooms: new Map([mk('A', false), mk('B', false), mk('C', true), mk('D', false)]) }, io = { engine: { clients: {} } };
const api = createStats({ hub, io, flags: {}, secret: S }); const c = api.collector;
const step = (code, n, dt) => { for (let i = 0; i < n; i++) c.onStep(0.1, dt, code); };
// reset happens inside createStats at clock=1e12. Rooms start stepping right away.
step('A', 300, 1 / 30); step('B', 150, 1 / 30); step('C', 300, 1 / 30);   // 10 s: A at full speed, B at half speed, C stepped but its match has ended
c.onDiscard(0.3, 'cap', 'B'); c.onDiscard(0.5, 'stall');
clock += 10000; step('D', 10, 1 / 30);                                      // D only just appeared (0 s of data)
const w = api.reportForTest ? api.reportForTest().window : null;
const rep = (function () { const r = {}; const res = { writeHead() {}, end(b) { r.body = JSON.parse(b); } }; api.handle({ headers: { 'x-staging-secret': S }, url: '/stats' }, res); return r.body; })().window;
t('game speed: slowest room is B at 0.5', Math.abs(rep.gameSpeedSlowestRoom - 0.5) < 0.01, 'got ' + rep.gameSpeedSlowestRoom);
t('game speed: mean over measured rooms is 0.75', Math.abs(rep.gameSpeedMeanRoom - 0.75) < 0.01, 'got ' + rep.gameSpeedMeanRoom);
t('game speed: ended match and brand-new room are not measured', rep.roomsMeasured === 2, 'got ' + rep.roomsMeasured);
t('discard: cap total 0.3 and worst room 0.3', rep.discardedByCatchupCapS === 0.3 && rep.discardedByCatchupCapWorstRoomS === 0.3);
t('discard: stall limit 0.5 recorded separately', rep.discardedByStallLimitS === 0.5);
Date.now = realNow;
/* 3. event-loop delay no longer includes the 10 ms timer interval */
setTimeout(() => {
  const r = {}; api.handle({ headers: { 'x-staging-secret': S }, url: '/stats' }, { writeHead() {}, end(b) { r.b = JSON.parse(b); } });
  t('event loop: idle p50 reads under 5 ms (was about 10.2 ms before the fix)', r.b.window.eventLoopDelayMs.p50 < 5, 'got ' + r.b.window.eventLoopDelayMs.p50);
  api.handle({ headers: { 'x-staging-secret': 'wrong' }, url: '/stats' }, { writeHead(c) { r.code = c; }, end() {} });
  t('stats: wrong secret gives 401', r.code === 401);
  console.log(bad ? `\n${bad} FAILED` : '\nAll PASSED'); process.exit(bad ? 1 : 0);
}, 1500);
