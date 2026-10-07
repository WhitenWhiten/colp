import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand the Better Auth session carrier for transparent token protection.
 * Existing plaintext rows remain nullable and are admitted only through the
 * application's explicitly bounded compatibility window. New code writes an
 * authenticated ciphertext to `token` and this keyed equality lookup value.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE auth_sessions
    ADD COLUMN "tokenLookupHash" text,
    ADD CONSTRAINT auth_sessions_token_lookup_hash_format
      CHECK ("tokenLookupHash" IS NULL OR "tokenLookupHash" ~
        '^knsh1[.][1-9][0-9]{0,9}[.][A-Za-z0-9_-]{43}$')`.execute(db);
  await sql`COMMENT ON COLUMN auth_sessions."tokenLookupHash" IS
    'Purpose-separated HMAC lookup for encrypted Better Auth session tokens; null only on pre-protection rows.'`.execute(db);
  await sql`COMMENT ON COLUMN auth_sessions.token IS
    'Versioned authenticated ciphertext for the Better Auth session token; legacy plaintext is accepted only during an explicit bounded rollout window.'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE auth_sessions
    DROP CONSTRAINT IF EXISTS auth_sessions_token_lookup_hash_format,
    DROP COLUMN IF EXISTS "tokenLookupHash"`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
