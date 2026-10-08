import { sql, type Kysely } from 'kysely';

/** Password persistence and every authoritative revocation fact share one commit. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE auth_password_security_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    auth_user_id text NOT NULL,
    account_id text NOT NULL,
    account_epoch bigint NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`.execute(db);
  await sql`CREATE FUNCTION commit_password_security_event() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE product_account_id text; next_epoch bigint; event_id bigint; event_time timestamptz;
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.password IS NOT DISTINCT FROM OLD.password THEN RETURN NEW; END IF;
    END IF;
    SELECT account_id INTO product_account_id FROM auth_user_account_map WHERE auth_user_id = NEW."userId";
    IF product_account_id IS NULL THEN RETURN NEW; END IF;
    UPDATE accounts SET security_epoch = security_epoch + 1 WHERE id = product_account_id RETURNING security_epoch INTO next_epoch;
    event_time := clock_timestamp();
    INSERT INTO auth_password_security_events(auth_user_id, account_id, account_epoch, completed_at)
      VALUES (NEW."userId", product_account_id, next_epoch, event_time) RETURNING id INTO event_id;
    DELETE FROM auth_sessions WHERE "userId" = NEW."userId";
    UPDATE sessions SET revoked_at = event_time WHERE account_id = product_account_id AND revoked_at IS NULL;
    DELETE FROM auth_verifications WHERE value = NEW."userId";
    UPDATE mcp_oauth_security_epoch SET epoch = 'known.password:' || event_id::text,
      effective_at = GREATEST(effective_at, event_time), updated_at = event_time WHERE id = 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'MCP security epoch is not provisioned'; END IF;
    RETURN NEW;
  END $$`.execute(db);
  await sql`CREATE TRIGGER auth_password_security_commit AFTER UPDATE OF password ON auth_accounts
    FOR EACH ROW EXECUTE FUNCTION commit_password_security_event()`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER auth_password_security_commit ON auth_accounts`.execute(db);
  await sql`DROP FUNCTION commit_password_security_event()`.execute(db);
  await sql`DROP TABLE auth_password_security_events`.execute(db);
}
