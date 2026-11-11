'use strict';
/* Database adapters share one tiny interface:
     await a.connect();  rows = await a.query(sql);  await a.exec(script);  await a.close();
   query() returns an array of row arrays (text). exec() runs one or more statements; the connection is a
   single session, so session-level features (advisory locks, open transactions) work between calls.
   - 'pg'   : production adapter using the "pg" package (installed on the server).
   - 'psql' : development/test adapter driving a long-lived psql process, used where the pg package
              cannot be installed. Same behaviour, same migration code path. */
const { spawn } = require('child_process');

/* TLS for the real pg adapter is controlled ONLY by DB_SSL (the sslmode/ssl parameters in the URL are removed, so there is
   no ambiguity between pg versions):
     disable : no TLS (local development)
     require : encrypted, server certificate not verified
     verify  : encrypted and the certificate is verified (optionally against the CA file in DB_SSL_CA)
     auto    : (default) disable for local databases, require for any other host
   Render's external database address needs TLS; its internal address (same region) may not. UNVERIFIED against Render:
   run  node db/check_connection.js  with the real address to confirm (it reports whether TLS is actually in use). */
function sslOptions(url, env) {
  const { isLocalDb } = require('../config');
  let mode = (env.DB_SSL || 'auto').toLowerCase(); if (mode === 'auto') mode = isLocalDb(url) ? 'disable' : 'require';
  if (mode === 'disable') return { mode, ssl: false };
  if (mode === 'require') return { mode, ssl: { rejectUnauthorized: false } };
  if (mode === 'verify') { const o = { rejectUnauthorized: true }; if (env.DB_SSL_CA) o.ca = require('fs').readFileSync(env.DB_SSL_CA, 'utf8'); return { mode, ssl: o }; }
  throw new Error('DB_SSL must be auto, disable, require or verify');
}
const stripSsl = (url) => url.replace(/([?&])(sslmode|ssl|sslrootcert)=[^&]*/gi, '$1').replace(/[?&]$/, '').replace('?&', '?');
class PgAdapter {
  constructor(url, env) { this.url = url; this.env = env || process.env; }
  async connect() {
    const { Client } = require('pg'); const t = sslOptions(this.url, this.env); this.sslMode = t.mode;
    this.c = new Client({ connectionString: stripSsl(this.url), ssl: t.ssl, connectionTimeoutMillis: 10000 }); await this.c.connect();
  }
  async query(sql) { const r = await this.c.query({ text: sql, rowMode: 'array' }); return (Array.isArray(r) ? r[r.length - 1] : r).rows.map(row => row.map(v => (v == null ? null : String(v)))); }
  async exec(script) { await this.c.query(script); }
  async close() { if (this.c) await this.c.end(); }
}

class PsqlAdapter {
  constructor(url) { this.url = url; this.n = 0; }
  connect() {
    this.p = spawn('psql', ['-X', '-q', '-A', '-t', '-F', '\x1f', '-v', 'ON_ERROR_STOP=1', this.url], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.out = ''; this.err = ''; this.pending = null; this.dead = null;
    this.p.stdout.on('data', d => { this.out += d; this._check(); });
    this.p.stderr.on('data', d => { this.err += d; });
    this.p.on('exit', (code) => { this.dead = new Error('psql: ' + (this.err.trim() || 'exited ' + code)); if (this.pending) { const p = this.pending; this.pending = null; p.rej(this.dead); } });
    return this.run('SELECT 1').then(() => {});
  }
  _check() {
    if (!this.pending) return; const tok = this.pending.tok, i = this.out.indexOf(tok); if (i < 0) return;
    const body = this.out.slice(0, i); this.out = this.out.slice(i + tok.length + 1); const p = this.pending; this.pending = null;
    p.res(body.split('\n').filter(l => l.length).map(l => l.split('\x1f').map(v => (v === '' ? null : v))));
  }
  run(sql) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((res, rej) => {
      const tok = '@@DONE' + (++this.n) + '@@'; this.pending = { tok, res, rej };
      this.p.stdin.write(sql.replace(/\s*;?\s*$/, ';') + '\n\\echo ' + tok + '\n');
    });
  }
  async query(sql) { return this.run(sql); }
  async exec(script) { await this.run(script); }
  async close() { if (this.p && !this.dead) { this.p.stdin.end('\\q\n'); await new Promise(r => this.p.on('exit', r)); } }
}
function create(driver, url) { if (driver === 'psql') return new PsqlAdapter(url); if (driver === 'pg') return new PgAdapter(url); throw new Error('unknown DB_DRIVER ' + driver); }
module.exports = { create, PgAdapter, PsqlAdapter, sslOptions, stripSsl };
