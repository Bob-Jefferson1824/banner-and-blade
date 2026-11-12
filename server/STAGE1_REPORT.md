# Banner & Blade: Stage 1 report (final)

**Status: all four required Stage 1 checks PASSED on GitHub Actions. Stage 1 is ready for your sign-off; it is not closed until you say so. Stage 2 has NOT been started.**

## 1. Required checks (your rule: a skipped test is never counted as passed)
| Required check | Result | Evidence |
|---|---|---|
| Real `pg` adapter tests (`db/test_pg_adapter.js`) | **PASSED** | GitHub Actions run #7 |
| Full database suite through the real `pg` adapter (`DB_DRIVER=pg`, 81 checks) | **PASSED** (81/81) | run #7 |
| Real Socket.IO end-to-end (`test_socketio.js`) | **PASSED** | run #7 |
| Render **staging** PostgreSQL connection and TLS (`db/check_connection.js`, read-only) | **PASSED**, TLS 1.3 confirmed | run #7 |

Other suites in the same run: lobby/match logic (`test_mp.js`) **PASSED**; database safety, migrations and backups through the `psql` helper, 81/81 **PASSED**.
The staging database role was reported as non-superuser (reported for run #4, the rerun; the production database role must also be non-superuser, see section 5).

**How this was established.** The run results above are as you reported them from GitHub; I did not read the run logs myself. The first run on GitHub found a real defect that my earlier
local tests could not see (see section 3). After the fix, all four required checks passed. Where I could not run something myself, this report says so.

## 2. What Stage 1 delivered (your five corrections)

**1. Production database protection (layered; the optional protected-host list is not the main defence)**
- Development/staging may use only **local** databases, plus remote hosts you list in `BB_ALLOWED_DB_HOSTS` (an allow-list: an unlisted production address is refused by default). `BB_PROTECTED_DB_HOSTS` is only an extra block-list.
- A database is stamped with its environment **only by an explicit `--init`**. A tool pointed at a new empty database refuses to initialise it. Read-only `status` creates nothing and changes nothing.
- A tool for another environment refuses a stamped database (development/staging cannot touch production, production cannot touch development).
- Production migrate, backup and restore need `BB_CONFIRM_PRODUCTION` set to the **exact database name**. A generic "yes" or another database's name is refused. Read-only status needs none.
- `APP_ENV` must be set explicitly for any database command (no silent default).

**2. Restore protection**
- The target must be a new, empty database allowed for that environment; restore never overwrites.
- Any non-production dump into production is **always refused** (no flag overrides this). A mismatch of environments is refused. A production dump into a non-production database is refused unless `BB_ALLOW_PROD_DATA_COPY=yes`, and is then re-stamped for the target with its origin recorded.
- A production target needs the exact-name confirmation. The dump checksum and every restored row count are verified. `verify` applies the same rules.

**3. `pg` is a normal dependency** (with `socket.io`; `socket.io-client` is a dev dependency).

**4. Real integration tests** now exist and ran on GitHub: `db/test_pg_adapter.js`, the database suite through `pg`, `test_socketio.js`, and `verify.js` (prints PASSED / FAILED / NOT RUN, and on a failure prints the failing lines).

**5. World event log append-only** (migration `0005_append_only.sql`)
- `world_events`: UPDATE, DELETE and TRUNCATE are refused (including cascading truncates and deleting a session that has events); no override exists.
- `currency_ledger`: UPDATE and TRUNCATE refused; DELETE refused except inside an explicit account erasure (`SET LOCAL bb.allow_account_erase='on'`), so a player can still delete their account.
- Honest limit: a database superuser or table owner can still drop these triggers deliberately. The application will use a restricted database role (planned for Stage 2).

## 3. Defect found by the real run, and its fix
The real `pg` package returns PostgreSQL booleans as JavaScript `true`/`false`; the `psql` helper prints `t`/`f`, and the migration and connection-check code compared against `'t'`.
Under `pg`, an already-initialised database looked uninitialised: re-running a migration failed, and the environment-tag safety check could be bypassed. The same flaw would also have made the Render check
report TLS as off. Fix (three files, no behaviour change for `psql`): `db/adapters.js` converts booleans back to `'t'`/`'f'`; `db/test_pg_adapter.js` gained a regression check; `verify.js` now prints the failing lines.
After the fix all required checks passed.

## 4. Existing game and multiplayer files
Compared byte for byte with the pre-Stage-1 backup: `server/server.js`, `server/hub.js`, `server/sim.js` and `server/public/index.html` are **unchanged**, and the repository's root `render.yaml` is identical to the original.
The game server (`npm start`) never loads the database code, so a deployment of this branch does not change how the game runs; the only runtime difference is that `npm install` also installs `pg`.
Not compared (not in my backup): the repository root `index.html` (the GitHub Pages game). Stage 1 did not change it; confirm with GitHub's compare view that it is untouched.
Files added by Stage 1: `config.js`, `db/` (adapters, migrate, backup, check_connection, tests, 5 migrations), `verify.js`, `test_socketio.js`, `.github/workflows/stage1-verify.yml`, `.gitignore`, `.env.example`, and these documents.
Changed: `package.json` (dependency and scripts) and `README.md` (documentation only).

## 5. Not verified, and remaining risks
- Render's **internal** database address was not tested (the check used the external address). Test it before the game server connects to a database.
- No production database exists yet; the production database role must be non-superuser. `check_connection.js` flags a superuser role as a problem in production.
- The browser multiplayer flow (`test_browser_mp.js`, Playwright) is not part of the GitHub run. It passed earlier in my own environment, and the game files are unchanged.
- `package-lock.json`: the workflow now uploads the generated file as a downloadable artifact (`package-lock`) on every run, and uses `npm ci` once the file is committed. Until you upload it to `server/`, installs are not pinned.
- The Render staging database is on the free tier (it expires after about 30 days and has no backups): do not keep anything valuable on it.
- The workflow reads the repository secret `RENDER_CHECK_URL` (staging credentials). Keep the repository private, and delete or rotate the secret when it is no longer needed.
- Merging into `main` redeploys the Render service if auto-deploy is on. The game code is unchanged, so behaviour should not change, but it is a deployment: you decide when.
- Real WebGL rendering is still unverifiable in my environment.
- Multiplayer has no client-side prediction (own movement lags by ping). Lag is to be measured in Stage 3b before anything is changed.

## 6. How to re-run the checks
Push any commit to the branch `stage1-verification`; the workflow runs by itself (or Actions > latest run > Re-run all jobs). It uses a throw-away PostgreSQL container, and the optional read-only staging check when the `RENDER_CHECK_URL` secret exists. It never deploys anything.
Locally (needs Node and PostgreSQL): `BB_ADMIN_URL=postgresql://postgres:<password>@localhost:5432/postgres npm run verify`.
