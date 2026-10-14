import { type EffectReceiptView, type FolderRef } from '@know-n/colp/automation';
import { placementUndoAvailability, type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { recordPlacementHistories } from './placement-history-batch.js';
export { recordPlacementHistories } from './placement-history-batch.js';
export interface PlacementEffectRow {
  id: string; run_id: string; operation_id: string; effect_digest: string; plan_id: string | null;
  collection_id: string | null; node_id: string | null; before_folder: FolderRef | null;
  after_revision: string; after_content_revision: string | null; after_parent_id: string | null; undone_operation_id: string | null;
}
export async function recordPlacementHistory(tx: DatabaseTransaction, actor: AutomationActor, serverUuid: string, runId: string, operationId: string): Promise<{ id: string; inserted: boolean }> {
  return (await recordPlacementHistories(tx, actor, serverUuid, [{ runId, operationId }]))[0]!;
}

export async function placementEffectView(tx: DatabaseTransaction, actor: AutomationActor, row: PlacementEffectRow): Promise<EffectReceiptView> {
  const collection = row.collection_id ? await tx.selectFrom('collections').select(['owner_subject_id','content_revision','deleted_at'])
    .where('id', '=', row.collection_id).executeTakeFirst() : undefined;
  const node = row.collection_id && row.node_id ? await tx.selectFrom('nodes').select(['resource_revision','parent_id','deleted_at','kind'])
    .where('id', '=', row.node_id).where('collection_id', '=', row.collection_id).executeTakeFirst() : undefined;
  const parent = row.before_folder ? await tx.selectFrom('nodes').select(['kind','deleted_at']).where('id', '=', row.before_folder.nodeId)
    .where('collection_id', '=', row.before_folder.collectionId).executeTakeFirst() : undefined;
  return { id: row.id, kind: row.plan_id ? 'plan' : 'placement', status: row.undone_operation_id ? 'reverted' : 'committed',
    effectDigest: row.effect_digest, operationId: row.operation_id, ...(row.plan_id ? { planId: row.plan_id } : {}),
    ...placementUndoAvailability({ originalDestinationKnown: row.before_folder !== null,
      originalDestinationAvailable: !!parent && parent.kind === 'folder' && !parent.deleted_at,
      currentOwner: !!collection && !collection.deleted_at && collection.owner_subject_id === actor.subjectId,
      currentResourceMatches: !!node && !node.deleted_at && node.kind === 'bookmark' && node.resource_revision === row.after_revision && node.parent_id === row.after_parent_id,
      currentContentMatches: !!collection && collection.content_revision === row.after_content_revision,
      alreadyReverted: row.undone_operation_id !== null }) };
}
