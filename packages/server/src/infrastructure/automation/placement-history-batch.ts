import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { automationDigest } from '@know-n/colp/automation';
import type { AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { appendAutomationResume } from '../outbox/automation-ingest.js';
import type { PlannedAutomationFacts } from './fact-capture.js';

interface Placement { runId: string; operationId: string }
interface Facts {
  run_id: string; operation_id: string; rule_revision_id: string;
  collection_id: string; node_id: string; occurred_at: Date; content_revision: string | null;
  facts_json: PlannedAutomationFacts & { action: string };
}

/** Receipts still derive only from verified canonical facts, in the effect transaction.
 * A manual batch can persist them together before committing or scheduling successors.
 */
export async function recordPlacementHistories(tx: DatabaseTransaction, actor: AutomationActor, serverUuid: string,
  placements: readonly Placement[]): Promise<{ id: string; inserted: boolean }[]> {
  if (!placements.length) return [];
  if (new Set(placements.map(p => p.runId)).size !== placements.length) throw new Error('Duplicate placement run in receipt batch');
  const inputs = placements.map(p => ({ run_id: p.runId, operation_id: p.operationId }));
  const facts = (await sql<Facts>`SELECT r.id AS run_id,r.rule_revision_id,f.operation_id,f.collection_id,f.node_id,
      f.occurred_at,f.facts_json,c.revision AS content_revision
    FROM jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb) AS i(run_id text,operation_id text)
    JOIN automation_runs r ON r.id=i.run_id AND r.owner_id=${actor.accountId}
    JOIN automation_event_facts f ON f.operation_id=i.operation_id
      AND r.explanation_json->>'collectionId'=f.collection_id AND r.explanation_json->>'nodeId'=f.node_id
    LEFT JOIN content_revisions c ON c.collection_id=f.collection_id AND c.ordinal=f.commit_ordinal`.execute(tx)).rows;
  if (facts.length !== placements.length || facts.some(f => !f.facts_json.after || !['create', 'move'].includes(f.facts_json.action)))
    throw new Error('Verified canonical placement facts required');
  const receipts = facts.map(f => {
    const before = f.facts_json.action === 'move' ? f.facts_json.before : null, after = f.facts_json.after!;
    const beforeFolder = before?.parentId ? { serverUuid, collectionId: f.collection_id, nodeId: before.parentId } : null;
    const digest = automationDigest({ kind: 'placement', runId: f.run_id, operationId: f.operation_id, ruleRevisionId: f.rule_revision_id,
      beforeFolder, beforeRevision: before?.resourceRevision ?? null, afterRevision: after.resourceRevision,
      afterParentId: after.parentId, afterContentRevision: f.content_revision });
    return { id: randomUUID(), run_id: f.run_id, operation_id: f.operation_id, before_folder: beforeFolder,
      before_revision: before?.resourceRevision ?? null, after_revision: after.resourceRevision!, effect_digest: digest,
      collection_id: f.collection_id, node_id: f.node_id, after_parent_id: after.parentId,
      after_content_revision: f.content_revision, created_at: f.occurred_at.toISOString() };
  });
  const inserted = (await sql<{ id: string; run_id: string }>`INSERT INTO automation_effect_receipts
    (id,run_id,job_id,step_id,target_partition,plan_id,operation_id,before_folder,before_revision,after_revision,effect_digest,
      collection_id,node_id,after_parent_id,after_content_revision,created_at)
    SELECT id,run_id,NULL,'intake','__m1__',NULL,operation_id,before_folder,before_revision,after_revision,effect_digest,
      collection_id,node_id,after_parent_id,after_content_revision,created_at
    FROM jsonb_to_recordset(${JSON.stringify(receipts)}::jsonb) AS i(id text,run_id text,operation_id text,before_folder jsonb,
      before_revision text,after_revision text,effect_digest text,collection_id text,node_id text,after_parent_id text,
      after_content_revision text,created_at timestamptz)
    ON CONFLICT (run_id,step_id,target_partition) DO NOTHING RETURNING id,run_id`.execute(tx)).rows;
  const results = new Map(inserted.map(row => [row.run_id, { id: row.id, inserted: true }]));
  if (inserted.length) {
    const waiting = (await sql`SELECT r.id FROM automation_rules r JOIN automation_rule_revisions v ON v.id=r.current_revision_id
      WHERE r.owner_id=${actor.accountId} AND r.desired_state='enabled' AND v.definition_json->>'on'='intake.completed'
        AND v.definition_json#>>'{trigger,mode}'='countBatch' LIMIT 1`.execute(tx)).rows;
    if (waiting.length) for (const collectionId of new Set(facts.filter(f => results.has(f.run_id)).map(f => f.collection_id)))
      await appendAutomationResume(tx, collectionId);
  }
  const replayed = placements.filter(p => !results.has(p.runId));
  if (replayed.length) {
    const existing = (await sql<{ id: string; run_id: string }>`SELECT id,run_id FROM automation_effect_receipts
      WHERE run_id IN (${sql.join(replayed.map(p => p.runId))}) AND step_id='intake' AND target_partition='__m1__'`.execute(tx)).rows;
    for (const row of existing) results.set(row.run_id, { id: row.id, inserted: false });
  }
  return placements.map(p => {
    const result = results.get(p.runId);
    if (!result) throw new Error('Canonical placement receipt missing after insert');
    return result;
  });
}
