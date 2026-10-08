import {sql} from 'kysely';
import {ClassificationProviderError} from '../../modules/collections/index.js';
import type {DatabaseTransaction} from '../database/unit-of-work.js';
import {DEFAULT_CLASSIFICATION_PRICING} from './classification-pricing.js';
export const classificationBudgetScopes=(principalId:string,profile:string)=>['global',`profile:${profile}`,`account:${principalId}`] as const;
/** Shared by all preview/batch/auto calls and fixed credential probes. */
export async function reserveClassificationProviderCall(tx:DatabaseTransaction,principalId:string,profile:string,executionId:string){
  // The reserved amount and the settled amount must come from one place: the
  // attempt row stores what was reserved, and completeCall refunds the difference.
  const reservation=Number(DEFAULT_CLASSIFICATION_PRICING.reservationMicrousd);
  await sql`SET LOCAL lock_timeout='100ms'`.execute(tx);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('known:classification:provider-dispatch:v1',0))`.execute(tx);
  const counts=(await sql<{global:number;account:number;profile:number;execution:number}>`WITH active AS (
    SELECT e.principal_id,coalesce(e.input_json->'snapshot'->'providerBinding'->>'profileId',e.provider_id) AS profile,e.id
      FROM classification_call_attempts a JOIN classification_provider_executions e ON e.id=a.execution_id
      WHERE a.state='dispatching'
    UNION ALL SELECT principal_id,profile_id,id FROM classification_profile_tests WHERE state='dispatching'
  ) SELECT count(*)::int AS global,count(*) FILTER(WHERE principal_id=${principalId})::int AS account,
    count(*) FILTER(WHERE profile=${profile})::int AS profile,count(*) FILTER(WHERE id=${executionId})::int AS execution FROM active`.execute(tx)).rows[0]!;
  if(counts.global>=16||counts.account>=4||counts.profile>=4||counts.execution>=2)throw new ClassificationProviderError('budget_exhausted');
  for(const [scope,limit] of [[`global`,50_000_000],[`profile:${profile}`,20_000_000],[`account:${principalId}`,5_000_000]] as const){
    const result=await sql`INSERT INTO classification_spend_budgets(day,scope,spent_microusd) VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,${scope},${reservation})
      ON CONFLICT(day,scope) DO UPDATE SET spent_microusd=classification_spend_budgets.spent_microusd+${reservation}
      WHERE classification_spend_budgets.spent_microusd+${reservation}<=${limit} RETURNING scope`.execute(tx);
    if(!result.rows.length)throw new ClassificationProviderError('budget_exhausted');
  }
}
