import { sql, type Kysely } from 'kysely';
import type {
  OwnedCollectionFact,
  OwnedCollectionsReadInput,
  OwnedCollectionsReadPort,
} from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

const ownedCollectionIdKey = sql<string>`id COLLATE "C"`;

/** Production live owner projection ordered by (updated_at DESC, id C ASC). */
export function createPostgresOwnedCollectionsReadPort(transaction: DatabaseTransaction | Kysely<DatabaseSchema>): OwnedCollectionsReadPort {
  return {
    async listOwnedCollections(input: OwnedCollectionsReadInput) {
      let query = transaction.selectFrom('collections').select([
        'id', 'kind', 'title', 'summary', 'visibility', 'publication_slug', 'allow_search_indexing',
        'published_at', 'root_node_id', 'resource_revision',
        'content_revision', 'policy_revision', 'created_at', 'updated_at',
      ]).where('owner_subject_id', '=', input.ownerSubjectId).where('deleted_at', 'is', null);
      if (input.kind) query = query.where('kind', '=', input.kind);
      if (input.visibility) query = query.where('visibility', '=', input.visibility);
      if (input.after) {
        query = query.where('updated_at', '<=', input.after.updatedAt).where(sql<boolean>`(
          updated_at < ${input.after.updatedAt}
          OR (updated_at = ${input.after.updatedAt} AND ${ownedCollectionIdKey} > ${input.after.id}::text COLLATE "C")
        )`);
      }
      const rows = await query.orderBy('updated_at', 'desc').orderBy(ownedCollectionIdKey, 'asc')
        .limit(input.limit + 1).execute();
      return rows.map((row): OwnedCollectionFact => ({
        id: row.id, kind: row.kind, title: row.title, summary: row.summary, visibility: row.visibility,
        publicationSlug: row.publication_slug, allowSearchIndexing: row.allow_search_indexing,
        publishedAt: row.published_at,
        rootNodeId: row.root_node_id, resourceRevision: row.resource_revision,
        contentRevision: row.content_revision, policyRevision: row.policy_revision,
        createdAt: row.created_at, updatedAt: row.updated_at,
      }));
    },
  };
}
