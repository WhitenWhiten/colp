import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { SubmitResultInput } from '@know-n/colp/automation';
import { AutomationError } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { WorkJob } from './work-authority.js';
import { recordReportedCost } from './usage-store.js';

/** Only verified source/authority drift ends a valid submission. Transport failures remain resumable. */
export function rejectedInput(error: unknown): { state: 'stale' | 'review'; reason: string } | undefined {
  if (!(error instanceof AutomationError)) return;
  if (error.code === 'automation_stale_input') return { state: 'stale',reason: error.message };
  if (error.code === 'automation_binding_unavailable') return { state: 'review',reason: error.message };
}

export async function storeTypedResult(tx: DatabaseTransaction, job: WorkJob, input: SubmitResultInput,
  digest: string, authorityDigest: string, state: 'succeeded' | 'committing' | 'review' | 'stale', explanation?: string): Promise<string> {
  const resultId = randomUUID();
  await sql`INSERT INTO automation_results(id,job_id,generation,owner_id,input_digest,contract_id,authority_digest,output_json,proposal_digest,status)
    VALUES(${resultId},${job.id},${input.generation},${job.owner_id},${input.inputDigest},${input.outputContract},${authorityDigest},
      ${JSON.stringify(input.output)}::jsonb,${digest},${state === 'succeeded' ? 'accepted' : 'proposed'})`.execute(tx);
  await sql`UPDATE automation_jobs SET state=${state},result_id=${resultId},revision=revision+1,
    explanation=${explanation ?? (state === 'committing' ? 'Validated proposal awaiting canonical commit.'
      : state === 'succeeded' ? 'Accepted typed output; no canonical effect required.' : 'The typed proposal requires review.')} WHERE id=${job.id}`.execute(tx);
  await sql`UPDATE automation_job_attempts SET outcome='submitted',provider_request_ref=${input.providerRequestId ?? null}
    WHERE job_id=${job.id} AND generation=${input.generation}`.execute(tx);
  if (input.usageCostMicros !== undefined) await recordReportedCost(tx,job.id,input.generation,input.usageCostMicros);
  return resultId;
}
