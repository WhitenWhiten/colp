import { automationCaptureEnabled, captureAutomationFactsBatch, type AutomationNodeSnapshot } from './fact-capture.js';
import { randomUUID } from 'node:crypto';
import { AutomationError, isIntakeRootFolder, type AutomationActor } from '../../modules/automation/index.js';
import { createCanonicalMutationApplication, type CanonicalMutationInput } from '../../modules/collections/index.js';
import { createPostgresCanonicalMutationPorts, canonicalBookmarkMoveBatch, type CanonicalTreeCapacityAdmission } from '../collections/index.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { PlannedBookmarkMove } from '../collections/canonical-bookmark-move-plan.js';
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
  return canonical.execute({ transaction: tx }, placementMoveInput(actor, input));
}
export function placementMoveInput(actor: AutomationActor, input: {
  collectionId: string; nodeId: string; parentId: string; expectedRevision: string; runId: string; stage: 'intake' | 'undo';
}): CanonicalMutationInput {
  return { operationId: randomUUID(), collectionId: input.collectionId,
    actor: { principalId: actor.accountId, principalType: 'account' }, automationContext: { origin: 'automation', rootRunId: input.runId, stageId: input.stage, hopCount: 1 },
    mutation: { action: 'move', target: { collectionId: input.collectionId, resourceId: input.nodeId, resourceKind: 'node' },
      parentId: input.parentId, expectedResourceRevision: input.expectedRevision, fields: { kindFields: {}, extensions: {} } } };
}

export async function canonicalPlacementMoveBatch(tx: DatabaseTransaction, collectionId: string,
  inputs: readonly CanonicalMutationInput[], admission: CanonicalTreeCapacityAdmission): Promise<boolean> {
  return canonicalBookmarkMoveBatch(tx, collectionId, inputs, admission,
    automationCaptureEnabled() ? capturePlacementMoveFacts : undefined);
}

export async function capturePlacementMoveFacts(tx: DatabaseTransaction, moves: readonly PlannedBookmarkMove[]) {
    await captureAutomationFactsBatch(tx, moves.map(move => {
      const facts = move.event.plan!.facts!;
      const snapshot = (row: typeof move.after, ancestry: typeof facts.sourceAncestors): AutomationNodeSnapshot => ({
        kind: row.kind, title: row.title, url: row.url,
        tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        parentId: row.parent_id, resourceRevision: row.resource_revision,
        parentIsIntakeRoot: isIntakeRootFolder(ancestry[0] ? { isRoot: ancestry[0].is_root,
          folderRole: (ancestry[0].payload_json?.folderRole as string | undefined) ?? null } : undefined),
        ancestorIds: ancestry.slice(0, 128).map(row => row.id), ancestryComplete: ancestry.length <= 128,
      });
      return { event: move.event, input: move.input, allocation: move.result.allocation,
        planned: { before: snapshot(facts.before, facts.sourceAncestors), after: snapshot(move.after, facts.targetAncestors) } };
    }));
}
