-- History must not be editable by accident (or by a bug in game code).
--   world_events    : strictly append-only. No UPDATE, DELETE or TRUNCATE, no override. (Retention/archiving, if ever
--                     needed, will be a separate, deliberate migration.)
--   currency_ledger : no UPDATE or TRUNCATE. DELETE is allowed ONLY inside an account erasure, which must run
--                     SET LOCAL bb.allow_account_erase = 'on'  (a player must be able to delete their account).
-- Honest limit: a database superuser or the table owner can still drop these triggers on purpose; the application's
-- database role should therefore not be a superuser or the owner of these tables (planned for Stage 2/11).
CREATE FUNCTION bb_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER world_events_append_only BEFORE UPDATE OR DELETE ON world_events FOR EACH ROW EXECUTE FUNCTION bb_forbid_change();
CREATE TRIGGER world_events_no_truncate BEFORE TRUNCATE ON world_events FOR EACH STATEMENT EXECUTE FUNCTION bb_forbid_change();

CREATE FUNCTION bb_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('bb.allow_account_erase', true), 'off') = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER currency_ledger_append_only BEFORE UPDATE OR DELETE ON currency_ledger FOR EACH ROW EXECUTE FUNCTION bb_ledger_guard();
CREATE TRIGGER currency_ledger_no_truncate BEFORE TRUNCATE ON currency_ledger FOR EACH STATEMENT EXECUTE FUNCTION bb_forbid_change();
