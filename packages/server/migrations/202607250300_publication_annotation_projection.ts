import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../src/infrastructure/database/runtime.js';

/** Stable collection-wide Publication Annotation keyset order for P2B-08. */
export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`CREATE INDEX annotations_live_publication_keyset_idx
    ON annotations (
      collection_id,
      (subject_type COLLATE "C"),
      (subject_id COLLATE "C"),
      (id COLLATE "C")
    )
    WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX annotations_live_publication_cursor_locator_idx
    ON annotations (collection_id, publication_locator_sha256_128(id))
    WHERE deleted_at IS NULL`.execute(db);
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`DROP INDEX IF EXISTS annotations_live_publication_cursor_locator_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS annotations_live_publication_keyset_idx`.execute(db);
}
