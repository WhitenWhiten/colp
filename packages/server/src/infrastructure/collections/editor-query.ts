import { sql } from 'kysely';
import type {
  CollectionEditorSnapshot,
  CollectionEditorSnapshotPort,
  EditorCollectionRow,
  EditorLiveNodeRow,
  EditorRootNodeRow,
  LoadCollectionEditorSnapshotInput,
} from '../../modules/collections/index.js';
import { isBookmarkPinned } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { Metrics } from '../telemetry/index.js';
import {
  dualReadCollectionPayload,
  dualReadNodePayload,
} from './resource-payload-dual-read.js';

export const editorParentKey = sql<string>`COALESCE(parent_id, ''::text) COLLATE "C"`;
export const editorPositionKey = sql<string>`COALESCE(position_token, ''::text) COLLATE "C"`;
export const editorNodeIdKey = sql<string>`id COLLATE "C"`;

/**
 * Product Editor snapshot loader (P1-06).
 * Live non-root nodes only; ordered by comparator tuple with C collation.
 * Fetches limit+1 rows so the application can set hasMore without a second query.
 */
export function createPostgresCollectionEditorSnapshotPort(
  transaction: DatabaseTransaction,
  metrics?: Metrics,
): CollectionEditorSnapshotPort {
  return {
    async loadCollectionEditorSnapshot(input) {
      const collection = await loadCollection(transaction, input.collectionId, metrics);
      if (!collection) return null;

      const root = await loadRoot(
        transaction,
        input.collectionId,
        collection.rootNodeId,
        metrics,
      );
      if (!root) {
        throw new Error(
          `collection ${input.collectionId} is missing root node ${collection.rootNodeId}`,
        );
      }

      const nodes = await loadLiveNodesPage(transaction, input, metrics);
      return { collection, root, nodes } satisfies CollectionEditorSnapshot;
    },
  };
}

async function loadCollection(
  transaction: DatabaseTransaction,
  collectionId: string,
  metrics?: Metrics,
): Promise<EditorCollectionRow | null> {
  const row = await transaction
    .selectFrom('collections')
    .select([
      'id',
      'owner_subject_id',
      'kind',
      'title',
      'summary',
      'visibility',
      'allow_search_indexing',
      'publication_slug',
      'published_at',
      'root_node_id',
      'resource_revision',
      'content_revision',
      'policy_revision',
      'commit_ordinal',
      'created_at',
      'updated_at',
      'deleted_at',
      'payload_json',
    ])
    .where('id', '=', collectionId)
    .executeTakeFirst();

  if (!row) return null;
  dualReadCollectionPayload(row, metrics);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    visibility: row.visibility,
    allowSearchIndexing: row.allow_search_indexing,
    publicationSlug: row.publication_slug,
    publishedAt: row.published_at,
    rootNodeId: row.root_node_id,
    resourceRevision: row.resource_revision,
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

async function loadRoot(
  transaction: DatabaseTransaction,
  collectionId: string,
  rootNodeId: string,
  metrics?: Metrics,
): Promise<EditorRootNodeRow | null> {
  const row = await transaction
    .selectFrom('nodes')
    .select([
      'id',
      'collection_id',
      'parent_id',
      'kind',
      'is_root',
      'title',
      'url',
      'description',
      'tags',
      'visibility',
      'position_token',
      'resource_revision',
      'children_revision',
      'created_at',
      'updated_at',
      'deleted_at',
      'deleted_commit_ordinal',
      'payload_json',
    ])
    .where('collection_id', '=', collectionId)
    .where('id', '=', rootNodeId)
    .where('is_root', '=', true)
    .executeTakeFirst();

  if (!row) return null;
  dualReadNodePayload(row, metrics);
  if (row.kind !== 'folder' || row.title === null) {
    throw new Error(`root node ${row.id} has invalid canonical shape`);
  }
  return {
    id: row.id,
    collectionId: row.collection_id,
    title: row.title,
    description: row.description,
    tags: row.tags,
    resourceRevision: row.resource_revision,
    childrenRevision: row.children_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadLiveNodesPage(
  transaction: DatabaseTransaction,
  input: LoadCollectionEditorSnapshotInput,
  metrics?: Metrics,
): Promise<EditorLiveNodeRow[]> {
  const fetchLimit = input.limit + 1;

  // Comparator: (parent_key, position_key, node_id) with null -> '' sentinel, C collation.
  // Root excluded: NOT is_root; live only: deleted_at IS NULL.
  let query = transaction
    .selectFrom('nodes')
    .select([
      'id',
      'collection_id',
      'parent_id',
      'kind',
      'is_root',
      'title',
      'url',
      'description',
      'tags',
      'visibility',
      'position_token',
      'resource_revision',
      'children_revision',
      'created_at',
      'updated_at',
      'deleted_at',
      'deleted_commit_ordinal',
      'payload_json',
    ])
    .where('collection_id', '=', input.collectionId)
    .where(sql<boolean>`NOT is_root`)
    .where('kind', 'in', ['folder', 'bookmark'])
    .where('deleted_at', 'is', null);

  if (input.after) {
    const { parentKey, positionKey, nodeId } = input.after;
    query = query.where(sql<boolean>`(
      ${editorParentKey},
      ${editorPositionKey},
      ${editorNodeIdKey}
    ) > (
      ${parentKey}::text COLLATE "C",
      ${positionKey}::text COLLATE "C",
      ${nodeId}::text COLLATE "C"
    )`);
  }

  const rows = await query
    .orderBy(editorParentKey)
    .orderBy(editorPositionKey)
    .orderBy(editorNodeIdKey)
    .limit(fetchLimit)
    .execute();

  return rows.map((row) => {
    dualReadNodePayload(row, metrics);
    if (row.parent_id === null || row.position_token === null) {
      throw new Error(`live non-root node ${row.id} is missing parent or position`);
    }
    if ((row.kind !== 'folder' && row.kind !== 'bookmark') || row.title === null) {
      throw new Error(`editor node ${row.id} has an unsupported canonical shape`);
    }
    return {
      id: row.id,
      collectionId: row.collection_id,
      parentId: row.parent_id,
      kind: row.kind,
      title: row.title,
      url: row.url,
      description: row.description,
      tags: row.tags,
      visibility: row.visibility,
      positionToken: row.position_token,
      resourceRevision: row.resource_revision,
      childrenRevision: row.children_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.kind === 'bookmark' && isBookmarkPinned((row.payload_json as { extensions?: unknown } | null)?.extensions)
        ? { pinned: true } : {}),
    };
  });
}
