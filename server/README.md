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
| `package.json` | Dependencies (`socket.io`) |

## Run locally
1. Install Node.js 16 or newer.
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
