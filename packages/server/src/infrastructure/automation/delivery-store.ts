import { sql } from 'kysely';
import type { DeliveryView } from '@know-n/colp/automation';
import { AutomationError,type AutomationActor } from '../../modules/automation/index.js';
import type { OwnerDeliveryStore } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
interface Row { id: string; run_id: string; job_id: string; target_id: string; subscription_id: string; state: DeliveryView['state'];
  attempt_count: number; next_attempt_at: Date | null; last_error_code: string | null; sort_created_at: string }
const view = (r: Row): DeliveryView => ({ id:r.id,runId:r.run_id,jobId:r.job_id,targetId:r.target_id,subscriptionId:r.subscription_id,
  state:r.state,attemptCount:r.attempt_count,nextAttemptAt:r.next_attempt_at?.toISOString() ?? null,lastErrorCode:r.last_error_code });
export function createOwnerDeliveryStore(tx: DatabaseTransaction,actor: AutomationActor): OwnerDeliveryStore {
  const visible=sql`FROM automation_event_deliveries d JOIN automation_runs r ON r.id=d.run_id
    JOIN collections c ON c.id=r.explanation_json->>'collectionId'
    WHERE d.owner_id=${actor.accountId} AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL`;
  return {
    async list(after,limit) {
      const rows=(await sql<Row>`SELECT d.*,to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
        ${visible} ${after ? sql`AND (d.created_at,d.id)>(${after.createdAt}::timestamptz,${after.id})` : sql``}
        ORDER BY d.created_at,d.id LIMIT ${limit}`.execute(tx)).rows;
      return rows.map(r => ({ view:view(r),createdAt:r.sort_created_at }));
    },
    async retry(id) {
      const row=(await sql<Row>`SELECT d.* ${visible} AND d.id=${id} FOR UPDATE OF d`.execute(tx)).rows[0];
      if (!row) throw new AutomationError('resource_not_found','Delivery unavailable.');
      if (row.state==='accepted' || row.state==='pending' || row.state==='retrying') return view(row);
      if (row.state!=='deadLetter' || ['payload_too_large','subscription_gone','retention_expired'].includes(row.last_error_code ?? ''))
        throw new AutomationError('automation_command_conflict','This delivery cannot be retried.');
      const allowed=(await sql`SELECT s.id FROM automation_event_subscriptions s JOIN automation_targets t ON t.id=s.target_id
        JOIN automation_connection_profiles p ON p.id=s.profile_id JOIN automation_jobs j ON j.id=${row.job_id}
        JOIN automation_runs r ON r.id=j.run_id LEFT JOIN automation_settings a ON a.owner_id=r.owner_id
        WHERE s.id=${row.subscription_id} AND s.state='active' AND s.refresh_before>clock_timestamp()
        AND s.pairing_generation=t.pairing_generation AND s.profile_revision=p.revision AND t.paired AND NOT t.revoked
        AND coalesce(t.configuration_json->>'wakeMode','events')='events' AND j.state='ready' AND NOT r.held
        AND r.state<>'cancelled' AND NOT coalesce(a.paused,false)`.execute(tx)).rows[0];
      if (!allowed) throw new AutomationError('automation_command_conflict','Current delivery path is unavailable.');
      const updated=(await sql<Row>`UPDATE automation_event_deliveries SET state='retrying',generation=generation+1,
        next_attempt_at=clock_timestamp(),last_error_code=NULL WHERE id=${id} RETURNING *`.execute(tx)).rows[0]!;
      return view(updated);
    },
  };
}
