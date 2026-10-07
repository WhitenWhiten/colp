import { sql, type Kysely } from 'kysely';
import type {
  ExploreCreatorFacts,
  ExploreCreatorsQueryPort,
} from '../../modules/identity/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { accountRestrictPublicationExistsSql } from '../database/collection-control-sql.js';

interface ExploreCreatorRow {
  subject_id: string;
  account_id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  publication_restricted: boolean;
}

/**
 * Batch-resolve Explore curator facts by owner subject_id.
 * Accounts without a profile are omitted unless restrict_publication applies.
 * Restricted rows carry no account id, handle, or avatar (transport Unknown sentinel).
 */
export function createPostgresExploreCreatorsQueryPort(
  db: Kysely<DatabaseSchema>,
): ExploreCreatorsQueryPort {
  return Object.freeze({
    async findByOwnerSubjectIds(ownerSubjectIds: readonly string[]) {
      const bySubject = new Map<string, ExploreCreatorFacts>();
      if (ownerSubjectIds.length === 0) return bySubject;
      const rows = await sql<ExploreCreatorRow>`
        SELECT a.subject_id,
               CASE WHEN blocked.yes THEN '' ELSE a.id END AS account_id,
               CASE WHEN blocked.yes THEN '' ELSE p.display_name END AS display_name,
               CASE WHEN blocked.yes THEN NULL ELSE h.handle END AS handle,
               CASE WHEN blocked.yes THEN NULL ELSE p.avatar_url END AS avatar_url,
               blocked.yes AS publication_restricted
          FROM accounts a
          LEFT JOIN profiles p ON p.account_id = a.id
          LEFT JOIN profile_handles h ON h.account_id = a.id
          CROSS JOIN LATERAL (
            SELECT ${sql.raw(accountRestrictPublicationExistsSql('a.id'))} AS yes
          ) blocked
         WHERE a.subject_id = ANY(${ownerSubjectIds})
           AND (p.account_id IS NOT NULL OR blocked.yes)
      `.execute(db);
      for (const row of rows.rows) {
        const restricted = row.publication_restricted === true;
        bySubject.set(row.subject_id, {
          ownerSubjectId: row.subject_id,
          accountId: restricted ? '' : row.account_id,
          displayName: restricted ? '' : row.display_name,
          handle: restricted ? null : row.handle,
          avatarUrl: restricted ? null : row.avatar_url,
          ...(restricted ? { publicationRestricted: true } : {}),
        });
      }
      return bySubject;
    },
  });
}
