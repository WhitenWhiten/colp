import { sql } from 'kysely';
import type { NodeRow } from './canonical-mutation-postgres-ports.js';
import { CollectionsError, type CanonicalMutationInput } from '../../modules/collections/index.js';
import type { CanonicalMutationResult } from '../../modules/collections/index.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { CanonicalTreeCapacityAdmission } from './canonical-tree-capacity.js';
import { planBookmarkMoves, BookmarkMoveBatchFallback } from './canonical-bookmark-move-plan.js';
import { writeBookmarkMoves, type BookmarkBatchFactWriter } from './canonical-bookmark-move-write.js';

/** Same atomic canonical effects, with bounded bulk SQL for distinct bookmark
 * moves. Returning false means no write occurred and the normal adapter is needed.
 */
export async function canonicalBookmarkMoveBatch(tx: DatabaseTransaction, collectionId: string,
  inputs: readonly CanonicalMutationInput[], admission: CanonicalTreeCapacityAdmission, captureFacts?: BookmarkBatchFactWriter,
  options?: { serverSync?: BookmarkBatchFactWriter; onResults?: (results: readonly CanonicalMutationResult[]) => void }): Promise<boolean> {
  if (!inputs.length) return true;
  if (inputs.length > 1000 || new Set(inputs.map(i => i.mutation.target.resourceId)).size !== inputs.length) return false;
  await lockActiveSyncReplicasForCollection(tx, collectionId);
  const collection = await tx.selectFrom('collections').selectAll().where('id', '=', collectionId).forUpdate().executeTakeFirstOrThrow();
  if (collection.deleted_at) return false;
  const selected = await tx.selectFrom('nodes').selectAll().where('collection_id', '=', collectionId)
    .where('id', 'in', inputs.map(input => input.mutation.target.resourceId)).where('deleted_at', 'is', null).execute();
  const parentIds = [...new Set([...selected.flatMap(row => row.parent_id ? [row.parent_id] : []),
    ...inputs.flatMap(input => input.mutation.parentId ? [input.mutation.parentId] : [])])];
  const ancestors = (await sql<NodeRow>`WITH RECURSIVE ancestry AS (
    SELECT id,parent_id,ARRAY[id] AS seen,0 AS depth FROM nodes
      WHERE collection_id=${collectionId} AND id=ANY(${parentIds}::text[]) AND deleted_at IS NULL
    UNION ALL SELECT n.id,n.parent_id,a.seen||n.id,a.depth+1 FROM nodes n JOIN ancestry a ON n.id=a.parent_id
      WHERE n.collection_id=${collectionId} AND n.deleted_at IS NULL AND NOT n.id=ANY(a.seen) AND a.depth<256
  ) SELECT n.* FROM nodes n WHERE n.collection_id=${collectionId} AND n.id IN (SELECT id FROM ancestry)`.execute(tx)).rows;
  const destinations = [...new Set(inputs.flatMap(input => input.mutation.parentId ? [input.mutation.parentId] : []))];
  // N+1 tails suffice even when all N moving nodes leave a later destination.
  // This keeps a ten-member continuation independent of the collection size.
  const tails = (await sql<NodeRow>`SELECT n.* FROM unnest(${destinations}::text[]) AS p(id)
    CROSS JOIN LATERAL (SELECT * FROM nodes WHERE collection_id=${collectionId} AND parent_id=p.id AND deleted_at IS NULL
      ORDER BY position_token COLLATE "C" DESC,id LIMIT ${inputs.length + 1}) n`.execute(tx)).rows;
  const rows = [...new Map([...selected, ...ancestors, ...tails].map(row => [row.id, row])).values()];
  const nodes = new Map(rows.map(row => [row.id, row]));
  if (inputs.some(input => input.mutation.action !== 'move' || input.mutation.target.resourceKind !== 'node'
    || input.mutation.relativePosition || nodes.get(input.mutation.target.resourceId)?.kind !== 'bookmark'
    || nodes.get(input.mutation.target.resourceId)?.parent_id === input.mutation.parentId)) return false;
  const now = (await sql<{ now: Date }>`SELECT current_timestamp AS now`.execute(tx)).rows[0]!.now;
  let plan;
  try { plan = await planBookmarkMoves(collection, rows, inputs, now, !!options?.serverSync); }
  catch (error) {
    if (error instanceof BookmarkMoveBatchFallback) return false;
    if (error instanceof CollectionsError && error.code === 'invalid_node_anchor') return false;
    throw error;
  }
  await admission.execute(tx, collectionId, () => writeBookmarkMoves(tx, plan, now, captureFacts, options?.serverSync));
  options?.onResults?.(plan.moves.map(move => move.result));
  return true;
}
