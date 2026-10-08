import { sql, type Kysely } from 'kysely';

/**
 * Bound anonymous RFC 7591 registrations across API replicas.
 *
 * A row with client_id IS NULL is a short-lived admission reservation. A
 * finalized row names the OAuth client created under that reservation.
 * Reclaimable rows are removed only after their unused-retention deadline and
 * only while the client has no consent/access/refresh-token evidence.
 *
 * Pre-existing unowned clients cannot be distinguished perfectly from DCR
 * rows in Better Auth 1.7.1, so the migration backfills them conservatively as
 * non-reclaimable. They count toward the cap but are never auto-deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE "auth_oauth_dcr_registration" (
    "id" text PRIMARY KEY,
    "clientId" text UNIQUE REFERENCES "auth_oauth_client" ("clientId") ON DELETE CASCADE,
    "expiresAt" timestamptz NOT NULL,
    "reclaimable" boolean NOT NULL,
    "createdAt" timestamptz NOT NULL
  )`.execute(db);

  await sql`CREATE INDEX "auth_oauth_dcr_registration_expiresAt_idx"
    ON "auth_oauth_dcr_registration" ("expiresAt")`.execute(db);

  await sql`INSERT INTO "auth_oauth_dcr_registration"
      ("id", "clientId", "expiresAt", "reclaimable", "createdAt")
    SELECT 'legacy:' || c."id", c."clientId", 'infinity'::timestamptz, false,
           COALESCE(c."createdAt", now())
    FROM "auth_oauth_client" c
    WHERE c."clientDiscoveryId" IS NULL
      AND c."userId" IS NULL
      AND c."referenceId" IS NULL`.execute(db);

  await sql`COMMENT ON TABLE "auth_oauth_dcr_registration" IS
    'Know-N anonymous RFC 7591 capacity reservations and finalized registrations; bounds persistent DCR growth across replicas.'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $guard$
    DECLARE row_count bigint;
    BEGIN
      SELECT count(*) INTO row_count FROM "auth_oauth_dcr_registration";
      IF row_count > 0 THEN
        RAISE EXCEPTION 'oauth_dcr_registration_capacity down refused: auth_oauth_dcr_registration rows remain (%)', row_count;
      END IF;
    END
  $guard$`.execute(db);
  await sql`DROP TABLE IF EXISTS "auth_oauth_dcr_registration"`.execute(db);
}

export const migration = { up, down };
