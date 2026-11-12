-- Persistent player progress.
CREATE TABLE profiles (
  account_id     uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  house_id       text REFERENCES houses(id),      -- NULL until the player chooses; then permanent (trigger below)
  level          integer NOT NULL DEFAULT 1  CHECK (level >= 1),
  xp             bigint  NOT NULL DEFAULT 0  CHECK (xp >= 0),
  currency       bigint  NOT NULL DEFAULT 0  CHECK (currency >= 0),
  matches_played integer NOT NULL DEFAULT 0,
  wins           integer NOT NULL DEFAULT 0,
  losses         integer NOT NULL DEFAULT 0,
  kills          integer NOT NULL DEFAULT 0,
  deaths         integer NOT NULL DEFAULT 0,
  damage_dealt   bigint  NOT NULL DEFAULT 0,
  stats_extra    jsonb   NOT NULL DEFAULT '{}'::jsonb,   -- room for new statistics without a migration
  preferences    jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- House choice is permanent initially: once set it cannot be changed by ordinary statements.
-- A deliberate administrative change must set:  SET LOCAL bb.allow_house_change = 'on';
CREATE FUNCTION profiles_house_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.house_id IS NOT NULL AND NEW.house_id IS DISTINCT FROM OLD.house_id
     AND coalesce(current_setting('bb.allow_house_change', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'house is permanent once chosen' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER profiles_house_guard BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION profiles_house_guard();

CREATE TABLE unlocks (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('class', 'weapon', 'equipment')),
  item_id     text NOT NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind, item_id)
);
CREATE TABLE achievements (
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  achievement_id text NOT NULL,
  unlocked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, achievement_id)
);
-- Every change to currency is recorded, so balances can be audited and repaired.
CREATE TABLE currency_ledger (
  id            bigserial PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  delta         bigint NOT NULL,
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  reason        text NOT NULL,
  ref           text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX currency_ledger_account_idx ON currency_ledger (account_id, id);
-- One row per player per match. (match_key, account_id) is unique so a retry can never count a match twice.
CREATE TABLE match_history (
  id              bigserial PRIMARY KEY,
  match_key       text NOT NULL,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode            text NOT NULL,
  map             text NOT NULL,
  class_id        text,
  result          text NOT NULL CHECK (result IN ('win', 'loss', 'draw', 'left')),
  kills           integer NOT NULL DEFAULT 0,
  deaths          integer NOT NULL DEFAULT 0,
  damage_dealt    integer NOT NULL DEFAULT 0,
  xp_gained       integer NOT NULL DEFAULT 0,
  currency_gained integer NOT NULL DEFAULT 0,
  played_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_key, account_id)
);
CREATE INDEX match_history_account_idx ON match_history (account_id, played_at DESC);
