import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE link_preview_collection_sweeps
    ADD COLUMN cursor_url text, ADD COLUMN cursor_revision text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE link_preview_collection_sweeps
    DROP COLUMN cursor_url, DROP COLUMN cursor_revision`.execute(db);
}
