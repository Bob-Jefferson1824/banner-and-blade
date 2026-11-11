#!/usr/bin/env node
'use strict';
/* Forward-only, checksummed, transactional migration runner.
   Safety rules (all enforced here and covered by test_db.js):
   - never drops anything by itself; there are no "down" migrations (recovery = tested backups)
   - each migration runs in ONE transaction together with its bookkeeping row: all or nothing
   - an applied migration whose file was edited afterwards is refused (checksum)
   - the database carries an environment tag; a runner for another environment refuses to touch it
   - production needs an explicit confirmation flag
   - an advisory lock makes concurrent runners safe (two servers starting together) */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { load, assertDbAllowed, redact } = require('../config');
const { create } = require('./adapters');
const LOCK_KEY = 727001;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function readMigrations(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const out = []; let expect = 1;
  for (const f of files) {
    const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(f); if (!m) throw new Error('bad migration file name: ' + f);
    if (+m[1] !== expect) throw new Error(`migration numbering gap or duplicate at ${f} (expected ${String(expect).padStart(4, '0')})`);
    expect++; const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*(;|TRANSACTION\b|WORK\b)/im.test(sql)) throw new Error(f + ' must not contain BEGIN/COMMIT/ROLLBACK: the runner wraps it');
    out.push({ version: m[1], name: m[2], file: f, sql, checksum: sha(sql) });
  }
  return out;
}

async function migrate(opts) {
  const cfg = opts.cfg, dir = opts.dir || path.join(__dirname, 'migrations'), log = opts.log || (() => {});
  const readOnly = !!opts.dryRun;
  assertDbAllowed(cfg, { sensitive: !readOnly });
  const migrations = readMigrations(dir);
  const db = opts.adapter || create(cfg.dbDriver, cfg.databaseUrl);
  await db.connect();
  const result = { applied: [], skipped: 0, ahead: [], tag: null };
  try {
    await db.query('SELECT pg_advisory_lock(' + LOCK_KEY + ')');
    try {
      const exists = async (t) => (await db.query(`SELECT to_regclass('public.${t}') IS NOT NULL`))[0][0] === 't';
      const hasMeta = await exists('meta'), hasMig = await exists('schema_migrations');
      let tag = null;
      if (hasMeta) { const t = await db.query("SELECT value FROM meta WHERE key='env_tag'"); tag = t.length ? t[0][0] : null; }
      if (tag === null) {
        // not stamped: only an explicit --init may initialise it, and never a read-only command
        const used = hasMig ? +(await db.query('SELECT count(*) FROM schema_migrations'))[0][0] : 0;
        if (used > 0) throw new Error('database has migrations but no environment tag; refusing (tag it manually after checking which environment it is)');
        if (readOnly) { result.tag = null; result.uninitialised = true; result.applied = migrations.map(m => m.file); return result; }
        if (!opts.init) throw new Error(`database is not initialised for any environment; refusing to initialise it implicitly. If this really is the new ${cfg.appEnv} database, run "migrate up --init"`);
        await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), duration_ms integer NOT NULL DEFAULT 0);
                       CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value text NOT NULL);
                       INSERT INTO meta (key, value) VALUES ('env_tag', '${cfg.appEnv}') ON CONFLICT (key) DO NOTHING`);
        result.tag = cfg.appEnv;
      } else { result.tag = tag; if (tag !== cfg.appEnv) throw new Error(`this database is tagged "${tag}" but APP_ENV is "${cfg.appEnv}"; refusing to touch it`); }
      const applied = new Map((await db.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).map(r => [r[0], r[1]]));
      for (const m of migrations) if (applied.has(m.version) && applied.get(m.version) !== m.checksum) throw new Error(`migration ${m.file} was modified after it was applied (checksum mismatch); never edit applied migrations, add a new one`);
      for (const v of applied.keys()) if (!migrations.some(m => m.version === v)) result.ahead.push(v);
      if (result.ahead.length && opts.strict) throw new Error('database has migrations this code does not know: ' + result.ahead.join(', '));
      for (const m of migrations) {
        if (applied.has(m.version)) { result.skipped++; continue; }
        if (opts.dryRun) { result.applied.push(m.file); continue; }
        const t0 = Date.now(); log('applying ' + m.file);
        try {
          await db.exec(`BEGIN;\n${m.sql}\n;INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ('${m.version}', '${m.name}', '${m.checksum}', ${Date.now() - t0});\nCOMMIT;`);
        } catch (e) { try { await db.exec('ROLLBACK'); } catch (e2) {} throw new Error(`migration ${m.file} failed and was rolled back: ${redact(e.message)}`); }
        result.applied.push(m.file);
      }
    } finally { try { await db.query('SELECT pg_advisory_unlock(' + LOCK_KEY + ')'); } catch (e) {} }
  } finally { await db.close(); }
  return result;
}
module.exports = { migrate, readMigrations };

if (require.main === module) {
  const cmd = process.argv[2] || 'up';
  const cfg = load();
  if (!cfg.appEnvExplicit) { console.error('MIGRATION ERROR: set APP_ENV explicitly (development, staging or production); database tools have no default environment'); process.exit(1); }
  migrate({ cfg, dryRun: cmd === 'status', init: process.argv.includes('--init'), strict: process.argv.includes('--strict'), log: console.log }).then(r => {
    console.log(r.uninitialised ? 'database is not initialised (no environment tag, nothing was created)' : cmd === 'status' ? `pending: ${r.applied.length ? r.applied.join(', ') : 'none'}; already applied: ${r.skipped}; env tag: ${r.tag}` : `applied ${r.applied.length}, already up to date ${r.skipped}; env tag: ${r.tag}`);
    if (r.ahead.length) console.log('note: database is ahead of this code (' + r.ahead.join(', ') + '); fine for a rolled-back deploy if migrations are backward compatible');
  }).catch(e => { console.error('MIGRATION ERROR: ' + redact(e.message)); process.exit(1); });
}
