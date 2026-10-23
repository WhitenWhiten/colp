import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { RunOutputView } from '@know-n/colp/automation';
import { AutomationError, parseContract, requireEtag, type AutomationActor } from '../../modules/automation/index.js';
import type { RunOutputStore } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

interface Row { id: string; job_id: string; target_id: string; output_json: RunOutputView['output']; created_at: Date; sort_created_at: string }

/**
 * Output text derived from a bookmark that is gone stays withheld, but only that job's output: one deleted
 * batch member must not hide every other output of the run. `o` is automation_run_outputs, `r` its run.
 */
export const OUTPUT_SOURCE_AVAILABLE = sql`NOT EXISTS (SELECT 1 FROM automation_jobs sj CROSS JOIN LATERAL jsonb_array_elements(coalesce(sj.input_json,'[]')) si
  LEFT JOIN nodes sn ON sn.id=si->'node'->>'nodeId' AND sn.collection_id=r.explanation_json->>'collectionId'
  WHERE sj.id=o.job_id AND (sn.id IS NULL OR sn.deleted_at IS NOT NULL))`;

export function createRunOutputStore(tx: DatabaseTransaction, actor: AutomationActor): RunOutputStore {
  async function authorize(runId: string) {
    const run = (await sql<{ revision: string }>`SELECT r.revision::text FROM automation_runs r
      JOIN collections c ON c.id=r.explanation_json->>'collectionId' WHERE r.id=${runId} AND r.owner_id=${actor.accountId}
      AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL FOR UPDATE OF r`.execute(tx)).rows[0];
    if (!run) throw new AutomationError('resource_not_found', 'Run outputs unavailable under current Owner authority.');
    return run;
  }
  return {
    async authorize(id) {
      await authorize(id);
    },
    async list(runId, after, limit) {
      await authorize(runId);
      const cursor = after ? sql`AND (o.created_at,o.id)>(${after.createdAt}::timestamptz,${after.id})` : sql``;
      const rows = (await sql<Row>`SELECT o.*,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
        FROM automation_run_outputs o JOIN automation_runs r ON r.id=o.run_id
        WHERE o.run_id=${runId} AND ${OUTPUT_SOURCE_AVAILABLE} ${cursor}
        ORDER BY o.created_at,o.id LIMIT ${limit}`.execute(tx)).rows;
      return rows.map((row) => ({ createdAt: row.sort_created_at,
        view: { id: row.id, jobId: row.job_id, targetId: row.target_id, output: row.output_json, createdAt: row.sort_created_at } }));
    },
    async markRead(runId, body, ifMatch) {
      const input = parseContract('MarkRunReadInput', body);
      const run = await authorize(runId);
      requireEtag(run.revision, ifMatch);
      const output = (await sql<{ sort_created_at: string }>`SELECT to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
        FROM automation_run_outputs o JOIN automation_runs r ON r.id=o.run_id
        WHERE o.id=${input.throughOutputId} AND o.run_id=${runId} AND ${OUTPUT_SOURCE_AVAILABLE}`.execute(tx)).rows[0];
      if (!output) throw new AutomationError('resource_not_found', 'Selected output is unavailable in this run.');
      // The watermark only moves forward; a concurrent later read keeps its position.
      const changed = (await sql`INSERT INTO automation_run_reads(owner_id,run_id,through_created_at,through_output_id)
        VALUES(${actor.accountId},${runId},${output.sort_created_at}::timestamptz,${input.throughOutputId})
        ON CONFLICT(owner_id,run_id) DO UPDATE SET through_created_at=EXCLUDED.through_created_at,through_output_id=EXCLUDED.through_output_id
        WHERE (automation_run_reads.through_created_at,automation_run_reads.through_output_id)<(EXCLUDED.through_created_at,EXCLUDED.through_output_id)
        RETURNING run_id`.execute(tx)).rows;
      if (changed.length) {
        await sql`UPDATE automation_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE id=${runId}`.execute(tx);
        await sql`UPDATE activity_items SET read_at=clock_timestamp(),revision=revision+1
          WHERE run_id=${runId} AND account_id=${actor.accountId} AND read_at IS NULL`.execute(tx);
      }
      return { receipt: { id: randomUUID(), status: 'completed', resourceId: runId, diagnostics: [] },
        revision: String(BigInt(run.revision) + (changed.length ? 1n : 0n)) };
    },
  };
}
