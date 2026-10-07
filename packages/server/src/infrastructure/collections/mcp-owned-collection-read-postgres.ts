import { sql, type Kysely } from 'kysely';
import type { AccessPolicyFactsPort } from '../../modules/access-policy/index.js';
import type {
  Phase4bMcpOwnedCollectionReadPort,
  Phase4bMcpOwnedCollectionRecord,
  Phase4bMcpOwnedNodeRecord,
  Phase4bMcpOwnedSnapshotAfter,
} from '../../modules/mcp/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/repositories.js';
import { editorNodeIdKey, editorParentKey, editorPositionKey } from './editor-query.js';

export function createPostgresMcpOwnedCollectionReadPort(input: {
  readonly db: Kysely<DatabaseSchema>;
  readonly accessPolicy: AccessPolicyFactsPort;
}): Phase4bMcpOwnedCollectionReadPort {
  const { db, accessPolicy } = input;
  const port: Phase4bMcpOwnedCollectionReadPort = {
    async readCollection(request) {
      if (!(await actorCanReadOwned(accessPolicy, request.collectionId, request.actorSubjectId))) {
        return null;
      }
      return loadCollection(db, request.collectionId);
    },
    async readSnapshot(request) {
      if (!(await actorCanReadOwned(accessPolicy, request.collectionId, request.actorSubjectId))) {
        return null;
      }
      return db.transaction().setIsolationLevel('repeatable read').execute(async transaction => {
        if (!(await actorCanReadOwned(createPostgresAccessPolicyFactsPort(transaction), request.collectionId, request.actorSubjectId))) return null;
        const collection = await loadCollection(transaction, request.collectionId);
        if (collection === null) return null;
        if (request.after && (request.after.contentRevision !== collection.contentRevision
          || request.after.policyRevision !== collection.policyRevision)) {
          throw new Error('Snapshot changed; restart from the first page.');
        }
        const root = await loadRoot(transaction, request.collectionId, collection.rootNodeId);
        const page = await loadLiveNodesPage(transaction, request.collectionId, request.limit, request.after);
        const hasMore = page.length > request.limit;
        const nodes = hasMore ? page.slice(0, request.limit) : page;
        const last = nodes[nodes.length - 1];
        const nextAfter = hasMore && last !== undefined
          ? Object.freeze({
            parentKey: last.parentId ?? '', positionKey: last.positionToken ?? '', nodeId: last.id,
            contentRevision: collection.contentRevision, policyRevision: collection.policyRevision,
          }) : null;
        return Object.freeze({ collection, root, nodes: Object.freeze(nodes), hasMore, nextAfter,
          consistency: 'version-fenced' as const });
      });
    },
    async readNode(request) {
      if (!(await actorCanReadOwned(accessPolicy, request.collectionId, request.actorSubjectId))) {
        return null;
      }
      return loadNode(db, request.collectionId, request.nodeId);
    },
  };
  return Object.freeze(port);
}

async function actorCanReadOwned(
  accessPolicy: AccessPolicyFactsPort,
  collectionId: string,
  actorSubjectId: string,
): Promise<boolean> {
  const facts = await accessPolicy.loadCollectionFacts({ collectionId, actorSubjectId });
  if (facts === null || facts.deleted) return false;
  return facts.ownerSubjectId === actorSubjectId || facts.membershipRole !== null;
}

