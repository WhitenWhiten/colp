import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema, DatabaseTransaction } from '../database/index.js';
import { IMAGE_ID_PATTERN, IMAGE_MAX_BYTES, type ImageObjectStore } from '../../modules/collections/index.js';

/** Transaction-bound writes let an upload's ledger, bytes and receipt commit together. */
export function createDatabaseImageStore(db: Kysely<DatabaseSchema> | DatabaseTransaction): ImageObjectStore {
  function validate(id: string): void {
    if (!IMAGE_ID_PATTERN.test(id)) throw new Error('Invalid image object id');
  }
  return {
    async put(id, body, contentType) {
      validate(id);
      if (body.byteLength < 1 || body.byteLength > IMAGE_MAX_BYTES) throw new Error('Image size is out of range');
      // A second write cannot change bytes at an existing URL.
      await sql`INSERT INTO image_asset_bytes (object_id, content_type, body)
        VALUES (${id}::uuid, ${contentType}, ${body})`.execute(db);
    },
    async get(id, options) {
      validate(id);
      options?.signal?.throwIfAborted();
      const result = await sql<{ content_type: string; body: Buffer }>`
        SELECT content_type, body FROM image_asset_bytes WHERE object_id = ${id}::uuid
      `.execute(db);
      options?.signal?.throwIfAborted();
      const row = result.rows[0];
      return row ? { contentType: row.content_type, body: row.body } : null;
    },
    async delete(id) {
      validate(id);
      await sql`DELETE FROM image_asset_bytes WHERE object_id = ${id}::uuid`.execute(db);
    },
  };
}
