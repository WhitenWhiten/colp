import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { assertBookmarkFaviconImage, type BookmarkFaviconObjectStore } from '../../modules/collections/index.js';

/** Immutable small objects share the instance's database durability and backups. */
export function createDatabaseFaviconStore(db: Kysely<DatabaseSchema>): BookmarkFaviconObjectStore {
  function validateId(id: string): void {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id)) {
      throw new Error('Invalid favicon object id');
    }
  }
  return {
    writeTransaction: db.isTransaction ? 'bound' : 'required',
    async put(objectId, body) {
      validateId(objectId);
      const contentType = assertBookmarkFaviconImage(body);
      const inserted = await sql<{ object_id: string }>`INSERT INTO favicon_object_bytes (object_id, content_type, body)
        VALUES (${objectId}::uuid, ${contentType}, ${body})
        ON CONFLICT (object_id) DO NOTHING
        RETURNING object_id`.execute(db);
      // A silent conflict would let a worker bind the losing body's digest
      // while the object still contains the winning writer's bytes.
      if (inserted.rows.length === 0) throw new Error('favicon_object_already_exists');
    },
    async get(objectId, options) {
      validateId(objectId);
      options?.signal?.throwIfAborted();
      const result = await sql<{ content_type: string; body: Buffer }>`
        SELECT content_type, body FROM favicon_object_bytes WHERE object_id = ${objectId}::uuid
      `.execute(db);
      options?.signal?.throwIfAborted();
      const row = result.rows[0];
      return row ? { contentType: row.content_type, body: row.body } : null;
    },
    async delete(objectId) {
      validateId(objectId);
      await sql`DELETE FROM favicon_object_bytes WHERE object_id = ${objectId}::uuid`.execute(db);
    },
  };
}
