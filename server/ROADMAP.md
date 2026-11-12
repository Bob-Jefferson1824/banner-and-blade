# Banner & Blade: master roadmap (updated from your full specification)

Rules that apply to every stage: back up before significant changes; keep the existing game, single-player maps, custom battles and
working multiplayer intact; migrations only (never manual production edits); development/staging separate from production; no
purchases without your approval; each stage is tested, reported (done vs planned vs unverified) and **approved by you before the next starts**.

## Fixed decisions (from your specification)
- Accounts: username + password (scrypt hashing), recovery codes only, no email, no real name, no date of birth; secure sessions with logout and revocation; account-based identity; **one live connection per account** (a second login deliberately takes over and disconnects the first, announced to the player).
- Guests: ordinary multiplayer matches (no saved progress), single-player and custom battles without an account.
- Six permanent houses (the currently approved system): Red = House Ravenscourt; Gold = House Goldcrest; Blue = House Stormwatch; Green = House Wildmere; Purple = House Nightfall; Orange = House Ironvale. Territories recorded so far: Ravenscourt and Thornwatch Keep (Red), Central Palace (Gold: it starts Gold but is capturable), Southern Castle and Coastal Castle (Blue), Westwood Castle (Green). Starting territories for Purple and Orange have not been specified yet and will not be invented. A house is chosen once per account and is permanent initially. No territory is permanently owned by anyone.
- Continent: online-only, host-dependent (only you can host at first), **server-authoritative** (the host's browser is never the server), saved continuously to PostgreSQL, world clock runs only while open, 10-minute grace period after an unexpected host disconnect then save and close, server restart recovers the saved world, clear "continent unavailable" message, later always-on possible without a rewrite. A battle interrupted by a crash is **voided** (no result, no territory or progression change).

## Stages
| # | Stage | Contents | Status |
|---|---|---|---|
| 1 | Safety, database protection, integration tests | Backup; production/restore protection; `pg` dependency; real integration tests; append-only history | **All four required checks PASSED on GitHub Actions (run #7, results as you reported them); ready for your sign-off, not closed until you say so.** Real `pg` adapter tests, the full 81-check database suite through `pg`, real Socket.IO end-to-end, and the Render staging PostgreSQL connection with TLS 1.3. See `STAGE1_REPORT.md`. |
| 2 | Accounts | Register/login/logout, scrypt hashing (async, limited concurrency), recovery codes (hashed, one-time), session tokens (hash stored), revocation, rate limiting and lockout, restricted DB role; guests unaffected | Planned |
| 3 | Account identity in multiplayer | Socket handshake with token, account ID replaces socket ID, one connection per account, guest path kept, validated usernames | Planned |
| 3b | **Lag diagnosis (measurement only)** | Instrumentation and measurement, no gameplay or networking changes; cause report + proposed solution for your approval (approved decision) | Planned, immediately after Stage 3 |
| 4 | Profiles and progression | Server-computed XP/level, stats, wins/losses, unlocks, currency + ledger, achievements, preferences, house choice screen; idempotent match saving | Planned |
| 5 | Houses and territory database | Houses/territories wired to the game data for all six houses; palace banner colours corrected; capture-state tables in use (see the six-house database note under "Known risks") | Planned |
| 6 | Host-dependent continent lifecycle | Host Continent/stop, single-writer lease, heartbeat, 10-minute grace, checkpoint + append-only events, crash recovery, voided interrupted battles, unavailable messages; tested with a placeholder world | Planned |
| 7 | Continent map, presence, exploration | Online-only continent client (offline continent exploration gated behind the server), real-time presence with interest management, territory display | Planned |
| 8 | Territory capture and battles | Instanced battles whose verified results change ownership; interrupted battles voided | Planned |
| 9a | Multiplayer chat | See below | Planned |
| 9b | **Cavalry and Guard classes (required)** | Design approval, then simulation, network sync, models, AI, balance, tests (see `CLASSES.md`) | Planned |
| 9c | Class selection after death | Built after 9b so the roster is final: Knight, Archer, Spearman, Cavalry, Guard (+ Crossbowman/Scout if you keep them online) | Planned |
| 10 | Multiplayer optimisation + load testing | Implements the solution approved after 3b; load testing | Planned |
| 11 | Final security, backups, deployment | Security review, scheduled backups tested, deployment/cost review, full regression | Planned |

### Approved order change
**Lag diagnosis (Stage 3b) is measurement only and happens immediately after Stage 3, before any continent presence work.** Nothing in gameplay or
networking changes until the causes are identified and you have approved a proposed solution. Optimisation (Stage 10) follows that approval; load testing stays at the end.

### Lag (Part 5): what is known so far (hypotheses, NOT conclusions)
Measured in Stage 1: ~26 KB/s per player at 20 snapshots/s with full state every time; server CPU low in my sandbox. Candidate causes to verify: no client prediction (your own movement waits a full round trip), full-state snapshots at a fixed rate, interpolation delay, input rate, a free-tier host's CPU and network distance (Render region), client frame rate with many soldier models. Nothing will be changed before diagnosis, and combat accuracy will not be traded for speed.

### Stage 9 notes
- **9a Chat:** bottom-left, Enter to open/send, username + house colour (guests: neutral colour), server-validated (length limit, control-character stripping, rate limit), match-scoped only, no control conflicts; medieval styling. No global continent chat.
- **9b Cavalry and Guard (required):** these are required classes and are **not** replaced by Crossbowman or Scout. See `CLASSES.md` for how the existing five classes relate to the planned five and for the implementation plans. Each needs your design approval before building.
- **9c Class after death:** death screen lists classes; only unlocked ones selectable; keeping the current class allowed; applied only at respawn; server-validated; other players see the correct model/weapon; no reset of unrelated progression. Roster = Knight, Archer, Spearman, Cavalry, Guard. Crossbowman and Scout remain in the game; whether they also appear in the online/progression roster is your decision (undecided).

## Known risks across the plan
- **The database does not yet match the six-house system.** The Stage 1 migrations (0001 to 0004) seed four houses (Red, Gold, Blue, Green) with the Blue and Green names unset, and no Purple or Orange. Applied migrations are never edited, so a new forward-only migration must add Purple and Orange, set the six names, and assign territories once you specify them. It is needed before any player can choose a house (Stage 4). It is not part of Stage 1, and nothing in Stage 1 changed.
- Verified in Stage 1 (GitHub Actions run #7): the real `pg` adapter, the database suite through `pg`, real Socket.IO, and the Render **staging** database over TLS 1.3 using its external address. Not yet verified: Render's internal database address, any production database (none exists yet), and the browser multiplayer flow in CI.
- `pg` returns some types differently from `psql` (booleans were the first difference found). From Stage 2, new database code must convert timestamps, JSON and similar values to text explicitly and be tested through the real `pg` adapter.
- `package-lock.json` is generated by the GitHub Actions workflow and must be committed so that installs are reproducible (see `STAGE1_REPORT.md`).
- Render free tier limits (sleep, restarts, free database expiry, 5 GB bandwidth) as explained earlier; any paid change needs your approval after a cost explanation.
- Real 3D rendering cannot be checked in my environment.
