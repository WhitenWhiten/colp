import { appendAutomationResume } from '../outbox/automation-ingest.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDigest, type EffectReceiptView, type FolderRef } from '@know-n/colp/automation';
import { placementUndoAvailability, type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { PlannedAutomationFacts } from './fact-capture.js';
export interface PlacementEffectRow {
  id: string; run_id: string; operation_id: string; effect_digest: string; plan_id: string | null;
  collection_id: string | null; node_id: string | null; before_folder: FolderRef | null;
  after_revision: string; after_content_revision: string | null; after_parent_id: string | null; undone_operation_id: string | null;
}
export async function recordPlacementHistory(tx: DatabaseTransaction, actor: AutomationActor, serverUuid: string, runId: string, operationId: string): Promise<{ id: string; inserted: boolean }> {
  const facts = (await sql<{ facts_json: PlannedAutomationFacts & { action: string }; collection_id: string; node_id: string;
    commit_ordinal: string; occurred_at: Date; rule_revision_id: string }>`SELECT f.*,r.rule_revision_id FROM automation_event_facts f
    JOIN automation_runs r ON r.id=${runId} AND r.owner_id=${actor.accountId}
      AND r.explanation_json->>'collectionId'=f.collection_id AND r.explanation_json->>'nodeId'=f.node_id
    WHERE f.operation_id=${operationId}`.execute(tx)).rows[0];
  if (!facts?.facts_json.after || !['create','move'].includes(facts.facts_json.action)) throw new Error('Verified canonical placement facts required');
  const before = facts.facts_json.action === 'move' ? facts.facts_json.before : null, after = facts.facts_json.after;
  const content = await tx.selectFrom('content_revisions').select('revision').where('collection_id', '=', facts.collection_id)
    .where('ordinal', '=', BigInt(facts.commit_ordinal)).executeTakeFirst();
  const beforeFolder = before?.parentId ? { serverUuid, collectionId: facts.collection_id, nodeId: before.parentId } : null;
  const digest = automationDigest({ kind: 'placement', runId, operationId, ruleRevisionId: facts.rule_revision_id,
    beforeFolder, beforeRevision: before?.resourceRevision ?? null, afterRevision: after.resourceRevision,
    afterParentId: after.parentId, afterContentRevision: content?.revision ?? null });
  const rows = await sql<{ id: string }>`INSERT INTO automation_effect_receipts
    (id,run_id,job_id,step_id,target_partition,plan_id,operation_id,before_folder,before_revision,after_revision,effect_digest,
      collection_id,node_id,after_parent_id,after_content_revision,created_at)
    VALUES (${randomUUID()},${runId},NULL,'intake','__m1__',NULL,${operationId},${beforeFolder ? JSON.stringify(beforeFolder) : null}::jsonb,
      ${before?.resourceRevision ?? null},${after.resourceRevision!},${digest},${facts.collection_id},${facts.node_id},${after.parentId},
      ${content?.revision ?? null},${facts.occurred_at}) ON CONFLICT (run_id,step_id,target_partition) DO NOTHING RETURNING id`.execute(tx);
  if (rows.rows[0]) {
    const waiting=(await sql`SELECT r.id FROM automation_rules r JOIN automation_rule_revisions v ON v.id=r.current_revision_id
      WHERE r.owner_id=${actor.accountId} AND r.desired_state='enabled' AND v.definition_json->>'on'='intake.completed'
      AND v.definition_json#>>'{trigger,mode}'='countBatch' LIMIT 1`.execute(tx)).rows;
    if(waiting.length)await appendAutomationResume(tx,facts.collection_id);
    return {id:rows.rows[0].id,inserted:true};
  }
  return { id: (await sql<{ id: string }>`SELECT id FROM automation_effect_receipts WHERE run_id=${runId} AND step_id='intake' AND target_partition='__m1__'`.execute(tx)).rows[0]!.id, inserted: false };
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
