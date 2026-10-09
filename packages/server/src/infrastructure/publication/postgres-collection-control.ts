import type { DatabaseRuntime } from '../database/runtime.js';
import {
  accountRestrictPublicationExistsSql,
  collectionHidePublicExistsSql,
} from '../database/collection-control-sql.js';

/** Production metadata and snapshots share the authoritative collection moderation gate. */
export function createPostgresPublicationCollectionControlPort(database: Pick<DatabaseRuntime, 'pool'>) {
  return Object.freeze({
    async collectionControl(collectionId: string): Promise<{
      readonly hidePublic: boolean;
      readonly restrictPublication: boolean;
    }> {
      const result = await database.pool.query<{
        hide_public: boolean;
        restrict_publication: boolean;
      }>(
        `select ${collectionHidePublicExistsSql('c.id')} as hide_public,
                exists (
                  select 1 from accounts owner_account
                   where owner_account.subject_id = c.owner_subject_id
                     and ${accountRestrictPublicationExistsSql('owner_account.id')}
                ) as restrict_publication
           from collections c where c.id = $1`,
        [collectionId],
      );
      return Object.freeze({
        hidePublic: result.rows[0]?.hide_public === true,
        restrictPublication: result.rows[0]?.restrict_publication === true,
      });
    },
  });
}
