import { sql, type Kysely } from 'kysely';
import { AgentPlanUndoError } from '../../modules/mcp/index.js';
import { AutomationError } from '../../modules/automation/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { createPlacementUndoPort } from './placement-undo-store.js';

/** Automation plans use their effect compensation on every entry point, never a structural snapshot restore. */
export async function undoAutomationApproval(db: Kysely<DatabaseSchema>, input: {
  readonly accountId: string; readonly subjectId: string; readonly planId: string;
}): Promise<{ noop: boolean } | undefined> {
  return createUnitOfWork(db).execute(async ({ transaction }) => {
    const row = (await sql<{ run_id: string; id: string | null; effect_digest: string | null; undone_operation_id: string | null }>`
      SELECT r.id AS run_id,e.id,e.effect_digest,e.undone_operation_id FROM automation_proposals p
      JOIN automation_jobs j ON j.id=p.job_id JOIN automation_runs r ON r.id=j.run_id
      LEFT JOIN automation_effect_receipts e ON e.plan_id=p.plan_id
      WHERE p.plan_id=${input.planId} AND r.owner_id=${input.accountId}`.execute(transaction)).rows[0];
    if (!row) return undefined;
    if (!row.id || !row.effect_digest) throw new AgentPlanUndoError('not_found', 'The automation effect is not yet available for Undo.');
    if (row.undone_operation_id) return { noop: true };
    try {
      await createPlacementUndoPort(transaction, input).undo(row.run_id, {
        effectReceiptId: row.id, expectedEffectDigest: row.effect_digest, reason: 'Owner undid the approved automation effect',
      });
    } catch (error) {
      if (error instanceof AutomationError) throw new AgentPlanUndoError('newer_changes', error.message);
      throw error;
    }
    return { noop: false };
  });
}
