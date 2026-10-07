import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';

/** Fixed metric names only; no account, profile, URL, tag or command labels. */
export async function observeClassificationWork(db:Kysely<DatabaseSchema>,gauge:(name:string,value:number)=>void):Promise<void> {
  const result=await sql<{pending:string;running:string;overdue:string;oldest_seconds:number;calls:string;spent:string;probe_pending:string;probe_running:string;probe_overdue:string}>`
    SELECT count(*) FILTER(WHERE state='pending')::text AS pending,
      count(*) FILTER(WHERE state='running')::text AS running,
      count(*) FILTER(WHERE deadline_at<clock_timestamp())::text AS overdue,
      coalesce(extract(epoch FROM clock_timestamp()-min(created_at)),0)::float8 AS oldest_seconds,
      ((SELECT count(*) FROM classification_call_attempts WHERE state='dispatching')+(SELECT count(*) FROM classification_profile_tests WHERE state='dispatching'))::text AS calls,
      (SELECT count(*)::text FROM classification_profile_tests WHERE state='pending') AS probe_pending,
      (SELECT count(*)::text FROM classification_profile_tests WHERE state='dispatching') AS probe_running,
      (SELECT count(*)::text FROM classification_profile_tests WHERE state IN ('pending','dispatching') AND deadline_at<clock_timestamp()) AS probe_overdue,
      coalesce((SELECT spent_microusd::text FROM classification_spend_budgets
        WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND scope='global'),'0') AS spent
    FROM classification_provider_executions WHERE state IN ('pending','running')`.execute(db);
  const row=result.rows[0]!;
  for(const [name,value] of Object.entries(row))gauge(`classification.execution.${name}`,Number(value));
}
