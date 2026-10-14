import { sql } from 'kysely';
import { AutomationError, type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { ManualSnapshot } from './manual-preview-store.js';

export interface ManualChild { id: string; member: ManualSnapshot['members'][number] }

/** Caller owns the collection replica gate and row lock. Validate the immutable
 * snapshot together, but retain per-mutation checks: an earlier move can rebalance
 * a later member's position/revision even though concurrent writers are excluded.
 */
export async function validateManualMembers(tx: DatabaseTransaction, snapshot: ManualSnapshot) {
  const rows = snapshot.members.length ? await tx.selectFrom('nodes')
    .select(['id', 'resource_revision', 'deleted_at', 'parent_id'])
    .where('collection_id', '=', snapshot.collectionId)
    .where('id', 'in', snapshot.members.map(m => m.event.nodeId)).execute() : [];
  const nodes = new Map(rows.map(row => [row.id, row]));
  for (const member of snapshot.members) {
    const node = nodes.get(member.event.nodeId);
    if (!node || node.deleted_at || node.resource_revision !== member.revision)
      throw new AutomationError('automation_stale_input', 'Run-once preview changed or expired; refresh the preview.');
  }
  return nodes;
}

export async function insertManualRuns(tx: DatabaseTransaction, actor: AutomationActor,
  parentId: string, snapshot: ManualSnapshot, children: readonly ManualChild[]) {
  const rows = [{ id: parentId, member_ids: children.map(c => c.member.event.eventId),
    explanation: { collectionId: snapshot.collectionId, manualSelection: true, plan: { kind: 'matched' }, causationRoot: parentId } },
  ...children.map(({ id, member }) => ({ id, member_ids: [member.event.eventId],
    explanation: { collectionId: snapshot.collectionId, nodeId: member.event.nodeId, sourceRevision: member.revision,
      parentRunId: parentId, causationRoot: parentId, plan: member.plan } }))];
  await sql`INSERT INTO automation_runs
    (id,owner_id,kind,rule_revision_id,binding_set_id,binding_revision,policy_revision,member_ids,state,explanation_json)
    SELECT id,${actor.accountId},'manual',${snapshot.ruleRevisionId},${snapshot.bindingSetId},${snapshot.bindingRevision}::bigint,
      ${snapshot.policyRevision},member_ids,'completed',explanation
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS i(id text,member_ids jsonb,explanation jsonb)`.execute(tx);
}
