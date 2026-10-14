import { sql } from 'kysely';
import type { RuleDefinition, RoleBindings } from '@know-n/colp/automation';
import { AutomationError, resolveBindings, assessIntakeBindings, inspectionBindingReads, type AutomationActor } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { withCanonicalTreeCapacityBatch } from '../collections/index.js';
import { createBindingReadPort } from './bindings.js';
import { lockPlacementCollection, placementMoveInput, canonicalPlacementMove, canonicalPlacementMoveBatch } from './canonical-placement.js';
import { recordPlacementHistories } from './placement-history-store.js';
import { initializeRunTasks, advanceRunTasks } from './task-scheduler.js';
import type { ManualSnapshot } from './manual-preview-store.js';

export const MANUAL_CHUNK_SIZE = 10;
export interface ManualPendingRun {
  id: string; state: string; held: boolean; collection_id: string; run_tasks: boolean;
  definition_json: RuleDefinition; values_json: RoleBindings;
}
interface Child {
  id: string; explanation_json: { nodeId: string; sourceRevision: string; plan: ManualSnapshot['members'][number]['plan'] };
}

/** One slice of the fixed admission, with its effects and progress in one commit. */
export async function executeManualChunk(tx: DatabaseTransaction, actor: AutomationActor, serverUuid: string, parent: ManualPendingRun) {
  const children = (await sql<Child>`SELECT id,explanation_json FROM automation_runs
    WHERE owner_id=${actor.accountId} AND kind='manual' AND explanation_json->>'parentRunId'=${parent.id}
      AND explanation_json->>'manualPending'='true' AND state='waiting' AND NOT held
    ORDER BY (explanation_json->>'manualIndex')::integer,id LIMIT ${parent.run_tasks ? 1 : MANUAL_CHUNK_SIZE}
    FOR UPDATE`.execute(tx)).rows;
  if (!children.length) return finishManualProgress(tx, parent.id);
  try { await lockPlacementCollection(tx, actor, parent.collection_id); }
  catch (error) {
    if (!(error instanceof AutomationError) || error.code !== 'resource_not_found') throw error;
    await stopManualPending(tx, parent.id, 'Current collection authority is unavailable; completed effects were retained.');
    return false;
  }
  const reads = inspectionBindingReads(createBindingReadPort(tx, serverUuid));
  const resolutions = await resolveBindings(reads, actor, parent.definition_json, parent.values_json);
  const bindings = assessIntakeBindings(parent.definition_json, resolutions);
  const destination = resolutions[parent.definition_json.intake?.folderRole ?? ''];
  const nodes = await tx.selectFrom('nodes').select(['id', 'kind', 'parent_id', 'resource_revision', 'deleted_at'])
    .where('collection_id', '=', parent.collection_id).where('id', 'in', children.map(c => c.explanation_json.nodeId)).execute();
  const current = new Map(nodes.map(node => [node.id, node]));
  const rejected: { id: string; reason: string }[] = [];
  const valid = children.filter(child => {
    const e = child.explanation_json, node = current.get(e.nodeId);
    const reason = !node || node.kind !== 'bookmark' || node.deleted_at || node.resource_revision !== e.sourceRevision
      ? 'Bookmark changed or became unavailable after admission; no new effect was written.'
      : (!bindings.available && (e.plan.kind === 'placed' || parent.run_tasks))
        || (e.plan.kind === 'placed' && (destination?.status !== 'valid' || destination.snapshot.folder.nodeId !== e.plan.folder.nodeId))
        ? 'Pinned destination or binding is no longer available; no new effect was written.' : null;
    if (reason) rejected.push({ id: child.id, reason });
    return !reason;
  });
  let processed = valid;
  await withCanonicalTreeCapacityBatch(tx, parent.collection_id, async admission => {
    const moves = valid.flatMap(child => {
      const e = child.explanation_json;
      return e.plan.kind === 'placed' && current.get(e.nodeId)!.parent_id !== e.plan.folder.nodeId
        ? [{ runId: child.id, input: placementMoveInput(actor, { collectionId: parent.collection_id,
          nodeId: e.nodeId, parentId: e.plan.folder.nodeId, expectedRevision: e.sourceRevision, runId: child.id, stage: 'intake' }) }] : [];
    });
    const effects: { runId: string; operationId: string }[] = [];
    if (await canonicalPlacementMoveBatch(tx, parent.collection_id, moves.map(move => move.input), admission)) {
      effects.push(...moves.map(move => ({ runId: move.runId, operationId: move.input.operationId })));
    } else if (moves[0]) {
      // Rebalance may revise later members. Commit just this move; subsequent
      // slices recheck every remaining revision rather than silently rebasing it.
      const first = moves[0], input = first.input.mutation;
      const result = await canonicalPlacementMove(tx, actor, { collectionId: parent.collection_id,
        nodeId: input.target.resourceId, parentId: input.parentId!, expectedRevision: input.expectedResourceRevision!,
        runId: first.runId, stage: 'intake' }, admission);
      effects.push({ runId: first.runId, operationId: result.operationId });
      const deferred = new Set(moves.slice(1).map(move => move.runId));
      processed = valid.filter(child => !deferred.has(child.id));
    }
    await recordPlacementHistories(tx, actor, serverUuid, effects);
  });
  const updates = [...processed.map(child => ({ id: child.id, state: 'completed',
    explanation: 'Fixed manual member processed; any committed placement is retained and can be undone.' })),
  ...rejected.map(child => ({ id: child.id, state: 'review', explanation: child.reason }))];
  if (updates.length) await sql`UPDATE automation_runs r SET state=i.state,revision=revision+1,updated_at=clock_timestamp(),
    explanation_json=explanation_json || jsonb_build_object('manualPending',false,'explanation',i.explanation)
    FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS i(id text,state text,explanation text)
    WHERE r.id=i.id AND r.owner_id=${actor.accountId}`.execute(tx);
  // Receipts and completed intake precede immutable worker input pinning.
  if (parent.run_tasks) for (const child of processed) {
    await initializeRunTasks(tx, actor, child.id);
    await advanceRunTasks(tx, actor, serverUuid, child.id);
  }
  return finishManualProgress(tx, parent.id);
}

