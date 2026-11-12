'use strict';
/* Central configuration and database safety rules. Nothing here is secret; secrets only come from environment
   variables and are never printed (use redact() for any log line that mentions a connection string).

   Database safety model (defence in depth, every layer is tested in db/test_db.js):
   1. Every database is stamped with the environment it belongs to (meta.env_tag). A tool for another environment refuses it.
   2. A database is only stamped by an explicit --init, never as a side effect, and read-only commands never create anything.
   3. Development and staging may only connect to LOCAL databases or hosts you list in BB_ALLOWED_DB_HOSTS (an allow-list,
      not a block-list): a production address that nobody remembered to list is refused by default.
   4. Production tools need BB_CONFIRM_PRODUCTION set to the exact database name (not a generic yes) for anything that
      migrates, backs up or restores, so a stray environment variable cannot authorise an operation on the wrong database.
   5. Restores check the dump's environment against the target's (see db/backup.js).
   6. The environment must be named explicitly (APP_ENV) for any database tool; there is no silent default. */
const ENVS = ['development', 'staging', 'production'];
const LOCAL = ['localhost', '127.0.0.1', '::1', '[::1]'];

function load(env) {
  env = env || process.env;
  const raw = env.APP_ENV, appEnv = (raw || 'development').toLowerCase();
  if (!ENVS.includes(appEnv)) throw new Error(`APP_ENV must be one of ${ENVS.join(', ')} (got "${appEnv}")`);
  const list = (v) => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return {
    appEnv, appEnvExplicit: !!raw, isProduction: appEnv === 'production',
    port: +env.PORT || 3000,
    databaseUrl: env.DATABASE_URL || '',
    dbDriver: env.DB_DRIVER || 'pg',                     // 'pg' (real) or 'psql' (development/test helper only)
    allowedDbHosts: list(env.BB_ALLOWED_DB_HOSTS),       // non-production environments may use these remote hosts
    protectedDbHosts: list(env.BB_PROTECTED_DB_HOSTS),   // extra block-list (never relied on alone)
    confirmProduction: env.BB_CONFIRM_PRODUCTION || '',  // must equal the production database name
    allowProdDataCopy: env.BB_ALLOW_PROD_DATA_COPY === 'yes'
  };
}
function parseDb(url) {
  const m = /^postgres(?:ql)?:\/\/(?:[^@\/]*@)?(\[[^\]]*\]|[^\/:?]*)(?::\d+)?\/?([^?]*)(?:\?(.*))?$/.exec(String(url || ''));
  if (!m) return { host: '', name: '', socket: false };
  const q = new URLSearchParams(m[3] || ''), qh = q.get('host') || '';
  const socket = (!m[1] && qh.startsWith('/')) || m[1].startsWith('/');
  return { host: (m[1] || (socket ? '' : qh)).toLowerCase(), name: decodeURIComponent(m[2] || ''), socket };
}
const dbHost = (url) => parseDb(url).host;
const dbName = (url) => parseDb(url).name;
const isLocalDb = (url) => { const p = parseDb(url); return p.socket || LOCAL.includes(p.host); };
function redact(text) { return String(text).replace(/(\/\/[^:\/@\s]*:)[^@\s]+@/g, '$1***@').replace(/(password=)[^&\s]+/gi, '$1***'); }

/* Throws unless this configuration may use the database in `url` (default cfg.databaseUrl).
   opts.sensitive: the operation changes data, exports data or restores (migrate, backup, restore, init). */
function assertDbAllowed(cfg, opts) {
  opts = opts || {}; const url = opts.url || cfg.databaseUrl;
  if (!url) throw new Error('DATABASE_URL is not set');
  const p = parseDb(url);
  if (!p.name) throw new Error('could not read the database name from the connection string');
  if (cfg.protectedDbHosts.includes(p.host)) { if (!cfg.isProduction) throw new Error(`APP_ENV=${cfg.appEnv} may not use protected database host "${p.host}"`); }
  if (!cfg.isProduction) {
    if (!isLocalDb(url) && !cfg.allowedDbHosts.includes(p.host)) throw new Error(`APP_ENV=${cfg.appEnv} may only use a local database or a host listed in BB_ALLOWED_DB_HOSTS; "${p.host}" is neither`);
  } else if (opts.sensitive && cfg.confirmProduction !== p.name) {
    throw new Error(`this operation on production needs BB_CONFIRM_PRODUCTION set to the exact database name ("${p.name}")`);
  }
}
module.exports = { load, redact, dbHost, dbName, parseDb, isLocalDb, assertDbAllowed, ENVS };
