import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
/** Reuse retains original result evidence, while this run gets its own unread identity. */
export async function persistReusedRunOutput(tx:DatabaseTransaction,resultId:string,jobId:string):Promise<void>{
  const inserted=(await sql<{run_id:string}>`INSERT INTO automation_run_outputs(id,result_id,run_id,job_id,target_id,output_json)
    SELECT ${randomUUID()},a.id,j.run_id,j.id,j.target_id,a.output_json FROM automation_results a JOIN automation_jobs j ON j.id=${jobId}
    WHERE a.id=${resultId} AND a.owner_id=(SELECT owner_id FROM automation_runs WHERE id=j.run_id)
    AND a.authority_digest=j.authority_digest AND a.input_digest=j.input_digest AND a.contract_id=j.contract_id AND a.status='accepted' AND a.output_json->>'kind'='text' AND a.output_json->>'textType' IN ('digest','review')
    ON CONFLICT(job_id) DO NOTHING RETURNING run_id`.execute(tx)).rows[0];
  if(inserted)await sql`UPDATE automation_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE id=${inserted.run_id}`.execute(tx);
}
