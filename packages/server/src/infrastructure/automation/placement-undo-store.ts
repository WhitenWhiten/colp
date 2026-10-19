import { undoPlanField } from './plan-field-undo.js';
import { planEffectView } from './plan-effect-view.js';
import { sql } from 'kysely';
import { AutomationError, type AutomationActor, type PlacementUndoPort } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { canonicalPlacementMove, lockPlacementCollection } from './canonical-placement.js';
import { placementEffectView, type PlacementEffectRow } from './placement-history-store.js';
export function createPlacementUndoPort(tx: DatabaseTransaction, actor: AutomationActor): PlacementUndoPort {
  return { async undo(runId, input) {
    const row = (await sql<PlacementEffectRow>`SELECT e.* FROM automation_effect_receipts e JOIN automation_runs r ON r.id=e.run_id
      WHERE e.id=${input.effectReceiptId} AND r.id=${runId} AND r.owner_id=${actor.accountId} FOR UPDATE OF e`.execute(tx)).rows[0];
    if (!row?.collection_id || !row.node_id || row.effect_digest !== input.expectedEffectDigest)
      throw new AutomationError('automation_stale_input', 'Verified M1 effect is unavailable.');
    if (row.undone_operation_id) return { id: row.undone_operation_id, status: 'completed', resourceId: runId, diagnostics: [] };
    await lockPlacementCollection(tx, actor, row.collection_id);
    const view = row.plan_id ? await planEffectView(tx,actor,row) : await placementEffectView(tx, actor, row);
    if (!view.undoAvailable) throw new AutomationError('automation_stale_input', view.undoReason);
    const operationId = row.before_folder ? (await canonicalPlacementMove(tx, actor, {
      collectionId: row.collection_id, nodeId: row.node_id, parentId: row.before_folder.nodeId,
      expectedRevision: row.after_revision, runId, stage: 'undo' })).operationId : await undoPlanField(tx, actor, row);
    await sql`UPDATE automation_effect_receipts SET undone_operation_id=${operationId} WHERE id=${row.id}`.execute(tx);
    await sql`UPDATE automation_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE id=${runId}`.execute(tx);
    return { id: operationId, status: 'completed', resourceId: runId, diagnostics: [{ code: row.before_folder ? 'placementReverted' : 'effectReverted', severity: 'info',
      location: '/', message: 'Reverted this effect under its verified resource and content revisions.' }] };
  } };
}