export async function finishManualProgress(tx: DatabaseTransaction, parentId: string): Promise<boolean> {
  const counts = (await sql<{ total: number; remaining: number; review: number }>`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE explanation_json->>'manualPending'='true' AND state='waiting')::int AS remaining,
    count(*) FILTER(WHERE state IN ('review','blocked','failed','cancelled'))::int AS review
    FROM automation_runs WHERE kind='manual' AND explanation_json->>'parentRunId'=${parentId}`.execute(tx)).rows[0]!;
  const pending = counts.remaining > 0;
  const explanation = `Processed ${counts.total - counts.remaining} of ${counts.total} fixed members; ${counts.review} need review or were cancelled. Completed effects are retained.`;
  await sql`UPDATE automation_runs SET state=${pending ? 'running' : counts.review ? 'partial' : 'completed'},
    revision=revision+1,updated_at=clock_timestamp(),
    explanation_json=explanation_json || ${JSON.stringify({ manualPending: pending, explanation })}::jsonb
    WHERE id=${parentId} AND state<>'cancelled'`.execute(tx);
  return pending;
}

export async function stopManualPending(tx: DatabaseTransaction, parentId: string, reason: string) {
  await sql`UPDATE automation_runs SET state='review',revision=revision+1,updated_at=clock_timestamp(),
    explanation_json=explanation_json || ${JSON.stringify({ manualPending: false, explanation: reason })}::jsonb
    WHERE kind='manual' AND explanation_json->>'parentRunId'=${parentId}
      AND explanation_json->>'manualPending'='true' AND state='waiting'`.execute(tx);
  await finishManualProgress(tx, parentId);
}
