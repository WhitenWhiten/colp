import { sql, type Kysely } from 'kysely';
import { AutomationError, type ApprovedProposalApplier, type WorkPrincipal } from '../../modules/automation/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { PinnedProposal } from './proposal-plan-gateway.js';
import type { createResultSubmissionPort } from './result-store.js';
import { advanceRunTasks } from './task-scheduler.js';

type Results = Pick<ReturnType<typeof createResultSubmissionPort>, 'reconcile'>;
type Row = PinnedProposal & { run_id: string; subject_id: string };

/** Worker authority, not just a live token: these codes mean the pinned worker can no longer be trusted. */
const AUTHORITY_LOST = new Set(['resource_not_found', 'insufficient_permission', 'automation_binding_unavailable']);

/**
 * "The server applies results" (design 04): after the Owner approves the exact proposal, the server
 * commits the same pinned plan with the proposal's pinned worker binding. A worker that went away,
 * lost its journal or was revoked cannot strand the job or its run: revocation turns the job into
 * review, an expired or cancelled plan becomes review through the normal reconcile path, and transient
 * failures stay for the next sweep.
 */
export function createApprovedProposalApplier(db: Kysely<DatabaseSchema>, serverUuid: string, results: Results): ApprovedProposalApplier {
  async function load(ownerId: string, jobId: string): Promise<Row | undefined> {
    return (await sql<Row>`SELECT p.*,j.run_id,a.subject_id FROM automation_proposals p
      JOIN automation_jobs j ON j.id=p.job_id JOIN automation_runs r ON r.id=j.run_id JOIN accounts a ON a.id=r.owner_id
      WHERE p.job_id=${jobId} AND r.owner_id=${ownerId} AND j.state IN ('committing','awaitingApproval')`.execute(db)).rows[0];
  }
  async function retainForReview(row: Row, ownerId: string): Promise<void> {
    await db.transaction().execute(async tx => {
      const changed = await sql`UPDATE automation_jobs SET state='review',revision=revision+1,
        explanation='The worker that produced this proposal is no longer authorized; the approved proposal is retained for review.'
        WHERE id=${row.job_id} AND state IN ('committing','awaitingApproval') RETURNING id`.execute(tx);
      if (changed.rows.length) await advanceRunTasks(tx, { accountId: ownerId, subjectId: row.subject_id }, serverUuid, row.run_id);
    });
  }
  async function apply(ownerId: string, jobId: string): Promise<void> {
    const row = await load(ownerId, jobId);
    if (!row) return;
    const binding = row.binding_json;
    const actor: WorkPrincipal = { accountId: binding.principalId, subjectId: row.subject_id, clientId: binding.clientId,
      credentialBindingId: binding.credentialBindingId, scopes: ['automation:work'], resourceAudience: binding.resourceAudience,
      securityEpoch: binding.securityEpoch };
    try {
      await results.reconcile(actor, jobId, { serverApply: true });
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      if (AUTHORITY_LOST.has(error.code)) await retainForReview(row, ownerId);
      // Pause, rate limits and unknown commit outcomes keep the same plan for the next sweep.
    }
  }
  return {
    apply,
    async sweep(ownerId) {
      const due = (await sql<{ job_id: string }>`SELECT p.job_id FROM automation_proposals p
        JOIN automation_jobs j ON j.id=p.job_id JOIN automation_runs r ON r.id=j.run_id
        JOIN mcp_change_plans m ON m.plan_id=p.plan_id
        WHERE r.owner_id=${ownerId} AND j.state IN ('committing','awaitingApproval')
          AND (m.status IN ('approved','committing','consumed','cancelled','expired') OR m.expires_at<=clock_timestamp())
        ORDER BY p.created_at,p.job_id LIMIT 20`.execute(db)).rows;
      for (const { job_id } of due) await apply(ownerId, job_id);
      return due.length;
    },
  };
}
