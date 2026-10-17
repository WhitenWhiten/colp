import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { assertAvatarImage, type AvatarObjectStore } from '../../modules/identity/index.js';

const AVATAR_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

/**
 * Without an R2 bucket, avatar images live in the instance database and its
 * backups, like favicons. Objects are immutable: a new upload gets a new id.
 */
export function createDatabaseAvatarStore(db: Kysely<DatabaseSchema>): AvatarObjectStore {
  function validateId(id: string): void {
    if (!AVATAR_ID.test(id)) throw new Error('Invalid avatar object id');
  }
  return {
    async put(avatarId, body, contentType, _accountId, signal) {
      validateId(avatarId);
      assertAvatarImage(body, contentType);
      signal?.throwIfAborted();
      await sql`INSERT INTO avatar_object_bytes (object_id, content_type, body)
        VALUES (${avatarId}::uuid, ${contentType}, ${body})
        ON CONFLICT (object_id) DO NOTHING`.execute(db);
    },
    async get(avatarId, options) {
      validateId(avatarId);
      options?.signal?.throwIfAborted();
      const result = await sql<{ content_type: string; body: Buffer }>`
        SELECT content_type, body FROM avatar_object_bytes WHERE object_id = ${avatarId}::uuid
      `.execute(db);
      options?.signal?.throwIfAborted();
      const row = result.rows[0];
      return row ? { contentType: row.content_type, body: row.body } : null;
    },
    async delete(avatarId, signal) {
      validateId(avatarId);
      signal?.throwIfAborted();
      await sql`DELETE FROM avatar_object_bytes WHERE object_id = ${avatarId}::uuid`.execute(db);
    },
  };
}
