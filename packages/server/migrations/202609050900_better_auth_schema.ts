import { sql, type Kysely, type Migration } from 'kysely';

/**
 * B1 expand migration: Better Auth 1.6.29 schema, transcribed column-by-column
 * from the G0 `getMigrations().compileMigrations()` artifact
 * (`/tmp/known-better-auth-spike/artifacts/compile-migration.sql`) after static
 * review (docs/development/known-backend/better-auth/better-auth-schema-sql-review.md).
 *
 * - The four tables are owned by the Better Auth runtime. Column names are the
 *   library contract (quoted camelCase) and MUST NOT be renamed; types,
 *   defaults, nullability and indexes mirror the generated artifact exactly.
 * - `auth_users.email` and `auth_sessions.token` keep the library UNIQUE.
 * - `auth_verifications.identifier` stays index-only without uniqueness
 *   (library contract; the OTP plugin resolves the newest row by createdAt).
 * - G0 gap R5 fix: `auth_accounts` gains UNIQUE ("providerId", "accountId")
 *   plus a named composite index so explicit provider linking can never mint
 *   duplicate provider account rows.
 * - FK delete behavior follows the artifact: auth_sessions and auth_accounts
 *   cascade from auth_users.
 *
 * Expand-only: no statement touches legacy `accounts`, `sessions` or
 * `account_identities`; N-1 binaries ignore these tables.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE "auth_users" (
    "id" text PRIMARY KEY,
    "name" text NOT NULL,
    "email" text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL,
    "image" text,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);

  await sql`CREATE TABLE "auth_sessions" (
    "id" text PRIMARY KEY,
    "expiresAt" timestamptz NOT NULL,
    "token" text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamptz NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL REFERENCES "auth_users" ("id") ON DELETE CASCADE
  )`.execute(db);

  await sql`CREATE TABLE "auth_accounts" (
    "id" text PRIMARY KEY,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "auth_users" ("id") ON DELETE CASCADE,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz,
    "scope" text,
    "password" text,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamptz NOT NULL
  )`.execute(db);

  await sql`CREATE TABLE "auth_verifications" (
    "id" text PRIMARY KEY,
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);

  await sql`CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions" ("userId")`.execute(db);
  await sql`CREATE INDEX "auth_accounts_userId_idx" ON "auth_accounts" ("userId")`.execute(db);
  await sql`CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" ("identifier")`.execute(db);

  // G0 spike gap R5 (spike-record §4.2, ADR §3, contract tables.b1RequiredGap):
  // the generated schema has no provider-account uniqueness.
  await sql`ALTER TABLE "auth_accounts"
    ADD CONSTRAINT auth_accounts_provider_account_unique UNIQUE ("providerId", "accountId")`.execute(db);
  await sql`CREATE INDEX auth_accounts_provider_account_idx
    ON "auth_accounts" ("providerId", "accountId")`.execute(db);

  await sql`COMMENT ON TABLE "auth_users" IS
    'Better Auth 1.6.29 authentication user (library schema transcription).'`.execute(db);
  await sql`COMMENT ON TABLE "auth_accounts" IS
    'Better Auth 1.6.29 credential / provider account rows (library schema transcription plus G0 R5 provider-account uniqueness).'`.execute(db);
  await sql`COMMENT ON TABLE "auth_sessions" IS
    'Better Auth 1.6.29 browser session carrier (library schema transcription; product security facts live in known_auth_session_metadata).'`.execute(db);
  await sql`COMMENT ON TABLE "auth_verifications" IS
    'Better Auth 1.6.29 OTP / reset proof storage (library schema transcription; identifier is index-only by contract).'`.execute(db);
}

/**
 * Developer-only destructive rollback. Refuses while any of the four tables has
 * rows and reports per-table counts; production rollback keeps the expand
 * schema installed (forward recovery). Runs inside the migration transaction,
 * so a refused down leaves every table intact.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $guard$
    DECLARE
      users_count bigint;
      accounts_count bigint;
      sessions_count bigint;
      verifications_count bigint;
    BEGIN
      SELECT count(*) INTO users_count FROM "auth_users";
      SELECT count(*) INTO accounts_count FROM "auth_accounts";
      SELECT count(*) INTO sessions_count FROM "auth_sessions";
      SELECT count(*) INTO verifications_count FROM "auth_verifications";
      IF users_count + accounts_count + sessions_count + verifications_count > 0 THEN
        RAISE EXCEPTION 'better_auth_schema down refused: rows remain (auth_users=%, auth_accounts=%, auth_sessions=%, auth_verifications=%); production rollback keeps the expand schema installed and down is a developer-only zero-row boundary.',
          users_count, accounts_count, sessions_count, verifications_count;
      END IF;
    END
  $guard$`.execute(db);
  await sql`DROP TABLE IF EXISTS "auth_verifications"`.execute(db);
  await sql`DROP TABLE IF EXISTS "auth_accounts"`.execute(db);
  await sql`DROP TABLE IF EXISTS "auth_sessions"`.execute(db);
  await sql`DROP TABLE IF EXISTS "auth_users"`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
