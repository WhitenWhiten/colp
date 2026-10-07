import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../src/infrastructure/database/runtime.js';

export async function up(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`CREATE INDEX annotations_live_subject_keyset_idx
    ON annotations (
      collection_id,
      subject_type,
      subject_id,
      updated_at DESC,
      (id COLLATE "C") ASC
    )
    WHERE deleted_at IS NULL`.execute(db);
}

export async function down(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`DROP INDEX IF EXISTS annotations_live_subject_keyset_idx`.execute(db);
}
