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
    await lockPlacementCollection(tx, actor, row.collection_id);
    const view = row.plan_id ? await planEffectView(tx,actor,row) : await placementEffectView(tx, actor, row);
    if (!view.undoAvailable || !row.before_folder) throw new AutomationError('automation_stale_input', view.undoReason);
    const moved = await canonicalPlacementMove(tx, actor, { collectionId: row.collection_id, nodeId: row.node_id,
      parentId: row.before_folder.nodeId, expectedRevision: row.after_revision, runId, stage: 'undo' });
    await sql`UPDATE automation_effect_receipts SET undone_operation_id=${moved.operationId} WHERE id=${row.id}`.execute(tx);
    await sql`UPDATE automation_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE id=${runId}`.execute(tx);
    return { id: moved.operationId, status: 'completed', resourceId: runId, diagnostics: [{ code: 'placementReverted', severity: 'info',
      location: '/', message: 'Moved this bookmark back to its verified original folder; the bookmark was retained.' }] };
  } };
}
