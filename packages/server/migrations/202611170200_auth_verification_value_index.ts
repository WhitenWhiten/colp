import { sql, type Kysely } from 'kysely';

/**
 * A5-2: `auth_verifications` is also queried and deleted by `value`.
 *
 * Better Auth stores trust-device rows with `identifier = sha256(...)` and
 * `value = auth user id`, so revoking that state deletes
 * `WHERE value = ...` / `WHERE value IN (...)` (password security triggers and
 * the browser-session authority). Only `identifier` was indexed, which made
 * every such statement a sequential scan of the verification table.
 *
 * Additive and idempotent: the index is created only when absent and `down`
 * removes exactly this migration's index. `value` (not `identifier`) leads the
 * index, matching the equality/IN predicates; no uniqueness is implied because
 * multiple verification rows may legitimately share one user-id value.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS auth_verifications_value_idx
    ON auth_verifications ("value")`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS auth_verifications_value_idx`.execute(db);
}
