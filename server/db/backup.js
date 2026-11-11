#!/usr/bin/env node
'use strict';
/* Backups you can prove work.
     node db/backup.js backup  [outdir]                 -> dump + manifest (row counts, schema version, env tag) + sha256
     node db/backup.js verify  <dumpfile>               -> restores into a temporary database, compares every row count, drops it
     node db/backup.js restore <dumpfile> <target-url>  -> restores into a NEW EMPTY database only
   Needs the PostgreSQL client tools (pg_dump, pg_restore, psql). verify needs BB_ADMIN_URL (a connection that may
   create/drop databases, e.g. your local Postgres). Dumps contain password hashes: keep them private. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const { load, redact, assertDbAllowed, dbName } = require('../config');
const sh = (cmd, args, o) => execFileSync(cmd, args, Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, o || {}));
const q = (url, sql) => sh('psql', ['-X', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql, url]).trim();
const withDb = (url, name) => url.replace(/^(postgres(?:ql)?:\/\/[^\/]*\/)[^?]*/, '$1' + name);
const fileSha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function counts(url) {
  const tables = q(url, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1").split('\n').filter(Boolean), out = {};
  for (const t of tables) out[t] = +q(url, `SELECT count(*) FROM "${t}"`); return out;
}
function meta(url) {
  const tag = q(url, "SELECT value FROM meta WHERE key='env_tag'") || null, v = q(url, 'SELECT coalesce(max(version),\'0000\') FROM schema_migrations');
  return { envTag: tag, schemaVersion: v };
}
function backup(url, outdir, keep, cfg) {
  if (cfg) { assertDbAllowed(cfg, { url, sensitive: true }); const t = meta(url).envTag; if (t && t !== cfg.appEnv) throw new Error(`database is tagged "${t}" but APP_ENV is "${cfg.appEnv}"; refusing to back it up`); }
  fs.mkdirSync(outdir, { recursive: true });
  const m = meta(url), stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19), name = `bb-${m.envTag}-${stamp}`;
  const dump = path.join(outdir, name + '.dump');
  sh('pg_dump', ['-Fc', '--no-owner', '--no-acl', '-f', dump, url]);
  const manifest = Object.assign({ file: path.basename(dump), createdAt: new Date().toISOString(), sha256: fileSha(dump), bytes: fs.statSync(dump).size, rows: counts(url) }, m);
  fs.writeFileSync(dump + '.manifest.json', JSON.stringify(manifest, null, 2));
  // rotation: keep the newest N dumps of this environment
  const all = fs.readdirSync(outdir).filter(f => f.startsWith(`bb-${m.envTag}-`) && f.endsWith('.dump')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) { fs.unlinkSync(path.join(outdir, f)); try { fs.unlinkSync(path.join(outdir, f + '.manifest.json')); } catch (e) {} }
  return { dump, manifest };
}
function readManifest(dump) { const f = dump + '.manifest.json'; if (!fs.existsSync(f)) throw new Error('manifest missing next to dump: ' + f); return JSON.parse(fs.readFileSync(f, 'utf8')); }
/* Restore rules (every one tested):
   - the target must be a NEW EMPTY database that the environment is allowed to use (same host rules as migrations)
   - the dump's environment must be compatible with the target environment:
       any non-production dump -> production target ......... always refused (cannot be overridden by a flag)
       dump from one non-production environment -> another .. refused (environments must match)
       production dump -> staging/development target ........ refused unless BB_ALLOW_PROD_DATA_COPY=yes (real players' hashes)
       production target ..................................... needs BB_CONFIRM_PRODUCTION = exact target database name
   - the dump must match its manifest checksum; the restored row counts must match the manifest
   - the restored database is stamped for the TARGET environment, and the source is recorded in meta */
function restore(dump, target, cfg) {
  if (!cfg) throw new Error('restore needs a configuration (APP_ENV); refusing to guess the target environment');
  if (!cfg.appEnvExplicit) throw new Error('set APP_ENV explicitly for restore; there is no default target environment');
  const man = readManifest(dump), src = man.envTag;
  if (!src) throw new Error('dump has no environment tag in its manifest; refusing');
  if (cfg.isProduction && src !== 'production') throw new Error(`refusing to restore ${src} data into production`);
  if (!cfg.isProduction && src === 'production') { if (!cfg.allowProdDataCopy) throw new Error('refusing to copy production data into ' + cfg.appEnv + ' (it contains real account data); set BB_ALLOW_PROD_DATA_COPY=yes only if you really mean it'); }
  else if (src !== cfg.appEnv) throw new Error(`refusing to restore ${src} data into a ${cfg.appEnv} database (environments must match)`);
  assertDbAllowed(cfg, { url: target, sensitive: true });
  if (fileSha(dump) !== man.sha256) throw new Error('dump checksum does not match its manifest (file damaged or altered)');
  const existing = q(target, "SELECT count(*) FROM pg_tables WHERE schemaname='public'");
  if (+existing !== 0) throw new Error('target database is not empty; restore only goes into a new empty database (it never overwrites)');
  sh('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '-d', target, dump]);
  const got = counts(target), bad = [];
  for (const t of Object.keys(man.rows)) if (got[t] !== man.rows[t]) bad.push(`${t}: expected ${man.rows[t]}, got ${got[t]}`);
  if (bad.length) throw new Error('row counts differ after restore: ' + bad.join('; '));
  q(target, `UPDATE meta SET value='${cfg.appEnv}' WHERE key='env_tag'`);
  q(target, `INSERT INTO meta (key, value) VALUES ('restored_from', '${src} backup ${path.basename(dump)}') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
  return { tables: Object.keys(got).length, rows: Object.values(got).reduce((a, b) => a + b, 0), manifest: man, stampedAs: cfg.appEnv };
}
function verify(dump, admin, cfg) {
  const tmp = 'bb_verify_' + crypto.randomBytes(4).toString('hex'), tmpUrl = withDb(admin, tmp);
  assertDbAllowed(cfg, { url: admin, sensitive: true });
  sh('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${tmp}`, admin]);
  try { return restore(dump, tmpUrl, cfg); }
  finally { try { sh('psql', ['-X', '-c', `DROP DATABASE IF EXISTS ${tmp}`, admin]); } catch (e) {} }
}
module.exports = { backup, restore, verify, counts, withDb };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2), cfg = load();
  try {
    if (cmd === 'backup') { if (!cfg.appEnvExplicit) throw new Error('set APP_ENV explicitly'); const r = backup(cfg.databaseUrl, a || path.join(__dirname, '..', 'backups'), +process.env.BB_BACKUP_KEEP || 14, cfg); console.log('backup written: ' + r.dump + ` (${r.manifest.bytes} bytes, schema ${r.manifest.schemaVersion}, env ${r.manifest.envTag})`); }
    else if (cmd === 'verify') { const r = verify(a, process.env.BB_ADMIN_URL || cfg.databaseUrl, cfg); console.log(`backup verified: restored ${r.tables} tables / ${r.rows} rows into a temporary database, all counts match, temp database dropped`); }
    else if (cmd === 'restore') { const r = restore(a, b, cfg); console.log(`restored ${r.tables} tables / ${r.rows} rows into the new database; counts match`); }
    else { console.log('usage: backup.js backup [outdir] | verify <dump> | restore <dump> <empty-target-url>'); process.exit(2); }
  } catch (e) { console.error('BACKUP ERROR: ' + redact((e.stderr || '') + e.message)); process.exit(1); }
}
