import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX collections_publication_directory_order_idx
      ON collections (updated_at DESC, (id COLLATE "C") ASC)
      WHERE deleted_at IS NULL AND publication_slug IS NOT NULL AND published_at IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX collections_publication_directory_locator_idx
      ON collections (publication_locator_sha256_128(id))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_publication_directory_locator_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_publication_directory_order_idx`.execute(db);
}
