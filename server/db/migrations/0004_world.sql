-- The shared continent. World state lives in the database, never only in a server process, so a hosted
-- session can end (or crash) and the world resumes exactly where it stopped, and a future always-on world
-- is the same data with a different "who may open it" policy.
CREATE TABLE territories (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  home_house       text NOT NULL REFERENCES houses(id),   -- starting / traditional owner (never changes)
  owner_house      text NOT NULL REFERENCES houses(id),   -- current owner; any house may capture any territory
  capture_house    text REFERENCES houses(id),            -- house currently capturing, if any
  capture_progress real NOT NULL DEFAULT 0 CHECK (capture_progress >= 0 AND capture_progress <= 1),
  version          bigint NOT NULL DEFAULT 0,              -- bumped on every change (optimistic concurrency)
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO territories (id, name, home_house, owner_house) VALUES
  ('southern_castle', 'Southern Castle',  'blue',  'blue'),
  ('coastal_castle',  'Coastal Castle',   'blue',  'blue'),
  ('ravenscourt',     'Ravenscourt',      'red',   'red'),
  ('thornwatch',      'Thornwatch Keep',  'red',   'red'),
  ('westwood_castle', 'Westwood Castle',  'green', 'green'),
  ('central_palace',  'Central Palace',   'gold',  'gold');   -- Gold starts here; other houses MAY capture it.

-- Who opened the world and when. At most one session can be open at any time.
CREATE TABLE world_sessions (
  id                bigserial PRIMARY KEY,
  host_account_id   uuid REFERENCES accounts(id),   -- the account that opened it; NULL is reserved for a future always-on world opened by the server itself
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  end_reason        text CHECK (end_reason IN ('host_closed', 'host_lost', 'crash_recovered', 'maintenance', 'server_restart')),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX world_one_open_session ON world_sessions ((true)) WHERE ended_at IS NULL;

-- Single-row checkpoint of everything that must resume exactly: the world clock (it only advances while the
-- world is open), timers, capture progress, army positions... Updated continuously while the world is open.
CREATE TABLE world_state (
  id            smallint PRIMARY KEY CHECK (id = 1),
  seq           bigint NOT NULL DEFAULT 0,          -- last world_events.seq included in this checkpoint
  world_clock_s double precision NOT NULL DEFAULT 0,
  checkpoint    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO world_state (id) VALUES (1);
-- Append-only log of every important change (captures, battles, joins...). Checkpoint + events after
-- checkpoint.seq = exact state after a crash.
CREATE TABLE world_events (
  seq        bigserial PRIMARY KEY,
  session_id bigint REFERENCES world_sessions(id),
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Last known place of each player in the continent (written continuously while they are connected).
CREATE TABLE world_players (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  x          real NOT NULL, z real NOT NULL,
  state      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Only one server process may run the world at a time (fencing token guards against a stale process).
CREATE TABLE world_lease (
  id            smallint PRIMARY KEY CHECK (id = 1),
  holder        text,
  fencing_token bigint NOT NULL DEFAULT 0,
  expires_at    timestamptz
);
INSERT INTO world_lease (id) VALUES (1);
