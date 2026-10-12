import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { LINK_PREVIEW_MAX_IMAGE_BYTES, type LinkPreviewObjectStore } from '../../modules/collections/index.js';

const OBJECT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function validate(objectId: string): void {
  if (!OBJECT_ID.test(objectId)) throw new Error('Invalid link preview object id');
}

/** Preview copies share the instance's database durability and backups. */
export function createDatabaseLinkPreviewStore(db: Kysely<DatabaseSchema>): LinkPreviewObjectStore {
  return {
    async put(objectId, body, contentType) {
      validate(objectId);
      if (body.byteLength < 1 || body.byteLength > LINK_PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error('Link preview object size is out of range');
      }
      await sql`INSERT INTO link_preview_object_bytes (object_id, content_type, body)
        VALUES (${objectId}::uuid, ${contentType}, ${body})
        ON CONFLICT (object_id) DO NOTHING`.execute(db);
    },
    async get(objectId, options) {
      validate(objectId);
      options?.signal?.throwIfAborted();
      const result = await sql<{ content_type: string; body: Buffer }>`
        SELECT content_type, body FROM link_preview_object_bytes WHERE object_id = ${objectId}::uuid
      `.execute(db);
      options?.signal?.throwIfAborted();
      const row = result.rows[0];
      return row ? { contentType: row.content_type, body: row.body } : null;
    },
    async delete(objectId) {
      validate(objectId);
      await sql`DELETE FROM link_preview_object_bytes WHERE object_id = ${objectId}::uuid`.execute(db);
    },
  };
}
