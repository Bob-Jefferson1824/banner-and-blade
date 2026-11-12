# Banner & Blade: multiplayer server

Authoritative Node.js + Socket.IO server. It runs the **same simulation code as the game** (`sim.js`, generated
from the game file), so the server decides every hit, death, respawn and score. Browsers only send their controls
(move, look, attack, block...) and draw what the server reports. Empty places in a match are filled with AI soldiers.

Online modes: **Team Deathmatch, Free for All, Iron Squad, Conquest** (not Fortress siege); maps Castle, Village,
Central Palace, Fortress (TDM/FFA/Iron Squad only). 1-8 humans per room.

## Files
| File | Purpose |
|---|---|
| `server.js` | HTTP + Socket.IO entry point (also serves `public/index.html` and `/health`) |
| `hub.js` | Rooms, lobby, validation, match loop, snapshots (transport independent) |
| `sim.js` | The game simulation (generated; re-create it whenever the game file changes) |
| `public/index.html` | A copy of the game, so `http://localhost:3000` works on its own |
| `test_mp.js` | Automated test of the lobby/match logic (`npm test`) |
| `package.json` | Dependencies (`socket.io`, `pg`) and scripts |
| `config.js` | Environment and database safety rules (Stage 1; not used by the game yet) |
| `db/` | Database tools: migrations, backup/restore, `pg` adapter, connection check, database tests (Stage 1) |
| `verify.js` | Runs every Stage 1 test suite and prints PASSED / FAILED / NOT RUN |
| `test_socketio.js` | End-to-end test with the real `socket.io` server and client |
| `STAGE1_REPORT.md`, `ROADMAP.md`, `CLASSES.md` | Stage 1 results, the staged plan, and the class roster notes |
| `.env.example` | Template of every setting (placeholders only; copy to `.env`, never commit `.env`) |

## Run locally
1. Install Node.js 20. This is the version the automated checks (GitHub Actions) run on. `package.json` still declares `>=16`, but older versions are untested.
2. In this folder: `npm install` then `npm start`.
3. Open `http://localhost:3000`, press **Online Play**, press **Connect** (address is filled in), **Create Room**.
4. Friends on the same network open `http://<your-computer-ip>:3000` (allow port 3000 in the firewall) and **Join**.

## Deploy online (any Node host)
**Render.com (free tier):** New > Web Service > connect a repo containing this `server` folder (root directory `server`),
build command `npm install`, start command `npm start`. Render sets `PORT` for you. Your address will be
`https://<name>.onrender.com`. (Free instances sleep when idle: the first connect can take ~30 s.)
**Railway / Fly.io / a VPS:** same idea: run `npm install && node server.js`; the host must support WebSockets.

Optional environment variables: `PORT`, `ALLOWED_ORIGINS` (comma separated list of web origins allowed to connect,
e.g. `https://yourname.github.io`; default is any origin).

## Frontend on GitHub Pages
The game stays one static HTML file. Upload it as `index.html` to GitHub Pages. Players open
`https://yourname.github.io/yourrepo/?server=https://<your-server-address>` (or type the address on the Online Play screen;
it is remembered). Set `ALLOWED_ORIGINS` on the server to your Pages origin. The server address must be `https://` when the page is `https://`.

## Database tools (Stage 1; the game server does not use the database yet)
Stage 1 added PostgreSQL migrations and safety tooling in `db/`. Running the game server (`npm start`) does not touch any database.
Every database command needs `APP_ENV` set explicitly (`development`, `staging` or `production`; there is no default), and a database must be
initialised once with `--init` before the tools will use it. See `STAGE1_REPORT.md` for the rules and the test results, and `.env.example` for every setting.
- `APP_ENV=development npm run db:migrate -- --init` (first time only), then `npm run db:migrate`
- `npm run db:status` (read-only), `npm run db:backup`, `npm run db:verify-backup -- <dumpfile>`
- `npm run verify` runs every suite and prints PASSED / FAILED / NOT RUN (database suites need `BB_ADMIN_URL` pointing at a local throw-away PostgreSQL).
- No terminal? The GitHub Actions workflow `.github/workflows/stage1-verify.yml` runs the same checks on GitHub's servers when a commit is pushed to the
  branch `stage1-verification`. It never deploys anything. Read the result on the run's Summary page.
- Automated tests never modify a staging or production database. The tests run against a throw-away local database. The only contact with the staging database is the optional
  read-only connection check (`db/check_connection.js`), which the workflow runs when the `RENDER_CHECK_URL` secret exists: it only reads (server version, TLS, role, environment tag), and writes nothing.
  Real connection strings go in the host's dashboard or a GitHub repository secret, never in files.

## Updating
Whenever the game file changes, regenerate `sim.js` (copy the first big `<script>` block that begins with
`const Sim = (function () {` and ends with `if (typeof module ...` into `sim.js`) and copy the game to `public/index.html`.
Client and server must come from the same game version.

## How it works / limits
- Server tick 30 Hz, snapshots 20 Hz, clients interpolate. There is **no client-side prediction**, so your own movement
  feels delayed by your ping (fine below ~100 ms, sluggish above).
- Input is validated (clamped, finite, rate-limited); clients cannot set health, score or position.
- A player who disconnects mid-match is replaced by an AI soldier. If the host leaves, another player becomes host.
- Players cannot join a match already in progress; after a match the room returns to the lobby.
