import { randomUUID } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
/** Captured facts are private bookmark copies; inspected, unreferenced ones expire after this window. */
export const AUTOMATION_FACTS_RETENTION_DAYS = 30;
export const AUTOMATION_BUNDLE_RETENTION_DAYS = 30;

/**
 * Bounded housekeeping. Run members, job inputs, result/effect, batch members and matched dedup
 * identities are never purged here. Facts the cursor already passed that no run, receipt, batch or
 * effect references are deleted after the retention window, so deleted bookmarks' titles and URLs
 * do not persist indefinitely; a notMatched admission receipt is only a replay guard and expires with them.
 */
export async function retainAutomationHistory(db: Kysely<DatabaseSchema>,ownerId: string, workerHistory = true): Promise<number> {
  return db.transaction().execute(async tx => {
    const owner = await tx.selectFrom('accounts').select(['id','subject_id']).where('id','=',ownerId).forUpdate().executeTakeFirstOrThrow();
    const factExpired = sql`f.commit_ordinal<=p.last_inspected_ordinal AND f.root_run_id IS NULL
      AND f.occurred_at<clock_timestamp()-make_interval(days => ${AUTOMATION_FACTS_RETENTION_DAYS})`;
    const inspected = sql`automation_event_facts f JOIN collections c ON c.id=f.collection_id AND c.owner_subject_id=${owner.subject_id}
      JOIN automation_source_positions p ON p.owner_id=${ownerId} AND p.collection_id=f.collection_id`;
    await sql`DELETE FROM automation_admission_receipts a USING (SELECT a2.rule_revision_id,a2.source_event_id,a2.stage
      FROM automation_admission_receipts a2 JOIN ${inspected} ON f.source_event_id=a2.source_event_id
      WHERE a2.decision='notMatched' AND a2.run_id IS NULL AND ${factExpired} LIMIT 500) d
      WHERE a.rule_revision_id=d.rule_revision_id AND a.source_event_id=d.source_event_id AND a.stage=d.stage`.execute(tx);
    await sql`DELETE FROM automation_event_facts WHERE source_event_id IN (SELECT f.source_event_id FROM ${inspected}
      WHERE ${factExpired}
        AND NOT EXISTS (SELECT 1 FROM automation_admission_receipts a WHERE a.source_event_id=f.source_event_id)
        AND NOT EXISTS (SELECT 1 FROM automation_batch_members m WHERE m.source_event_id=f.source_event_id)
        AND NOT EXISTS (SELECT 1 FROM automation_intake_receipts i WHERE i.operation_id=f.operation_id)
        AND NOT EXISTS (SELECT 1 FROM automation_effect_receipts e WHERE e.operation_id=f.operation_id)
        AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.owner_id=${ownerId} AND r.member_ids ? f.source_event_id)
      ORDER BY f.collection_id,f.commit_ordinal LIMIT 500)`.execute(tx);
    await sql`DELETE FROM automation_preview_records WHERE id IN (SELECT id FROM automation_preview_records
      WHERE owner_id=${ownerId} AND expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100)`.execute(tx);
    // Receipt evidence outlives the polling cache. Keep every referenced snapshot and the latest
    // revision per device (including dormant devices) so later issuance never reuses a revision.
    await sql`DELETE FROM automation_device_bundles b USING (SELECT old.owner_id,old.device_id,old.revision
      FROM automation_device_bundles old WHERE old.owner_id=${ownerId}
        AND old.expires_at<clock_timestamp()-make_interval(days => ${AUTOMATION_BUNDLE_RETENTION_DAYS})
        AND EXISTS (SELECT 1 FROM automation_device_bundles newer WHERE newer.owner_id=old.owner_id
          AND newer.device_id=old.device_id AND newer.revision>old.revision)
        AND NOT EXISTS (SELECT 1 FROM automation_intake_receipts i WHERE i.owner_id=old.owner_id
          AND i.device_id=old.device_id AND i.receipt_json#>>'{input,bundleRevision}'=old.revision::text)
      ORDER BY old.expires_at,old.device_id,old.revision LIMIT 500) expired
      WHERE b.owner_id=expired.owner_id AND b.device_id=expired.device_id AND b.revision=expired.revision`.execute(tx);
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
