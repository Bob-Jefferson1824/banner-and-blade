'use strict';
/* Runs every test suite and prints an honest matrix: PASSED / FAILED / NOT RUN. A suite that could not run is never
   reported as passed. BB_ADMIN_URL (local throw-away PostgreSQL) enables the database suites. */
const { spawnSync } = require('child_process');
const suites = [
  ['Lobby/match logic, in-process (no network)', ['test_mp.js'], {}],
  ['Database safety, migrations, backups (psql helper driver)', ['db/test_db.js'], { DB_DRIVER: 'psql' }],
  ['Database safety, migrations, backups (REAL pg adapter)', ['db/test_db.js'], { DB_DRIVER: 'pg' }],
  ['pg adapter unit checks (REAL pg)', ['db/test_pg_adapter.js'], {}],
  ['Socket.IO end-to-end (REAL socket.io server + client)', ['test_socketio.js'], {}],
  ['Render PostgreSQL connection + TLS (read-only check)', ['db/check_connection.js'], null]
];
const REQUIRED = [2, 3, 4, 5];   // Stage 1 stays open until these four are PASSED (indexes into suites)
const rows = []; let bad = false;
for (const [name, args, env0] of suites) {
  let env = env0;
  if (env === null) {   // hosted-database check: needs RENDER_CHECK_URL (staging database address) and its host allow-listed
    if (!process.env.RENDER_CHECK_URL) { rows.push([name, 'NOT RUN', 'RENDER_CHECK_URL not set']); continue; }
    env = { APP_ENV: process.env.RENDER_CHECK_ENV || 'staging', DATABASE_URL: process.env.RENDER_CHECK_URL, DB_SSL: process.env.DB_SSL || 'auto' };
  }
  const needsDb = /db\/test/.test(args[0]);
  if (needsDb && !process.env.BB_ADMIN_URL) { rows.push([name, 'NOT RUN', 'BB_ADMIN_URL not set']); continue; }
  const r = spawnSync(process.execPath, args, { cwd: __dirname, env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 600000 });
  const last = (r.stdout || '').trim().split('\n').pop();
  const status = r.status === 0 ? 'PASSED' : r.status === 3 ? 'NOT RUN' : 'FAILED'; if (status === 'FAILED') bad = true;
  let detail = last;
  if (/check_connection/.test(args[0])) {   // show the TLS / role / problem lines, so the summary reports them
    const lines = (r.stdout || '').split('\n');
    const pick = status === 'FAILED' ? lines.filter(l => /^PROBLEM/.test(l)) : lines.filter(l => /(TLS in use|role:|environment tag)/.test(l));
    detail = (pick.length ? pick.map(l => l.replace(/\s+/g, ' ').trim()).join(' | ') : last) + (r.stderr && status === 'FAILED' ? ' | ' + r.stderr.trim().split('\n').pop() : '');
  }
  if (status !== 'PASSED' && !/check_connection/.test(args[0])) {   // show WHY a suite failed or did not run (lines starting FAIL / TEST CRASH / NOT RUN, plus any error text)
    const bad = ((r.stdout || '') + '\n' + (r.stderr || '')).split('\n').filter(l => /^(FAIL|TEST CRASH|NOT RUN|refusing|MIGRATION ERROR|Error|    at )/.test(l)).slice(0, 40);
    if (bad.length) { console.log('--- ' + name + ': ' + status + ' (first ' + bad.length + ' problem lines) ---'); console.log(bad.join('\n')); console.log('--- end ---'); }
    if (r.error) console.log('--- ' + name + ': could not start: ' + r.error.message);
  }
  rows.push([name, status, detail]);
}
for (const [n, s, d] of rows) console.log(s.padEnd(8) + ' ' + n + '   [' + d + ']');
const open = REQUIRED.filter(i => rows[i][1] !== 'PASSED' && rows[i][1] !== 'VERIFIED');
console.log(open.length ? '\nSTAGE 1 STAYS OPEN: ' + open.length + ' required check(s) not passed (NOT RUN counts as not passed).' : '\nAll four required Stage 1 checks PASSED.');
process.exit(bad ? 1 : 0);
