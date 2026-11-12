'use strict';
/* Database safety + migration + backup tests. Needs a throw-away PostgreSQL: set BB_ADMIN_URL (may create/drop
   databases; must be local unless BB_TEST_ALLOW_REMOTE=yes). Only creates and drops databases named bbt_* / bb_verify_*.
   DB_DRIVER=psql (default here) drives migrations through the psql helper; DB_DRIVER=pg uses the REAL pg adapter
   (requires `npm install`): that is the "real adapter" run. The result line states which driver actually ran. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { load, redact, parseDb, isLocalDb, assertDbAllowed } = require('../config');
const { migrate } = require('./migrate');
const bk = require('./backup');
const ADMIN = process.env.BB_ADMIN_URL; if (!ADMIN) { console.log('set BB_ADMIN_URL'); process.exit(2); }
if (!isLocalDb(ADMIN) && process.env.BB_TEST_ALLOW_REMOTE !== 'yes') { console.log('refusing: BB_ADMIN_URL is not a local database (set BB_TEST_ALLOW_REMOTE=yes for a throw-away remote server)'); process.exit(2); }
const DRIVER = process.env.DB_DRIVER || 'psql';
if (DRIVER === 'pg') { try { require('pg'); } catch (e) { console.log('NOT RUN: DB_DRIVER=pg but the "pg" package is not installed (run npm install)'); process.exit(3); } }
let fails = 0, n = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const psql = (url, sql) => { try { return execFileSync('psql', ['-X', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql, url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { throw new Error((e.stderr || '').trim().split('\n').filter(l => !/^(NOTICE|DETAIL|HINT|CONTEXT)/.test(l)).join(' ')); } };
const failsWith = (url, sql) => { try { psql(url, sql); return ''; } catch (e) { return e.message; } };
const made = [];
const mk = () => { const nme = 'bbt_' + crypto.randomBytes(3).toString('hex'); psql(ADMIN, 'CREATE DATABASE ' + nme); const d = { name: nme, url: bk.withDb(ADMIN, nme) }; made.push(d); return d; };
const dropDb = (d) => psql(ADMIN, 'DROP DATABASE IF EXISTS ' + d.name + ' WITH (FORCE)');
const cfgFor = (url, env, extra) => Object.assign(load({ APP_ENV: env || 'development', DATABASE_URL: url, DB_DRIVER: DRIVER }), extra || {});
const prodCfg = (d, extra) => cfgFor(d.url, 'production', Object.assign({ confirmProduction: d.name }, extra || {}));
const rejects = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
const throws = (f) => { try { f(); return ''; } catch (e) { return e.message; } };
const mkEnv = async (env) => { const d = mk(); await migrate({ cfg: env === 'production' ? prodCfg(d) : cfgFor(d.url, env), init: true }); return d; };
const MIG = path.join(__dirname, 'migrations');

(async () => {
  try {
    console.log('driver for migrations: ' + DRIVER + (DRIVER === 'psql' ? '  (psql helper, NOT the real pg adapter)' : '  (real pg adapter)'));
    // ---- A. initialisation is explicit; read-only commands create nothing
    let d = mk();
    ok(/not initialised.*implicitly/.test(await rejects(migrate({ cfg: cfgFor(d.url) }))), 'migrate on an unstamped database refuses to initialise it implicitly');
    const st = await migrate({ cfg: cfgFor(d.url), dryRun: true });
    ok(st.uninitialised && psql(d.url, "SELECT count(*) FROM pg_tables WHERE schemaname='public'") === '0', 'status on an empty database reports "not initialised" and creates nothing');
    const r1 = await migrate({ cfg: cfgFor(d.url), init: true });
    ok(r1.applied.length === 5 && r1.tag === 'development', 'explicit --init: 5 migrations applied, database tagged development');
    ok(psql(d.url, "SELECT string_agg(id||':'||coalesce(display_name,'NULL'),',' ORDER BY sort_order) FROM houses") === 'blue:NULL,red:House Ravenscourt,green:NULL,gold:House Goldcrest', 'houses: Blue/Green names NULL (undecided), Ravenscourt + Goldcrest set');
    ok(psql(d.url, "SELECT string_agg(id||'='||owner_house,',' ORDER BY id) FROM territories") === 'central_palace=gold,coastal_castle=blue,ravenscourt=red,southern_castle=blue,thornwatch=red,westwood_castle=green', 'territory ownership seeded as agreed');
    psql(d.url, "UPDATE territories SET owner_house='red', version=version+1 WHERE id='central_palace'");
    ok(psql(d.url, "SELECT owner_house FROM territories WHERE id='central_palace'") === 'red', 'Central Palace is not locked to Gold (can be captured)');
    ok(/check constraint/.test(failsWith(d.url, "UPDATE houses SET name_status='final' WHERE id='blue'")), 'a house name cannot be marked final without a name');
    const r2 = await migrate({ cfg: cfgFor(d.url) }); ok(r2.applied.length === 0 && r2.skipped === 5, 'rerun applies nothing');
    const stt = await migrate({ cfg: cfgFor(d.url), dryRun: true }); ok(stt.applied.length === 0 && !stt.uninitialised, 'status on an initialised database is read-only and accurate');
    // ---- B. checksums, tags
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')); for (const f of fs.readdirSync(MIG)) fs.copyFileSync(path.join(MIG, f), path.join(tdir, f));
    fs.appendFileSync(path.join(tdir, '0001_houses.sql'), '\n-- edited later\n');
    ok(/modified after it was applied/.test(await rejects(migrate({ cfg: cfgFor(d.url), dir: tdir }))), 'edited applied migration is refused');
    fs.copyFileSync(path.join(MIG, '0001_houses.sql'), path.join(tdir, '0001_houses.sql'));
    ok(/tagged "development".*"staging"/.test(await rejects(migrate({ cfg: cfgFor(d.url, 'staging') }))), 'staging tool refuses a development database');
    ok(/tagged "development".*"production"/.test(await rejects(migrate({ cfg: prodCfg(d) }))), 'production tool (even confirmed) refuses a development database');

    // ---- C. production protection
    const prod = await mkEnv('production');
    ok(psql(prod.url, "SELECT value FROM meta WHERE key='env_tag'") === 'production', 'a production database can only be created with the exact-name confirmation');
    ok(/needs BB_CONFIRM_PRODUCTION/.test(await rejects(migrate({ cfg: cfgFor(prod.url, 'production') }))), 'production migrate without confirmation refused');
    ok(/needs BB_CONFIRM_PRODUCTION/.test(await rejects(migrate({ cfg: cfgFor(prod.url, 'production', { confirmProduction: 'yes' }) }))), 'a generic "yes" does not authorise production (must be the exact database name)');
    ok(/needs BB_CONFIRM_PRODUCTION/.test(await rejects(migrate({ cfg: cfgFor(prod.url, 'production', { confirmProduction: d.name }) }))), 'confirmation for a different database name does not work');
    ok((await migrate({ cfg: cfgFor(prod.url, 'production'), dryRun: true })).applied.length === 0, 'read-only status on production needs no confirmation and changes nothing');
    ok(/tagged "production".*"development"/.test(await rejects(migrate({ cfg: cfgFor(prod.url, 'development') }))), 'development tool refuses a production-tagged database');
    ok(/tagged "production".*"staging"/.test(await rejects(migrate({ cfg: cfgFor(prod.url, 'staging') }))), 'staging tool refuses a production-tagged database');
    const fresh = mk();   // a brand-new empty database that someone points a dev tool at by mistake
    ok(/not initialised.*implicitly/.test(await rejects(migrate({ cfg: cfgFor(fresh.url, 'staging') }))) && psql(fresh.url, "SELECT count(*) FROM pg_tables WHERE schemaname='public'") === '0', 'a dev/staging tool pointed at a new empty (e.g. production) database cannot initialise it');
    const remote = 'postgresql://app:pw@dpg-abc123.oregon-postgres.render.com/bb_prod';
    for (const env of ['development', 'staging']) ok(/only use a local database/.test(throws(() => assertDbAllowed(cfgFor(remote, env), { sensitive: true }))) && /only use a local database/.test(throws(() => assertDbAllowed(cfgFor(remote, env)))), `${env} is refused any remote database that is not on its allow-list (no block-list needed)`);
    ok(throws(() => assertDbAllowed(cfgFor(remote, 'staging', { allowedDbHosts: ['dpg-abc123.oregon-postgres.render.com'] }), { sensitive: true })) === '', 'a remote host works only when explicitly allow-listed');
    ok(/protected database host/.test(throws(() => assertDbAllowed(cfgFor(remote, 'staging', { allowedDbHosts: ['dpg-abc123.oregon-postgres.render.com'], protectedDbHosts: ['dpg-abc123.oregon-postgres.render.com'] })))), 'the optional protected-host list still blocks even an allow-listed host');
    ok(throws(() => assertDbAllowed(cfgFor('postgresql://u@localhost:5432/x', 'development'))) === '' && throws(() => assertDbAllowed(cfgFor('postgresql://u@127.0.0.1/x', 'development'))) === '', 'local databases are accepted for development');
    ok(parseDb('postgresql://u:p@host.example:5432/mydb?sslmode=require').name === 'mydb' && parseDb('postgresql://u:p@host.example:5432/mydb').host === 'host.example', 'connection strings are parsed correctly');
    ok(!/s3cret/.test(redact('postgresql://user:s3cret@host/db?password=s3cret')), 'connection strings are redacted in logs');
    // the CLI refuses to run without an explicit environment
    const cli = (args, env) => new Promise(res => { const p = spawn(process.execPath, args, { env: Object.assign({ PATH: process.env.PATH }, env) }); let o = ''; p.stdout.on('data', x => o += x); p.stderr.on('data', x => o += x); p.on('exit', c => res({ c, o })); });
    const noenv = await cli([path.join(__dirname, 'migrate.js'), 'status'], { DATABASE_URL: d.url, DB_DRIVER: DRIVER });
    ok(noenv.c === 1 && /set APP_ENV explicitly/.test(noenv.o), 'migration CLI refuses to run without an explicit APP_ENV');
    const noenv2 = await cli([path.join(__dirname, 'backup.js'), 'backup', os.tmpdir()], { DATABASE_URL: d.url });
    ok(noenv2.c === 1 && /APP_ENV explicitly/.test(noenv2.o), 'backup CLI refuses to run without an explicit APP_ENV');

    // ---- D. failures and file hygiene
    fs.writeFileSync(path.join(tdir, '0006_bad.sql'), "CREATE TABLE half_done (id int);\nINSERT INTO half_done VALUES (1);\nSELECT 1/0;\n");
    ok(/rolled back/.test(await rejects(migrate({ cfg: cfgFor(d.url), dir: tdir }))), 'failing migration reports rollback');
    ok(psql(d.url, "SELECT to_regclass('half_done') IS NULL") === 't' && psql(d.url, "SELECT count(*) FROM schema_migrations") === '5', 'failed migration left no partial table and no bookkeeping row');
    fs.unlinkSync(path.join(tdir, '0006_bad.sql'));
    fs.writeFileSync(path.join(tdir, '0007_gap.sql'), 'SELECT 1;'); ok(/gap/.test(await rejects(migrate({ cfg: cfgFor(d.url), dir: tdir, dryRun: true }))), 'numbering gap rejected'); fs.unlinkSync(path.join(tdir, '0007_gap.sql'));
    fs.writeFileSync(path.join(tdir, '0006_tx.sql'), 'BEGIN;\nSELECT 1;\nCOMMIT;'); ok(/must not contain/.test(await rejects(migrate({ cfg: cfgFor(d.url), dir: tdir, dryRun: true }))), 'migration with its own BEGIN/COMMIT rejected'); fs.unlinkSync(path.join(tdir, '0006_tx.sql'));

    // ---- E. future update keeps player data
    const ids = [];
    for (const u of ['Alice', 'Bob', 'Cara']) { const id = psql(d.url, `WITH a AS (INSERT INTO accounts (username) VALUES ('${u}') RETURNING id) INSERT INTO credentials SELECT id, 'scrypt$demo' FROM a RETURNING account_id`).split('\n')[0]; ids.push(id); psql(d.url, `INSERT INTO profiles (account_id, house_id, xp, currency, wins) VALUES ('${id}', 'gold', 500, 120, 7)`); psql(d.url, `INSERT INTO unlocks VALUES ('${id}', 'class', 'archer')`); }
    const sig = () => psql(d.url, "SELECT md5(string_agg(a.username||p.xp||p.currency||p.wins||p.house_id, ',' ORDER BY a.username)) FROM accounts a JOIN profiles p ON p.account_id=a.id");
    const before = sig();
    fs.writeFileSync(path.join(tdir, '0006_future_update.sql'), "ALTER TABLE profiles ADD COLUMN prestige integer NOT NULL DEFAULT 0;\nUPDATE profiles SET prestige = wins / 5;\nCREATE INDEX profiles_prestige_idx ON profiles (prestige);");
    const r7 = await migrate({ cfg: cfgFor(d.url), dir: tdir });
    ok(r7.applied.length === 1 && before === sig() && psql(d.url, "SELECT sum(prestige) FROM profiles") === '3', 'future migration adds a column + backfills; all existing player data identical');
    ok((await migrate({ cfg: cfgFor(d.url) })).ahead.length === 1, 'database ahead of code (rolled-back deploy) detected and tolerated');
    ok(/does not know/.test(await rejects(migrate({ cfg: cfgFor(d.url), strict: true }))), '--strict refuses when database is ahead');

    // ---- F. data rules
    ok(/duplicate key/.test(failsWith(d.url, "INSERT INTO accounts (username) VALUES ('ALICE')")), 'usernames unique case-insensitively');
    ok(/check constraint/.test(failsWith(d.url, "INSERT INTO accounts (username) VALUES ('a b')")), 'invalid usernames rejected');
    ok(/check constraint/.test(failsWith(d.url, `UPDATE profiles SET currency = -5 WHERE account_id='${ids[0]}'`)), 'currency cannot go negative');
    ok(/house is permanent/.test(failsWith(d.url, `UPDATE profiles SET house_id='red' WHERE account_id='${ids[0]}'`)), 'chosen house cannot be changed by ordinary updates');
    ok(psql(d.url, `BEGIN; SET LOCAL bb.allow_house_change='on'; UPDATE profiles SET house_id='red' WHERE account_id='${ids[0]}'; COMMIT; SELECT house_id FROM profiles WHERE account_id='${ids[0]}'`).endsWith('red'), 'deliberate administrative house change is possible');
    psql(d.url, `INSERT INTO match_history (match_key, account_id, mode, map, result) VALUES ('m1','${ids[1]}','tdm','castle','win')`);
    ok(/duplicate key/.test(failsWith(d.url, `INSERT INTO match_history (match_key, account_id, mode, map, result) VALUES ('m1','${ids[1]}','tdm','castle','win')`)), 'the same match cannot be recorded twice for one player');
    psql(d.url, `INSERT INTO world_sessions (host_account_id) VALUES ('${ids[0]}')`);
    ok(/duplicate key/.test(failsWith(d.url, `INSERT INTO world_sessions (host_account_id) VALUES ('${ids[1]}')`)), 'only one world session can be open at a time');
    ok(!/password/i.test(psql(d.url, "SELECT string_agg(column_name,',') FROM information_schema.columns WHERE table_name IN ('accounts','profiles','sessions')")), 'password data is not in accounts/profiles/sessions tables');

    // ---- G. append-only history
    const sid = psql(d.url, "SELECT id FROM world_sessions WHERE ended_at IS NULL").split('\n')[0];
    psql(d.url, `INSERT INTO world_events (session_id, type, payload) VALUES (${sid}, 'territory_captured', '{"t":"ravenscourt","by":"gold"}'), (${sid}, 'battle_voided', '{}')`);
    ok(psql(d.url, "SELECT count(*) FROM world_events") === '2', 'world events can be appended');
    ok(/append-only/.test(failsWith(d.url, "UPDATE world_events SET type='x'")), 'world_events: UPDATE refused');
    ok(/append-only/.test(failsWith(d.url, "DELETE FROM world_events")), 'world_events: DELETE refused');
    ok(/append-only/.test(failsWith(d.url, "TRUNCATE world_events")), 'world_events: TRUNCATE refused');
    ok(/append-only/.test(failsWith(d.url, "TRUNCATE world_sessions, world_events CASCADE")) || /violates foreign key|cannot truncate/.test(failsWith(d.url, "TRUNCATE world_sessions")), 'world_events cannot be wiped through a cascading truncate or by deleting its session');
    ok(/append-only|foreign key/.test(failsWith(d.url, "DELETE FROM world_sessions")), 'deleting a world session that has events is refused');
    ok(/append-only/.test(failsWith(d.url, "BEGIN; SET LOCAL bb.allow_account_erase='on'; DELETE FROM world_events; COMMIT")), 'no override flag exists for world_events');
    psql(d.url, `INSERT INTO currency_ledger (account_id, delta, balance_after, reason) VALUES ('${ids[1]}', 50, 50, 'match_reward')`);
    ok(/append-only/.test(failsWith(d.url, "UPDATE currency_ledger SET delta=999")), 'currency_ledger: UPDATE refused');
    ok(/append-only/.test(failsWith(d.url, "DELETE FROM currency_ledger")), 'currency_ledger: DELETE refused in normal operation');
    ok(/append-only/.test(failsWith(d.url, "TRUNCATE accounts CASCADE")), 'cascading truncate from accounts cannot erase the ledger');
    ok(/append-only/.test(failsWith(d.url, `DELETE FROM accounts WHERE id='${ids[1]}'`)), 'deleting an account with ledger rows is refused outside an erasure');
    psql(d.url, `BEGIN; SET LOCAL bb.allow_account_erase='on'; DELETE FROM accounts WHERE id='${ids[1]}'; COMMIT`);
    ok(psql(d.url, `SELECT count(*) FROM accounts WHERE id='${ids[1]}'`) === '0' && psql(d.url, "SELECT count(*) FROM currency_ledger") === '0', 'an explicit account erasure removes the account and its ledger rows');
    ok(psql(d.url, "SELECT count(*) FROM world_events") === '2', 'world events untouched by all of the above');

    // ---- H. concurrent runners
    const d2 = mk();
    const run = () => cli([path.join(__dirname, 'migrate.js'), 'up', '--init'], { APP_ENV: 'development', DB_DRIVER: DRIVER, DATABASE_URL: d2.url });
    const rs = await Promise.all([run(), run(), run()]);
    ok(rs.every(x => x.c === 0) && psql(d2.url, 'SELECT count(*) FROM schema_migrations') === '5' && rs.reduce((t, x) => t + (/applied (\d)/.exec(x.o) ? +/applied (\d)/.exec(x.o)[1] : 0), 0) === 5, 'three runners starting at once: every migration applied exactly once, no errors');

    // ---- I. backup / restore
    const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    const dcfg = cfgFor(d.url);
    const b = bk.backup(d.url, bdir, 14, dcfg);
    ok(fs.existsSync(b.dump) && b.manifest.rows.accounts === 2 && b.manifest.envTag === 'development', 'backup written with manifest (accounts, env tag, schema version ' + b.manifest.schemaVersion + ')');
    ok(/tagged "development".*"staging"/.test(throws(() => bk.backup(d.url, bdir, 14, cfgFor(d.url, 'staging')))), 'backup refuses a database of another environment');
    ok(/needs BB_CONFIRM_PRODUCTION/.test(throws(() => bk.backup(prod.url, bdir, 14, cfgFor(prod.url, 'production')))), 'backing up production needs the exact-name confirmation');
    const pb = bk.backup(prod.url, bdir, 14, prodCfg(prod)); ok(pb.manifest.envTag === 'production', 'production backup works with the confirmation');
    const v = bk.verify(b.dump, ADMIN, dcfg); ok(v.tables >= 12 && v.stampedAs === 'development', `verify: restored ${v.tables} tables / ${v.rows} rows into a temporary DB, all counts match`);
    ok(psql(ADMIN, "SELECT count(*) FROM pg_database WHERE datname LIKE 'bb_verify_%'") === '0', 'verification database was dropped');
    const dr = mk(); const rr = bk.restore(b.dump, dr.url, dcfg);
    ok(rr.rows === v.rows && psql(dr.url, "SELECT value FROM meta WHERE key='env_tag'") === 'development', 'restore into a new database reproduces the data and stamps it for the target environment');
    ok((await migrate({ cfg: cfgFor(dr.url) })).applied.length === 0, 'restored database is recognised by the migration runner');
    ok(/not empty/.test(throws(() => bk.restore(b.dump, d.url, dcfg))), 'restore refuses a non-empty database (never overwrites)');
    // restore environment matrix
    const tgt = () => mk();
    ok(/refusing to restore development data into production/.test(throws(() => { const t = tgt(); bk.restore(b.dump, t.url, prodCfg(t)); })), 'development data can never be restored into production (even with the confirmation)');
    ok(/refusing to restore development data into production/.test(throws(() => { const t = tgt(); bk.restore(b.dump, t.url, cfgFor(t.url, 'production', { confirmProduction: t.name, allowProdDataCopy: true })); })), 'the data-copy flag does not open the way into production');
    const sdb = await mkEnv('staging'); const sb = bk.backup(sdb.url, bdir, 14, cfgFor(sdb.url, 'staging'));
    ok(/refusing to restore staging data into production/.test(throws(() => { const t = tgt(); bk.restore(sb.dump, t.url, prodCfg(t)); })), 'staging data can never be restored into production');
    ok(/environments must match/.test(throws(() => { const t = tgt(); bk.restore(sb.dump, t.url, cfgFor(t.url, 'development')); })), 'a staging dump is not restored into a development database');
    ok(/refusing to copy production data into development/.test(throws(() => { const t = tgt(); bk.restore(pb.dump, t.url, cfgFor(t.url, 'development')); })), 'production data is not copied into development without an explicit flag');
    const t3 = tgt(); const r3 = bk.restore(pb.dump, t3.url, cfgFor(t3.url, 'development', { allowProdDataCopy: true }));
    ok(r3.stampedAs === 'development' && /production backup/.test(psql(t3.url, "SELECT value FROM meta WHERE key='restored_from'")), 'with the explicit flag a production copy is allowed, re-stamped as development and its origin recorded');
    ok(/needs BB_CONFIRM_PRODUCTION/.test(throws(() => { const t = tgt(); bk.restore(pb.dump, t.url, cfgFor(t.url, 'production')); })), 'restoring into a production target needs the exact-name confirmation');
    const t4 = tgt(); ok(bk.restore(pb.dump, t4.url, prodCfg(t4)).stampedAs === 'production', 'a production dump restores into a new empty production database when confirmed with that database\'s name');
    ok(/set APP_ENV explicitly/.test(throws(() => { const t = tgt(); bk.restore(b.dump, t.url, load({ DATABASE_URL: t.url })); })), 'restore refuses to guess the target environment');
    ok(/only use a local database/.test(throws(() => bk.restore(b.dump, remote, dcfg))), 'restore into a non-local, non-allow-listed host is refused before any connection');
    // disaster drill + corruption + rotation
    psql(d.url, 'DROP TABLE match_history, profiles CASCADE'); const dd = mk(); bk.restore(b.dump, dd.url, dcfg);
    ok(psql(dd.url, "SELECT count(*) FROM profiles") === '2', 'disaster drill: tables destroyed in the live DB, intact copy recovered from the backup');
    const bad = path.join(bdir, 'bad.dump'); fs.copyFileSync(b.dump, bad); fs.copyFileSync(b.dump + '.manifest.json', bad + '.manifest.json'); const buf = fs.readFileSync(bad); fs.writeFileSync(bad, buf.slice(0, buf.length - 200));
    ok(/checksum/.test(throws(() => bk.verify(bad, ADMIN, dcfg))), 'damaged backup is detected before restore');
    ok(psql(ADMIN, "SELECT count(*) FROM pg_database WHERE datname LIKE 'bb_verify_%'") === '0', 'no leftovers after failed verification');
    for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 1100)); bk.backup(d2.url, bdir, 2, cfgFor(d2.url)); }
    ok(fs.readdirSync(bdir).filter(f => f.startsWith('bb-development-') && f.endsWith('.dump') && f.length > 0).length <= 3, 'rotation keeps only the newest N backups');
  } catch (e) { fails++; console.log('TEST CRASH', e.stack); }
  finally { for (const m of made) { try { dropDb(m); } catch (e) {} } }
  console.log(`${n} checks, driver=${DRIVER}: ` + (fails ? fails + ' FAILED' : 'ALL PASSED')); process.exit(fails ? 1 : 0);
})();
