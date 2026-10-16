import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collections ADD COLUMN is_library boolean NOT NULL DEFAULT false`.execute(db);
  await sql`CREATE UNIQUE INDEX collections_one_live_library_per_owner
    ON collections(owner_subject_id) WHERE is_library AND deleted_at IS NULL`.execute(db);
  await sql`ALTER TABLE collections ADD CONSTRAINT collections_library_private_bookmarks
    CHECK (NOT is_library OR (kind = 'bookmarks' AND visibility = 'private'))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX collections_one_live_library_per_owner`.execute(db);
  await sql`ALTER TABLE collections DROP CONSTRAINT collections_library_private_bookmarks,
    DROP COLUMN is_library`.execute(db);
}
