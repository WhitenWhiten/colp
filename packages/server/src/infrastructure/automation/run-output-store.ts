import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { RunOutputView } from '@know-n/colp/automation';
import { AutomationError,parseContract,requireEtag,type AutomationActor } from '../../modules/automation/index.js';
import type { RunOutputStore } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
interface Row {id:string;job_id:string;target_id:string;output_json:RunOutputView['output'];created_at:Date;sort_created_at:string}
export function createRunOutputStore(tx:DatabaseTransaction,actor:AutomationActor):RunOutputStore {
  async function authorize(runId:string){
    const run=(await sql<{revision:string;collection_id:string}>`SELECT r.revision::text,r.explanation_json->>'collectionId' AS collection_id FROM automation_runs r
      JOIN collections c ON c.id=r.explanation_json->>'collectionId' WHERE r.id=${runId} AND r.owner_id=${actor.accountId}
      AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL FOR UPDATE OF r`.execute(tx)).rows[0];
    if(!run)throw new AutomationError('resource_not_found','Run outputs unavailable under current Owner authority.');
    const missing=(await sql`SELECT 1 FROM automation_jobs j CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.input_json,'[]')) i
      LEFT JOIN nodes n ON n.id=i->'node'->>'nodeId' AND n.collection_id=${run.collection_id}
      WHERE j.run_id=${runId} AND (n.id IS NULL OR n.deleted_at IS NOT NULL) LIMIT 1`.execute(tx)).rows;
    if(missing.length)throw new AutomationError('resource_not_found','Source content is unavailable; output text is withheld.');
    return run;
  }
  return {authorize:async id=>{await authorize(id);},async list(runId,after,limit){
    await authorize(runId);
    const rows=(await sql<Row>`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
      FROM automation_run_outputs WHERE run_id=${runId} ${after?sql`AND (created_at,id)>(${after.createdAt}::timestamptz,${after.id})`:sql``}
      ORDER BY created_at,id LIMIT ${limit}`.execute(tx)).rows;
    return rows.map(row=>({createdAt:row.sort_created_at,view:{id:row.id,jobId:row.job_id,targetId:row.target_id,output:row.output_json,createdAt:row.sort_created_at}}));
  },async markRead(runId,body,ifMatch){
    const input=parseContract('MarkRunReadInput',body),run=await authorize(runId);requireEtag(run.revision,ifMatch);
    const output=(await sql<{created_at:Date;sort_created_at:string}>`SELECT created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
      FROM automation_run_outputs WHERE id=${input.throughOutputId} AND run_id=${runId}`.execute(tx)).rows[0];
    if(!output)throw new AutomationError('resource_not_found','Selected output is unavailable in this run.');
    const changed=(await sql`INSERT INTO automation_run_reads(owner_id,run_id,through_created_at,through_output_id)
      VALUES(${actor.accountId},${runId},${output.sort_created_at}::timestamptz,${input.throughOutputId})
      ON CONFLICT(owner_id,run_id) DO UPDATE SET through_created_at=EXCLUDED.through_created_at,through_output_id=EXCLUDED.through_output_id
      WHERE (automation_run_reads.through_created_at,automation_run_reads.through_output_id)<(EXCLUDED.through_created_at,EXCLUDED.through_output_id) RETURNING run_id`.execute(tx)).rows;
    if(changed.length)await sql`UPDATE automation_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE id=${runId}`.execute(tx);
    return {receipt:{id:randomUUID(),status:'completed',resourceId:runId,diagnostics:[]},revision:String(BigInt(run.revision)+(changed.length?1n:0n))};
  }};
}
