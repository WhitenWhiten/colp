import { sql, type Kysely, type Migration } from 'kysely';

/**
 * C4 expand migration: Better Auth 1.6.29 two-factor (TOTP MFA) schema
 * (plan §9 Task C4 "data migration", additive to the B1 expand chain).
 *
 * Transcribed from the twoFactor plugin schema
 * (node_modules/better-auth/dist/plugins/two-factor/schema.mjs):
 * - `auth_two_factor` rows carry the TOTP secret and the backup-code blob
 *   ENCRYPTED at rest with the BA secret (library contract: symmetricEncrypt
 *   with the BA secret; the C4 runtime wires `storeBackupCodes: 'encrypted'`),
 *   so no plaintext secret or recovery code ever reaches the database;
 * - `verified` flips to true on the FIRST successful TOTP verification and
 *   `auth_users."twoFactorEnabled"` follows the same flip (the plugin keeps
 *   both false until enrollment is proven);
 * - `failedVerificationCount` / `lockedUntil` back the plugin's account
 *   lockout (runtime defaults: 10 consecutive failures / 15 minutes);
 * - the plugin's only lookup path is by `userId` (every two-factor query in
 *   the plugin source filters on userId), so the transcribed shape carries
 *   the `auth_two_factor_userId_idx` index; the `secret` field is marked
 *   `index: true` in the plugin schema but is never a query key at runtime,
 *   so it stays index-free in the migration (matching the C4 reference
 *   shape reviewed with the integration suite);
 * - `auth_users."twoFactorEnabled"` is the plugin's user-field column that
 *   every auth_users query selects once the plugin is wired. ADD-only with
 *   `NOT NULL DEFAULT false`: existing users stay MFA-off (additive
 *   contract — no legacy or B1 table is dropped or altered beyond this one
 *   ADD COLUMN).
 *
 * Expand-only: N-1 binaries ignore these objects; no statement touches
 * legacy `accounts` / `sessions` / `account_identities`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE "auth_two_factor" (
    "id" text PRIMARY KEY,
    "secret" text NOT NULL,
    "backupCodes" text NOT NULL,
    "userId" text NOT NULL REFERENCES "auth_users" ("id") ON DELETE CASCADE,
    "verified" boolean NOT NULL DEFAULT true,
    "failedVerificationCount" integer NOT NULL DEFAULT 0,
    "lockedUntil" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);

  await sql`CREATE INDEX "auth_two_factor_userId_idx" ON "auth_two_factor" ("userId")`.execute(db);

  await sql`ALTER TABLE "auth_users"
    ADD COLUMN "twoFactorEnabled" boolean NOT NULL DEFAULT false`.execute(db);

  await sql`COMMENT ON TABLE "auth_two_factor" IS
    'Better Auth 1.6.29 two-factor (TOTP + backup codes) rows; secret and backup-code blob encrypted at rest with the BA secret (library contract, C4).'`.execute(db);
}

/**
 * Developer-only destructive rollback. Refuses while any MFA data remains
 * (auth_two_factor rows OR any user with twoFactorEnabled=true) and reports
 * both counts; production rollback keeps the expand schema installed
 * (forward recovery). Runs inside the migration transaction, so a refused
 * down leaves the table and column intact.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $guard$
    DECLARE
      two_factor_count bigint;
      enabled_user_count bigint;
    BEGIN
      SELECT count(*) INTO two_factor_count FROM "auth_two_factor";
      SELECT count(*) INTO enabled_user_count FROM "auth_users" WHERE "twoFactorEnabled" = true;
      IF two_factor_count + enabled_user_count > 0 THEN
        RAISE EXCEPTION 'better_auth_mfa_schema down refused: rows remain (auth_two_factor=%, twoFactorEnabled users=%); production rollback keeps the MFA expand schema installed and down is a developer-only zero-row boundary.',
          two_factor_count, enabled_user_count;
      END IF;
    END
  $guard$`.execute(db);
  await sql`ALTER TABLE "auth_users" DROP COLUMN IF EXISTS "twoFactorEnabled"`.execute(db);
  await sql`DROP TABLE IF EXISTS "auth_two_factor"`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
