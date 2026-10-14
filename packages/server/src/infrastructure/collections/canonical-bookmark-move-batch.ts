import { sql } from 'kysely';
import { CollectionsError, type CanonicalMutationInput } from '../../modules/collections/index.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { CanonicalTreeCapacityAdmission } from './canonical-tree-capacity.js';
import { planBookmarkMoves, BookmarkMoveBatchFallback } from './canonical-bookmark-move-plan.js';
import { writeBookmarkMoves, type BookmarkBatchFactWriter } from './canonical-bookmark-move-write.js';

/** Same atomic canonical effects, with bounded bulk SQL for distinct bookmark
 * moves. Returning false means no write occurred and the normal adapter is needed.
 */
export async function canonicalBookmarkMoveBatch(tx: DatabaseTransaction, collectionId: string,
  inputs: readonly CanonicalMutationInput[], admission: CanonicalTreeCapacityAdmission, captureFacts?: BookmarkBatchFactWriter): Promise<boolean> {
  if (!inputs.length) return true;
  if (inputs.length > 1000 || new Set(inputs.map(i => i.mutation.target.resourceId)).size !== inputs.length) return false;
  await lockActiveSyncReplicasForCollection(tx, collectionId);
  const collection = await tx.selectFrom('collections').selectAll().where('id', '=', collectionId).forUpdate().executeTakeFirstOrThrow();
  if (collection.deleted_at) return false;
  const rows = await tx.selectFrom('nodes').selectAll().where('collection_id', '=', collectionId)
    .where('deleted_at', 'is', null).execute();
  const nodes = new Map(rows.map(row => [row.id, row]));
  if (inputs.some(input => input.mutation.action !== 'move' || input.mutation.target.resourceKind !== 'node'
    || input.mutation.relativePosition || nodes.get(input.mutation.target.resourceId)?.kind !== 'bookmark'
    || nodes.get(input.mutation.target.resourceId)?.parent_id === input.mutation.parentId)) return false;
  const now = (await sql<{ now: Date }>`SELECT current_timestamp AS now`.execute(tx)).rows[0]!.now;
  let plan;
  try { plan = await planBookmarkMoves(collection, rows, inputs, now); }
  catch (error) {
    if (error instanceof BookmarkMoveBatchFallback) return false;
    if (error instanceof CollectionsError && error.code === 'invalid_node_anchor') return false;
    throw error;
  }
  await admission.execute(tx, collectionId, () => writeBookmarkMoves(tx, plan, now, captureFacts));
  return true;
}
