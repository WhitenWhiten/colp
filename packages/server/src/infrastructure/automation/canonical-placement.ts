import { randomUUID } from 'node:crypto';
import { AutomationError, type AutomationActor } from '../../modules/automation/index.js';
import { createCanonicalMutationApplication } from '../../modules/collections/index.js';
import { createPostgresCanonicalMutationPorts, type CanonicalTreeCapacityAdmission } from '../collections/index.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
/** Transaction-local M1 Owner effect, with the same canonical authority as other writers. */
export async function lockPlacementCollection(tx: DatabaseTransaction, actor: AutomationActor, collectionId: string) {
  await lockActiveSyncReplicasForCollection(tx, collectionId);
  const collection = await tx.selectFrom('collections').selectAll().where('id', '=', collectionId).forUpdate().executeTakeFirst();
  if (!collection || collection.deleted_at || collection.owner_subject_id !== actor.subjectId)
    throw new AutomationError('resource_not_found', 'Current Owner collection is unavailable.');
  return collection;
}
export async function canonicalPlacementMove(tx: DatabaseTransaction, actor: AutomationActor, input: {
  collectionId: string; nodeId: string; parentId: string; expectedRevision: string; runId: string; stage: 'intake' | 'undo';
}, treeCapacityAdmission?: CanonicalTreeCapacityAdmission) {
  const node = await tx.selectFrom('nodes').select(['kind','deleted_at','resource_revision']).where('id', '=', input.nodeId)
    .where('collection_id', '=', input.collectionId).executeTakeFirst();
  if (!node || node.kind !== 'bookmark' || node.deleted_at || node.resource_revision !== input.expectedRevision)
    throw new AutomationError('automation_stale_input', 'Bookmark changed before placement.');
  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, { invalidateSyncReplicasOnNodeMutation: true, treeCapacityAdmission }));
  return canonical.execute({ transaction: tx }, { operationId: randomUUID(), collectionId: input.collectionId,
    actor: { principalId: actor.accountId, principalType: 'account' }, automationContext: { origin: 'automation', rootRunId: input.runId, stageId: input.stage, hopCount: 1 },
    mutation: { action: 'move', target: { collectionId: input.collectionId, resourceId: input.nodeId, resourceKind: 'node' },
      parentId: input.parentId, expectedResourceRevision: input.expectedRevision, fields: { kindFields: {}, extensions: {} } } });
}
