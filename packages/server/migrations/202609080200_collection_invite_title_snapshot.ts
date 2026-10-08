import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only Collection Collaboration title snapshot (SC-02).
 *
 * §6.5 freezes `collectionTitle` at invite creation. SC-01's table had no
 * snapshot column. N-1 insert shapes omit the column; DEFAULT '' keeps them
 * valid. Application rollback leaves the column installed. `down` is
 * developer-only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE collection_invites
      ADD COLUMN collection_title_snapshot text NOT NULL DEFAULT ''
  `.execute(db);
  await sql`
    UPDATE collection_invites AS invite
       SET collection_title_snapshot = collections.title
      FROM collections
     WHERE collections.id = invite.collection_id
       AND invite.collection_title_snapshot = ''
  `.execute(db);
  await sql`
    ALTER TABLE collection_invites
      ADD CONSTRAINT collection_invites_title_snapshot_len_ck
      CHECK (
        char_length(collection_title_snapshot) BETWEEN 0 AND 4096
        AND octet_length(collection_title_snapshot) <= 8192
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE collection_invites
      DROP CONSTRAINT IF EXISTS collection_invites_title_snapshot_len_ck
  `.execute(db);
  await sql`
    ALTER TABLE collection_invites
      DROP COLUMN IF EXISTS collection_title_snapshot
  `.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
