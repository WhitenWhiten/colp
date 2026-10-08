import { sql, type Kysely, type Migration } from 'kysely';

/**
 * B1 expand migration: bidirectional 1:1 mapping between one Better Auth user
 * and one Know-N business account (G1 ADR §15, contract mappingConstraints).
 *
 * - `auth_user_id` is the primary key: one BA user maps to at most one account.
 * - `account_id` has its own UNIQUE: one business account maps to at most one
 *   BA user. Together the two constraints are the bidirectional 1:1 claim; the
 *   application mapping transaction (A2) writes both sides atomically.
 * - Deleting the BA user cascades the mapping (no orphan mapping rows); the
 *   business account side is RESTRICT — a mapped account cannot be hard-deleted
 *   behind the mapping's back (fail closed).
 *
 * Expand-only: N-1 binaries ignore the table; no legacy table is touched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE auth_user_account_map (
    auth_user_id text PRIMARY KEY,
    account_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_user_account_map_auth_user_fk
      FOREIGN KEY (auth_user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
    CONSTRAINT auth_user_account_map_account_fk
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT auth_user_account_map_account_id_unique UNIQUE (account_id)
  )`.execute(db);
  await sql`COMMENT ON TABLE auth_user_account_map IS
    'Bidirectional 1:1 mapping: one Better Auth user to exactly one Know-N business account (G1 ADR §15).'`.execute(db);
}

/**
 * Developer-only destructive rollback. Refuses while any mapping row remains
 * and reports the count; production rollback keeps the expand schema installed.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $guard$
    DECLARE mapping_count bigint;
    BEGIN
      SELECT count(*) INTO mapping_count FROM auth_user_account_map;
      IF mapping_count > 0 THEN
        RAISE EXCEPTION 'better_auth_account_mapping down refused: rows remain (auth_user_account_map=%); production rollback keeps the expand schema installed and down is a developer-only zero-row boundary.', mapping_count;
      END IF;
    END
  $guard$`.execute(db);
  await sql`DROP TABLE IF EXISTS auth_user_account_map`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
