import { sql, type Kysely } from 'kysely';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type { DatabaseSchema } from '../database/index.js';
import type { Phase4bMcpAuthoritativeStatePort } from '../../modules/mcp/change-plan-planner.js';

/** Read placement and subtree facts in one snapshot, after checking write authority. */
export function createMcpNodePlanState(
  db: Kysely<DatabaseSchema>,
  authorize: (trx: Kysely<DatabaseSchema>, collectionId: string,
    binding: McpAuthenticatedAuthorizationBinding, capability: 'move_node' | 'delete_node') => Promise<void>,
  unavailable: () => never,
): Pick<Phase4bMcpAuthoritativeStatePort, 'resolveMovePlacement' | 'resolveDeleteSubtree'> {
  return {
    resolveMovePlacement: (input, binding) => db.transaction()
      .setIsolationLevel('repeatable read').execute(async (trx) => {
        const node = await liveNode(trx, input.nodeId, input.collectionId);
        if (!node || node.is_root || !node.parent_id) return unavailable();
        await authorize(trx, node.collection_id, binding, 'move_node');
        const collection = await trx.selectFrom('collections')
          .select(['content_revision', 'visibility']).where('id', '=', node.collection_id)
          .where('deleted_at', 'is', null).executeTakeFirst();
        const source = await liveNode(trx, node.parent_id, node.collection_id);
        const target = await liveNode(trx, input.parentId, node.collection_id);
        if (!collection || !source || !target || target.kind !== 'folder') return unavailable();
        const cycle = await sql<{ invalid: boolean }>`WITH RECURSIVE subtree AS (
          SELECT id FROM nodes WHERE id = ${node.id} AND collection_id = ${node.collection_id} AND deleted_at IS NULL
          UNION SELECT child.id FROM nodes child JOIN subtree ON child.parent_id = subtree.id
            WHERE child.collection_id = ${node.collection_id} AND child.deleted_at IS NULL
        ) SELECT EXISTS(SELECT 1 FROM subtree WHERE id = ${target.id}) AS invalid`.execute(trx);
        if (cycle.rows[0]?.invalid) return unavailable();
        return {
          collectionId: node.collection_id, title: node.title ?? node.id,
          fromPath: await folderPath(trx, source.id, source.collection_id),
          toPath: await folderPath(trx, target.id, target.collection_id),
          nodeRevision: node.resource_revision,
          destinationChildrenRevision: target.children_revision,
          sourceParentId: source.id, sourceChildrenRevision: source.children_revision,
          collectionContentRevision: collection.content_revision,
          collectionVisibility: collection.visibility,
        };
      }),
    resolveDeleteSubtree: (input, binding) => db.transaction()
      .setIsolationLevel('repeatable read').execute(async (trx) => {
        const node = await liveNode(trx, input.nodeId, input.collectionId);
        if (!node || node.is_root || !node.parent_id) return unavailable();
        await authorize(trx, node.collection_id, binding, 'delete_node');
        const parent = await liveNode(trx, node.parent_id, node.collection_id);
        const collection = await trx.selectFrom('collections').select('content_revision')
          .where('id', '=', node.collection_id).where('deleted_at', 'is', null).executeTakeFirst();
        if (!parent || !collection) return unavailable();
        const count = await sql<{ count: number }>`WITH RECURSIVE subtree AS (
          SELECT id FROM nodes WHERE id = ${node.id} AND collection_id = ${node.collection_id} AND deleted_at IS NULL
          UNION SELECT child.id FROM nodes child JOIN subtree ON child.parent_id = subtree.id
            WHERE child.collection_id = ${node.collection_id} AND child.deleted_at IS NULL
        ) SELECT count(*)::int AS count FROM subtree`.execute(trx);
        return { collectionId: node.collection_id, title: node.title ?? node.id,
          nodeRevision: node.resource_revision, contentRevision: collection.content_revision,
          parentId: parent.id, parentChildrenRevision: parent.children_revision,
          subtreeCount: count.rows[0]!.count };
      }),
  };
}

function liveNode(db: Kysely<DatabaseSchema>, nodeId: string, collectionId?: string) {
  let query = db.selectFrom('nodes').select(['id', 'collection_id', 'parent_id', 'is_root',
    'title', 'kind', 'resource_revision', 'children_revision'])
    .where('id', '=', nodeId).where('deleted_at', 'is', null);
  if (collectionId !== undefined) query = query.where('collection_id', '=', collectionId);
  return query.executeTakeFirst();
}

async function folderPath(db: Kysely<DatabaseSchema>, nodeId: string, collectionId: string) {
  const rows = await sql<{ title: string }>`WITH RECURSIVE ancestors AS (
    SELECT id, parent_id, title, is_root, 0 AS depth, ARRAY[id] AS seen FROM nodes
      WHERE id = ${nodeId} AND collection_id = ${collectionId} AND deleted_at IS NULL
    UNION ALL SELECT parent.id, parent.parent_id, parent.title, parent.is_root,
      ancestors.depth + 1, ancestors.seen || parent.id
      FROM ancestors JOIN nodes parent ON parent.id = ancestors.parent_id
      WHERE parent.collection_id = ${collectionId} AND parent.deleted_at IS NULL
        AND NOT parent.id = ANY(ancestors.seen)
  ) SELECT coalesce(title, id) AS title FROM ancestors WHERE NOT is_root ORDER BY depth DESC`.execute(db);
  return '/' + rows.rows.map((row) => row.title).join('/');
}
