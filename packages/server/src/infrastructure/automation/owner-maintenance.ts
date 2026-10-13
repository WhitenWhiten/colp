import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { reconcileRunsPlanEffects } from './reconcile-plan-effect.js';
import { expireOwnerLeases } from './worker-inputs.js';

/**
 * Converges what Owner and run reads must not write: expired worker leases become uncertain, and plans
 * that committed without their effect receipt (an interrupted reconcile) get it. Bounded per sweep.
 */
export async function convergeOwnerWork(db: Kysely<DatabaseSchema>, ownerId: string, serverUuid: string): Promise<void> {
  await db.transaction().execute(async tx => {
    const account = await tx.selectFrom('accounts').select(['id', 'subject_id']).where('id', '=', ownerId).forUpdate().executeTakeFirst();
    if (!account) return;
    await expireOwnerLeases(tx, ownerId);
    const runs = (await sql<{ run_id: string }>`SELECT DISTINCT j.run_id FROM automation_jobs j JOIN automation_runs r ON r.id=j.run_id
      JOIN automation_proposals p ON p.job_id=j.id JOIN mcp_change_plans m ON m.plan_id=p.plan_id AND m.status='consumed'
      WHERE r.owner_id=${ownerId} AND NOT EXISTS (SELECT 1 FROM automation_effect_receipts e WHERE e.job_id=j.id)
      ORDER BY j.run_id LIMIT 20`.execute(tx)).rows;
    await reconcileRunsPlanEffects(tx, { accountId: ownerId, subjectId: account.subject_id }, runs.map(run => run.run_id), serverUuid);
  });
}
