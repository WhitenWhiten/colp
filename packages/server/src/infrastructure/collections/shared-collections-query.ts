import { sql, type Kysely } from 'kysely';
import type {
  SharedCollectionFact,
  SharedCollectionsReadInput,
  SharedCollectionsReadPort,
} from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

const sharedCollectionIdKey = sql<string>`collection_members.collection_id COLLATE "C"`;

/**
 * Live editor/viewer membership projection.
 * P-10: list order is collection recency via denormalized `collection_updated_at`.
 * Cursor payload still uses collections.updated_at (ISO) + id; the denormalized
 * column must stay equal to collections.updated_at.
 */
export function createPostgresSharedCollectionsReadPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): SharedCollectionsReadPort {
  return {
    async listSharedCollections(input: SharedCollectionsReadInput) {
      let query = transaction
        .selectFrom('collection_members')
        .innerJoin('collections', 'collections.id', 'collection_members.collection_id')
        .select([
          'collections.id',
          'collections.kind',
          'collections.title',
          'collections.summary',
          'collections.visibility',
          'collections.publication_slug',
          'collections.allow_search_indexing',
          'collections.published_at',
          'collections.root_node_id',
          'collections.resource_revision',
          'collections.content_revision',
          'collections.policy_revision',
          'collections.created_at',
          'collections.updated_at',
          'collections.owner_subject_id',
          'collection_members.role',
        ])
        .where('collection_members.subject_id', '=', input.memberSubjectId)
        .where('collection_members.role', 'in', ['editor', 'viewer'])
        .where('collections.owner_subject_id', '<>', input.memberSubjectId)
        .where('collections.deleted_at', 'is', null);
      if (input.kind) query = query.where('collections.kind', '=', input.kind);
      if (input.visibility) query = query.where('collections.visibility', '=', input.visibility);
      if (input.after) {
        query = query.where('collection_members.collection_updated_at', '<=', input.after.updatedAt).where(sql<boolean>`(
          collection_members.collection_updated_at < ${input.after.updatedAt}
          OR (collection_members.collection_updated_at = ${input.after.updatedAt} AND ${sharedCollectionIdKey} > ${input.after.id}::text COLLATE "C")
        )`);
      }
      const rows = await query.orderBy('collection_members.collection_updated_at', 'desc').orderBy(sharedCollectionIdKey, 'asc')
        .limit(input.limit + 1).execute();
      return rows.map((row): SharedCollectionFact => ({
        id: row.id, kind: row.kind, title: row.title, summary: row.summary, visibility: row.visibility,
        publicationSlug: row.publication_slug, allowSearchIndexing: row.allow_search_indexing,
        publishedAt: row.published_at,
        rootNodeId: row.root_node_id, resourceRevision: row.resource_revision,
        contentRevision: row.content_revision, policyRevision: row.policy_revision,
        createdAt: row.created_at, updatedAt: row.updated_at,
        ownerSubjectId: row.owner_subject_id,
        membershipRole: row.role as SharedCollectionFact['membershipRole'],
      }));
    },
  };
}
