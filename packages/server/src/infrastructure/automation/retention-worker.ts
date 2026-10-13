import { randomUUID } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
/** Bounded housekeeping. Source members, job inputs, result/effect and dedup identities are never purged here. */
export async function retainAutomationHistory(db: Kysely<DatabaseSchema>,ownerId: string, workerHistory = true): Promise<number> {
  return db.transaction().execute(async tx => {
    await tx.selectFrom('accounts').select('id').where('id','=',ownerId).forUpdate().executeTakeFirstOrThrow();
    await sql`DELETE FROM automation_preview_records WHERE id IN (SELECT id FROM automation_preview_records
      WHERE owner_id=${ownerId} AND expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100)`.execute(tx);
    if (!workerHistory) return 0;
    await sql`DELETE FROM automation_pairings WHERE id IN (SELECT id FROM automation_pairings
      WHERE owner_id=${ownerId} AND expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100)`.execute(tx);
    await sql`UPDATE automation_event_subscriptions SET previous_secret_ciphertext=NULL,previous_secret_until=NULL
      WHERE owner_id=${ownerId} AND previous_secret_until<=clock_timestamp()`.execute(tx);
    await sql`UPDATE automation_event_subscriptions SET state='expired',generation=generation+1,secret_ciphertext=NULL,previous_secret_ciphertext=NULL
      WHERE owner_id=${ownerId} AND refresh_before<=clock_timestamp() AND state IN ('active','verifying')`.execute(tx);
    const expired=(await sql<{ id:string;rule_id:string }>`SELECT d.id,v.rule_id FROM automation_event_deliveries d
      JOIN automation_runs r ON r.id=d.run_id JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
      WHERE d.owner_id=${ownerId} AND d.state IN ('pending','retrying','sending') AND d.created_at<clock_timestamp()-interval '7 days'
      ORDER BY d.created_at,d.id LIMIT 100 FOR UPDATE OF d`.execute(tx)).rows;
    for (const row of expired) {
      await sql`UPDATE automation_event_deliveries SET state='deadLetter',generation=generation+1,lease_until=NULL,
        next_attempt_at=NULL,last_error_code='retention_expired' WHERE id=${row.id}`.execute(tx);
      const id=randomUUID(),now=new Date().toISOString(),incident={ id,ruleId:row.rule_id,role:'delivery',code:'deliveryFailure',severity:'warning',state:'open',
        blockingStages:[],message:'Wake retention expired; durable job membership and inputs remain available for queue reconciliation.',firstSeenAt:now,lastSeenAt:now,dependencyRevision:row.id };
      await sql`INSERT INTO automation_incidents(id,owner_id,rule_id,dependency_key,code,revision,severity,state,incident_json)
        VALUES(${id},${ownerId},${row.rule_id},'delivery','deliveryFailure',${row.id},'warning','open',${JSON.stringify(incident)}::jsonb) ON CONFLICT DO NOTHING`.execute(tx);
    }
    return expired.length;
  });
}
