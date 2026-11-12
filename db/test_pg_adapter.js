'use strict';
/* REAL pg adapter test. Exit codes: 0 passed, 1 failed, 3 NOT RUN (pg package missing / no database given).
   Needs: npm install, and BB_ADMIN_URL pointing at a local throw-away PostgreSQL. */
try { require('pg'); } catch (e) { console.log('NOT RUN: the "pg" package is not installed (run npm install)'); process.exit(3); }
if (!process.env.BB_ADMIN_URL) { console.log('NOT RUN: set BB_ADMIN_URL to a local throw-away PostgreSQL'); process.exit(3); }
const { PgAdapter } = require('./adapters'); const { isLocalDb } = require('../config');
if (!isLocalDb(process.env.BB_ADMIN_URL) && process.env.BB_TEST_ALLOW_REMOTE !== 'yes') { console.log('refusing: not a local database'); process.exit(2); }
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
(async () => {
  const a = new PgAdapter(process.env.BB_ADMIN_URL), b = new PgAdapter(process.env.BB_ADMIN_URL);
  await a.connect(); await b.connect();
  try {
    ok(JSON.stringify(await a.query('SELECT 1, \'x\', NULL')) === '[["1","x",null]]', 'query returns rows as text arrays (NULL -> null)');
    ok(JSON.stringify(await a.query('SELECT true, false, true AND false')) === '[["t","f","f"]]', 'booleans come back as psql-style "t"/"f" (not "true"/"false"), which migrate.js and check_connection.js rely on');
    await a.exec('CREATE TEMP TABLE t (id int); BEGIN; INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); COMMIT');
    ok((await a.query('SELECT count(*) FROM t'))[0][0] === '2', 'exec runs several statements incl. BEGIN/COMMIT in one call');
    let err = ''; try { await a.exec('BEGIN; INSERT INTO t VALUES (3); SELECT 1/0; COMMIT'); } catch (e) { err = e.message; }
    await a.exec('ROLLBACK');
    ok(/division by zero/.test(err) && (await a.query('SELECT count(*) FROM t'))[0][0] === '2', 'a failing script rejects and ROLLBACK leaves the table untouched');
    await a.query('SELECT pg_advisory_lock(727999)');
    ok((await b.query('SELECT pg_try_advisory_lock(727999)'))[0][0] === 'f', 'session advisory lock is held across calls (second connection cannot take it)');
    await a.query('SELECT pg_advisory_unlock(727999)');
    ok((await b.query('SELECT pg_try_advisory_lock(727999)'))[0][0] === 't', 'lock is released by unlock');
  } finally { await a.close(); await b.close(); }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL crash', e.message); process.exit(1); });
