-- Accounts and authentication. No email, no birth date, no real name is collected.
CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL CHECK (username ~ '^[A-Za-z0-9_.-]{3,16}$'),
  username_key  text GENERATED ALWAYS AS (lower(username)) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  can_host      boolean NOT NULL DEFAULT false,   -- may open the shared continent (see world_sessions)
  UNIQUE (username_key)
);
-- Password hashes live in their own table so ordinary profile queries can never select them.
CREATE TABLE credentials (
  account_id      uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash   text NOT NULL,                  -- self-describing string: algorithm, parameters, salt, hash
  updated_at      timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz
);
-- Only a SHA-256 of the session token is stored; a database leak does not reveal usable tokens.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  device_label text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_account_idx ON sessions (account_id);
-- One-time recovery codes (hashed). Shown to the player once at registration.
CREATE TABLE recovery_codes (
  id         bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz
);
CREATE INDEX recovery_codes_account_idx ON recovery_codes (account_id) WHERE used_at IS NULL;
