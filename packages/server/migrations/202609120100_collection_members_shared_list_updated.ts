import { sql, type Kysely, type Migration } from 'kysely';

/**
 * P-10 expand-only: denormalize collections.updated_at onto collection_members
 * so the shared-list keyset can Index Scan instead of sorting every membership.
 *
 * Target plan is Index Scan on `collection_members_shared_list_updated_idx` +
 * nested loop to `collections`, with no Sort of the full membership set.
 * Kysely runs PostgreSQL migrations in one transaction: no CREATE INDEX CONCURRENTLY.
 *
 * N-1 binaries omit the column; DEFAULT plus the BEFORE INSERT trigger fill it.
 * Keep collection_members_shared_list_idx (expand-only; do not drop it).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE collection_members
      ADD COLUMN collection_updated_at timestamptz NOT NULL DEFAULT '-infinity'
  `.execute(db);
  await sql`
    UPDATE collection_members AS members
       SET collection_updated_at = collections.updated_at
      FROM collections
     WHERE collections.id = members.collection_id
  `.execute(db);
  await sql`
    CREATE FUNCTION collection_members_copy_collection_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $copy_collection_updated_at$
    BEGIN
      SELECT collections.updated_at
        INTO NEW.collection_updated_at
        FROM collections
       WHERE collections.id = NEW.collection_id;
      RETURN NEW;
    END
    $copy_collection_updated_at$
  `.execute(db);
  await sql`
    CREATE TRIGGER collection_members_copy_collection_updated_at
    BEFORE INSERT OR UPDATE OF collection_id
    ON collection_members
    FOR EACH ROW
    EXECUTE FUNCTION collection_members_copy_collection_updated_at()
  `.execute(db);
  await sql`
    CREATE FUNCTION collections_fanout_collection_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $fanout_collection_updated_at$
    BEGIN
      UPDATE collection_members
         SET collection_updated_at = NEW.updated_at
       WHERE collection_id = NEW.id;
      RETURN NEW;
    END
    $fanout_collection_updated_at$
  `.execute(db);
  await sql`
    CREATE TRIGGER collections_fanout_collection_updated_at
    AFTER UPDATE OF updated_at
    ON collections
    FOR EACH ROW
    EXECUTE FUNCTION collections_fanout_collection_updated_at()
  `.execute(db);
  await sql`
    CREATE INDEX collection_members_shared_list_updated_idx
      ON collection_members (
        subject_id,
        collection_updated_at DESC,
        (collection_id COLLATE "C") ASC
      )
      WHERE role IN ('editor', 'viewer')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collection_members_shared_list_updated_idx`.execute(db);
  await sql`DROP TRIGGER IF EXISTS collection_members_copy_collection_updated_at ON collection_members`.execute(db);
  await sql`DROP TRIGGER IF EXISTS collections_fanout_collection_updated_at ON collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS collection_members_copy_collection_updated_at()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS collections_fanout_collection_updated_at()`.execute(db);
  await sql`ALTER TABLE collection_members DROP COLUMN IF EXISTS collection_updated_at`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
