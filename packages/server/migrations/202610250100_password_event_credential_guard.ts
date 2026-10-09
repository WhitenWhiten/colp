import { sql, type Kysely } from 'kysely';

/** Provider links and empty credentials are not password changes. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION commit_password_security_event() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE product_account_id text; next_epoch bigint; event_time timestamptz;
  BEGIN
    IF NEW."providerId" <> 'credential' THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' AND NEW.password IS NULL THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.password IS NOT DISTINCT FROM OLD.password THEN RETURN NEW; END IF;
    END IF;
    SELECT account_id INTO product_account_id FROM auth_user_account_map WHERE auth_user_id = NEW."userId";
    IF product_account_id IS NULL THEN RETURN NEW; END IF;
    UPDATE accounts SET security_epoch = security_epoch + 1 WHERE id = product_account_id RETURNING security_epoch INTO next_epoch;
    event_time := clock_timestamp();
    INSERT INTO auth_password_security_events(auth_user_id, account_id, account_epoch, completed_at)
      VALUES (NEW."userId", product_account_id, next_epoch, event_time);
    DELETE FROM auth_sessions WHERE "userId" = NEW."userId";
    UPDATE sessions SET revoked_at = event_time WHERE account_id = product_account_id AND revoked_at IS NULL;
    DELETE FROM auth_verifications WHERE value = NEW."userId";
    RETURN NEW;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION commit_password_security_event() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE product_account_id text; next_epoch bigint; event_time timestamptz;
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.password IS NOT DISTINCT FROM OLD.password THEN RETURN NEW; END IF;
    END IF;
    SELECT account_id INTO product_account_id FROM auth_user_account_map WHERE auth_user_id = NEW."userId";
    IF product_account_id IS NULL THEN RETURN NEW; END IF;
    UPDATE accounts SET security_epoch = security_epoch + 1 WHERE id = product_account_id RETURNING security_epoch INTO next_epoch;
    event_time := clock_timestamp();
    INSERT INTO auth_password_security_events(auth_user_id, account_id, account_epoch, completed_at)
      VALUES (NEW."userId", product_account_id, next_epoch, event_time);
    DELETE FROM auth_sessions WHERE "userId" = NEW."userId";
    UPDATE sessions SET revoked_at = event_time WHERE account_id = product_account_id AND revoked_at IS NULL;
    DELETE FROM auth_verifications WHERE value = NEW."userId";
    RETURN NEW;
  END $$`.execute(db);
}
