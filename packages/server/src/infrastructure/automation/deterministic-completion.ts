import { sql } from 'kysely';
import { automationDigest, type TaskOutput } from '@know-n/colp/automation';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/** Canonical completion evidence is not an external call or a fabricated lease. */
export async function recordDeterministicCompletion(tx: DatabaseTransaction, input: {
  jobId: string; runId: string; nodeId: string; revision: string; parentId: string; sourceEventId: string;
}): Promise<void> {
  const effect = (await sql<{ id: string }>`SELECT id FROM automation_effect_receipts
    WHERE run_id=${input.runId} AND step_id='intake' AND after_revision=${input.revision}
    AND after_parent_id=${input.parentId} AND undone_operation_id IS NULL LIMIT 1`.execute(tx)).rows[0];
  const output: TaskOutput = {
    kind: 'placement', decision: 'keepParent', reason: 'Verified deterministic intake destination.',
    evidence: [{ kind: 'source', reference: input.sourceEventId, observedAt: new Date().toISOString() }],
  };
  const proof = { nodeId: input.nodeId, revision: input.revision, parentId: input.parentId,
    effectReceiptId: effect?.id ?? null, kind: effect ? 'canonicalPlacement' : 'verifiedNoop' };
  await sql`INSERT INTO automation_task_completions(job_id,id,digest,output_json,proof_json)
    VALUES(${input.jobId},${'deterministic-' + input.jobId},${automationDigest({ proof, output })},
      ${JSON.stringify(output)}::jsonb,${JSON.stringify(proof)}::jsonb) ON CONFLICT(job_id) DO NOTHING`.execute(tx);
}
