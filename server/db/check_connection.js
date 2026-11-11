#!/usr/bin/env node
'use strict';
/* READ-ONLY check of a real hosted PostgreSQL (e.g. the Render STAGING database). It writes nothing.
   Exit 0 = everything required is verified, 1 = a problem, 3 = NOT RUN (pg missing / no URL).
   Usage:  APP_ENV=staging DATABASE_URL=<external or internal url> BB_ALLOWED_DB_HOSTS=<that host> DB_SSL=require node db/check_connection.js
   Reports: server version, whether TLS is really in use and its version, database name, the role (superuser? owner of the
   tables? both weaken the append-only protection), environment tag and migration state (if initialised), and latency. */
try { require('pg'); } catch (e) { console.log('NOT RUN: the "pg" package is not installed (run npm install)'); process.exit(3); }
const { load, assertDbAllowed, redact, dbName, dbHost, isLocalDb } = require('../config');
const { PgAdapter } = require('./adapters');
const cfg = load();
if (!cfg.databaseUrl) { console.log('NOT RUN: DATABASE_URL not set'); process.exit(3); }
if (!cfg.appEnvExplicit) { console.log('set APP_ENV explicitly'); process.exit(1); }
(async () => {
  let bad = 0; const row = (k, v, good) => { console.log((good === false ? 'PROBLEM ' : 'ok      ') + k + ': ' + v); if (good === false) bad++; };
  try {
    assertDbAllowed(cfg);   // same host/environment rules as every other tool; no confirmation needed because nothing is written
    const a = new PgAdapter(cfg.databaseUrl); const t0 = Date.now(); await a.connect(); const connectMs = Date.now() - t0;
    row('connected to', `${dbHost(cfg.databaseUrl) || 'socket'} / ${dbName(cfg.databaseUrl)} in ${connectMs} ms (DB_SSL=${a.sslMode})`);
    row('server', (await a.query('SHOW server_version'))[0][0]);
    const ssl = (await a.query('SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()'))[0] || [];
    const remote = !isLocalDb(cfg.databaseUrl);
    row('TLS in use', ssl[0] === 't' ? `yes (${ssl[1]}, ${ssl[2]})` : 'NO', remote ? ssl[0] === 't' : undefined);
    const me = (await a.query("SELECT current_user, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user"))[0];
    row('role', `${me[0]} (superuser: ${me[1]}, can create databases: ${me[2]})`, me[1] === 'f' ? undefined : (cfg.isProduction ? false : undefined));
    if (me[1] === 't') console.log('note    a superuser role can disable the append-only triggers; the production game role must not be a superuser');
    const t1 = Date.now(); await a.query('SELECT 1'); row('round trip', (Date.now() - t1) + ' ms');
    const has = (await a.query("SELECT to_regclass('public.meta') IS NOT NULL"))[0][0] === 't';
    if (has) {
      row('environment tag', (await a.query("SELECT value FROM meta WHERE key='env_tag'"))[0]?.[0] || 'none', undefined);
      const tag = (await a.query("SELECT value FROM meta WHERE key='env_tag'"))[0]; if (tag && tag[0] !== cfg.appEnv) row('tag matches APP_ENV', `database is "${tag[0]}", APP_ENV is "${cfg.appEnv}"`, false);
      row('migrations applied', (await a.query('SELECT count(*) FROM schema_migrations'))[0][0]);
    } else row('state', 'empty / not initialised (fine for a new database)');
    await a.close();
  } catch (e) { console.log('PROBLEM ' + redact(e.message)); bad++; }
  console.log(bad ? 'FAILED' : 'VERIFIED (read-only check passed)'); process.exit(bad ? 1 : 0);
})();
