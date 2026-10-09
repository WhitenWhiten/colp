import type { DatabaseRuntime } from '../database/runtime.js';
import { collectionHidePublicExistsSql } from '../database/collection-control-sql.js';

/** Production metadata and snapshots share the authoritative collection moderation gate. */
export function createPostgresPublicationCollectionControlPort(database: Pick<DatabaseRuntime, 'pool'>) {
  return Object.freeze({
    async collectionControl(collectionId: string): Promise<{ readonly hidePublic: boolean }> {
      const result = await database.pool.query<{ hide_public: boolean }>(
        `select ${collectionHidePublicExistsSql('c.id')} as hide_public from collections c where c.id = $1`,
        [collectionId],
      );
      return Object.freeze({ hidePublic: result.rows[0]?.hide_public === true });
    },
  });
}
