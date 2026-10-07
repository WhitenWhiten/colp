import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Never-bound compact JWS compares signed iat to security_epoch_bumped_at.
 * bumpSecurityEpoch stamps the column, but production password change/reset
 * increments accounts.security_epoch inside commit_password_security_event()
 * and would leave the stamp NULL (or stale). Stamp on every security_epoch
 * UPDATE so those events close the same never-bound window.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION stamp_account_security_epoch_bumped_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.security_epoch IS DISTINCT FROM OLD.security_epoch THEN
        NEW.security_epoch_bumped_at := clock_timestamp();
      END IF;
      RETURN NEW;
    END
    $$`.execute(db);
  await sql`
    CREATE TRIGGER accounts_security_epoch_bumped_at
      BEFORE UPDATE OF security_epoch ON accounts
      FOR EACH ROW
      EXECUTE FUNCTION stamp_account_security_epoch_bumped_at()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS accounts_security_epoch_bumped_at ON accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS stamp_account_security_epoch_bumped_at()`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
