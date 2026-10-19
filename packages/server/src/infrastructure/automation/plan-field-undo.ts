import { randomUUID } from 'node:crypto';
import { createCanonicalMutationApplication, deleteAnnotation } from '../../modules/collections/index.js';
import { AutomationError, type AutomationActor } from '../../modules/automation/index.js';
import type { AutomationPlanOperation } from '../../modules/mcp/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresCanonicalMutationPorts } from '../collections/canonical-mutation-postgres-ports.js';
import { createPostgresAnnotationMutationPorts } from '../collections/annotation-canonical-postgres.js';
import type { PlacementEffectRow } from './placement-history-store.js';

export function fieldUndoSupported(op: AutomationPlanOperation | undefined): boolean {
  return op?.type === 'update_node' ? Array.isArray(op.previousTags) && op.previousTags.every(tag => typeof tag === 'string')
    : op?.type === 'create_annotation' && typeof op.annotationId === 'string' && !!op.annotationId;
}

/** Called only after current Owner, plan/effect binding and content/resource revisions have been checked under the collection lock. */
export async function undoPlanField(tx: DatabaseTransaction, actor: AutomationActor, row: PlacementEffectRow): Promise<string> {
  const plan = await tx.selectFrom('mcp_change_plans').select('operations_json').where('plan_id', '=', row.plan_id!).executeTakeFirst();
  const op = (plan?.operations_json as AutomationPlanOperation[] | undefined)?.[0];
  if (!fieldUndoSupported(op) || !op) throw new AutomationError('automation_stale_input', 'The effect has no stored field compensation.');
  const context = { origin: 'automation' as const, rootRunId: row.run_id, stageId: 'undo', hopCount: 1 };
  if (op.type === 'update_node') {
    const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, { invalidateSyncReplicasOnNodeMutation: true }));
    const result = await canonical.execute({ transaction: tx }, { operationId: randomUUID(), collectionId: op.collectionId,
      actor: { principalId: actor.accountId, principalType: 'account' }, automationContext: context,
      mutation: { action: 'update', target: { collectionId: op.collectionId, resourceId: op.nodeId, resourceKind: 'node' },
        parentId: null, expectedResourceRevision: row.after_revision, fields: { kindFields: { tags: op.previousTags! }, extensions: {} } } });
    return result.operationId;
  }
  const ports = createPostgresAnnotationMutationPorts(tx);
  const result = await deleteAnnotation({ ...ports, canonical: { execute: input => ports.canonical.execute({ ...input, automationContext: context }) } }, {
    actor: { principalId: actor.accountId, subjectId: actor.subjectId, principalType: 'account' },
    collectionId: op.collectionId, annotationId: op.annotationId!,
    command: { commandId: randomUUID(), fingerprint: `undo-automation:${row.id}` },
    precondition: { kind: 'single-strong-if-match', entityTag: `"${row.after_revision}"`, expectedRevision: row.after_revision },
  });
  if (result.kind !== 'deleted') throw new AutomationError('automation_stale_input', 'The note could not be reverted.');
  return result.operationId;
}