async function loadCollection(
  db: Kysely<DatabaseSchema>,
  collectionId: string,
): Promise<Phase4bMcpOwnedCollectionRecord | null> {
  const row = await db
    .selectFrom('collections')
    .select([
      'id',
      'kind',
      'title',
      'summary',
      'visibility',
      'root_node_id',
      'publication_slug',
      'resource_revision',
      'content_revision',
      'policy_revision',
      'created_at',
      'updated_at',
      'deleted_at',
    ])
    .where('id', '=', collectionId)
    .executeTakeFirst();
  if (row === undefined || row.deleted_at !== null) return null;
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    visibility: row.visibility,
    rootNodeId: row.root_node_id,
    publicationSlug: row.publication_slug,
    resourceRevision: row.resource_revision,
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function loadRoot(
  db: Kysely<DatabaseSchema>,
  collectionId: string,
  rootNodeId: string,
): Promise<Phase4bMcpOwnedNodeRecord | null> {
  const row = await db
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
      'visibility',
      'position_token',
      'resource_revision',
      'children_revision',
      'created_at',
      'updated_at',
      'deleted_at',
    ])
    .where('collection_id', '=', collectionId)
    .where('id', '=', rootNodeId)
    .where('is_root', '=', true)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined || row.kind !== 'folder' || row.title === null) return null;
  return mapNode(row, true);
}

async function loadNode(
  db: Kysely<DatabaseSchema>,
  collectionId: string,
  nodeId: string,
): Promise<Phase4bMcpOwnedNodeRecord | null> {
  const row = await db
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
      'visibility',
      'position_token',
      'resource_revision',
      'children_revision',
      'created_at',
      'updated_at',
      'deleted_at',
    ])
    .where('collection_id', '=', collectionId)
    .where('id', '=', nodeId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined || (row.kind !== 'folder' && row.kind !== 'bookmark') || row.title === null) {
    return null;
  }
  return mapNode(row, row.is_root);
}

async function loadLiveNodesPage(
  db: Kysely<DatabaseSchema>,
  collectionId: string,
  limit: number,
  after: Phase4bMcpOwnedSnapshotAfter | undefined,
): Promise<Phase4bMcpOwnedNodeRecord[]> {
  const fetchLimit = limit + 1;
  let query = db
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
      'visibility',
      'position_token',
      'resource_revision',
      'children_revision',
      'created_at',
      'updated_at',
      'deleted_at',
    ])
    .where('collection_id', '=', collectionId)
    .where(sql<boolean>`NOT is_root`)
    .where('kind', 'in', ['folder', 'bookmark'])
    .where('deleted_at', 'is', null);
  if (after !== undefined) {
    query = query.where(sql<boolean>`(
      ${editorParentKey},
      ${editorPositionKey},
      ${editorNodeIdKey}
    ) > (
      ${after.parentKey}::text COLLATE "C",
      ${after.positionKey}::text COLLATE "C",
      ${after.nodeId}::text COLLATE "C"
    )`);
  }
  const rows = await query
    .orderBy(editorParentKey)
    .orderBy(editorPositionKey)
    .orderBy(editorNodeIdKey)
    .limit(fetchLimit)
    .execute();
  const mapped: Phase4bMcpOwnedNodeRecord[] = [];
  for (const row of rows) {
    if (row.kind !== 'folder' && row.kind !== 'bookmark') continue;
    if (row.title === null || row.parent_id === null || row.position_token === null) continue;
    mapped.push(mapNode(row, false));
  }
  return mapped;
}

function mapNode(
  row: {
    readonly id: string;
    readonly collection_id: string;
    readonly parent_id: string | null;
    readonly kind: 'folder' | 'bookmark' | 'separator';
    readonly is_root: boolean;
    readonly title: string | null;
    readonly url: string | null;
    readonly description: string | null;
    readonly visibility: 'inherit' | 'protected' | 'private';
    readonly position_token: string | null;
    readonly resource_revision: string;
    readonly children_revision: string;
    readonly created_at: Date;
    readonly updated_at: Date;
  },
  isRoot: boolean,
): Phase4bMcpOwnedNodeRecord {
  return Object.freeze({
    id: row.id,
    collectionId: row.collection_id,
    parentId: row.parent_id,
    kind: row.kind === 'bookmark' ? 'bookmark' : 'folder',
    isRoot,
    title: row.title ?? '',
    url: row.url,
    description: row.description,
    visibility: row.visibility,
    positionToken: row.position_token,
    resourceRevision: row.resource_revision,
    childrenRevision: row.children_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
