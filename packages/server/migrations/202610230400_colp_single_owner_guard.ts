import { sql, type Kysely } from 'kysely';

/**
 * D27: the sign-up hook counts users before Better Auth inserts one, which
 * two concurrent first sign-ups can both pass. This trigger serializes user
 * inserts on an advisory lock and refuses a second user while the server
 * runs single-owner. The self-hosted entry and CLI write
 * `colp_instance_settings`; without that row (test suites, Know-N) the
 * trigger does nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE colp_instance_settings (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      single_owner boolean NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp
    )
  `.execute(db);
  await sql`
    CREATE FUNCTION colp_single_owner_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF COALESCE((SELECT single_owner FROM colp_instance_settings WHERE singleton), false) THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('colp.single_owner', 0));
        IF EXISTS (SELECT 1 FROM auth_users) THEN
          RAISE EXCEPTION 'registration_closed: this server already has its owner account'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER auth_users_single_owner_guard
      BEFORE INSERT ON auth_users
      FOR EACH ROW EXECUTE FUNCTION colp_single_owner_guard()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS auth_users_single_owner_guard ON auth_users`.execute(db);
  await sql`DROP FUNCTION IF EXISTS colp_single_owner_guard()`.execute(db);
  await sql`DROP TABLE IF EXISTS colp_instance_settings`.execute(db);
}
