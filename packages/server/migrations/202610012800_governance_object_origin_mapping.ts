import { sql, type Kysely, type Migration } from 'kysely';

/**
 * CG-06 review: historical avatar/favicon origin objects must stay traceable
 * to the account / Collection that used them so official controls (account
 * restrict_publication, Collection/bookmark hide_public) keep blocking old
 * object URLs after the live URL is replaced or cleared. These tables are the
 * durable attribution mapping: a row is written when an object first becomes
 * a current avatar/icon and is kept after replacement, because object-store
 * cleanup is best-effort and governance must never depend on it. Existing
 * current references are backfilled here at deploy time; the expand side is
 * additive so older readers keep starting.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS avatar_objects (
      object_id  uuid PRIMARY KEY,
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS avatar_objects_account_idx
      ON avatar_objects (account_id)
  `.execute(db);
  await sql`
    INSERT INTO avatar_objects (object_id, account_id)
    SELECT (regexp_match(
             p.avatar_url,
             '/api/v1/avatar/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
             'i'
           ))[1]::uuid,
           p.account_id
      FROM profiles p
     WHERE p.avatar_url IS NOT NULL
       AND p.avatar_url ~* '/api/v1/avatar/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    ON CONFLICT (object_id) DO NOTHING
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS bookmark_icon_objects (
      object_id     uuid PRIMARY KEY,
      collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      node_id       text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS bookmark_icon_objects_collection_idx
      ON bookmark_icon_objects (collection_id)
  `.execute(db);
  await sql`
    INSERT INTO bookmark_icon_objects (object_id, collection_id, node_id)
    SELECT object_id, collection_id, node_id
      FROM bookmark_icons
    ON CONFLICT (object_id) DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS bookmark_icon_objects`.execute(db);
  await sql`DROP TABLE IF EXISTS avatar_objects`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;