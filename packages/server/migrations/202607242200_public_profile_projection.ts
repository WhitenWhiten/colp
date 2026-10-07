import { sql, type Kysely } from 'kysely';

/**
 * Expand-only P2B-01 indexes and canonical handle constraint.
 * Apply before deploying the public Profile readers. Existing mixed-case handles
 * are collision-checked and then canonicalized to lowercase before the constraint.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX profile_handles_canonical_handle_unique
      ON profile_handles ((lower(handle) COLLATE "C"))
  `.execute(db);
  await sql`
    UPDATE profile_handles
       SET handle = lower(handle)
     WHERE handle <> lower(handle)
  `.execute(db);
  await sql`
    ALTER TABLE profile_handles
      ADD CONSTRAINT profile_handles_handle_canonical_format
      CHECK (handle ~ '^[a-z0-9._~-]{1,64}$' AND handle NOT IN ('.', '..'))
  `.execute(db);
  await sql`
    CREATE INDEX collections_public_profile_owner_order_idx
      ON collections (owner_subject_id, updated_at DESC, (id COLLATE "C") ASC)
      WHERE deleted_at IS NULL
        AND publication_slug IS NOT NULL
        AND published_at IS NOT NULL
        AND visibility = 'public'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_public_profile_owner_order_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS profile_handles_canonical_handle_unique`.execute(db);
  await sql`
    ALTER TABLE profile_handles
      DROP CONSTRAINT IF EXISTS profile_handles_handle_canonical_format
  `.execute(db);
}
