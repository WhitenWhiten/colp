import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Session-owned RFC 7591 admission occupancy.
 *
 * Anonymous DCR already inserts a pending `auth_oauth_dcr_registration` row
 * under the advisory lock so concurrent reserves observe `count(*)`.
 * Session-owned DCR needs the same durable hold without consuming anonymous
 * capacity: nullable `ownerUserId` marks in-flight owned reservations.
 * Anonymous ledger rows keep `ownerUserId IS NULL`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE "auth_oauth_dcr_registration"
    ADD COLUMN "ownerUserId" text`.execute(db);

  await sql`CREATE INDEX "auth_oauth_dcr_registration_ownerUserId_pending_idx"
    ON "auth_oauth_dcr_registration" ("ownerUserId")
    WHERE "ownerUserId" IS NOT NULL AND "clientId" IS NULL`.execute(db);

  await sql`COMMENT ON COLUMN "auth_oauth_dcr_registration"."ownerUserId" IS
    'Session user id for in-flight owned DCR reservations; NULL for anonymous ledger rows.'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $guard$
    DECLARE row_count bigint;
    BEGIN
      SELECT count(*) INTO row_count
        FROM "auth_oauth_dcr_registration"
        WHERE "ownerUserId" IS NOT NULL;
      IF row_count > 0 THEN
        RAISE EXCEPTION 'oauth_dcr_owned_reservation_owner down refused: owned occupancy rows remain (%)', row_count;
      END IF;
    END
  $guard$`.execute(db);
  await sql`DROP INDEX IF EXISTS "auth_oauth_dcr_registration_ownerUserId_pending_idx"`.execute(db);
  await sql`ALTER TABLE "auth_oauth_dcr_registration" DROP COLUMN IF EXISTS "ownerUserId"`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
