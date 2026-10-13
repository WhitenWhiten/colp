import { randomUUID } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import { MCP_AUTOMATION_EVENT,MCP_AUTOMATION_EVENT_DESCRIPTOR } from '@know-n/colp/mcp';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { AutomationError,type WorkPrincipal } from '../../modules/automation/index.js';
import type { TargetAuthority } from './work-authority.js';
import { lockWorkJob } from './work-authority.js';
import { signWebhook } from './webhook-signer.js';
interface Delivery { ready_generation: string; id: string; owner_id: string; job_id: string; target_id: string; subscription_id: string;
  subscription_generation: string; generation: string; body: string; attempt_count: number }
interface Destination { callback_url: string; secret_ciphertext: string; previous_secret_ciphertext: string | null;
  previous_secret_until: Date | null; observation_json: WorkPrincipal }
export interface DeliveryTransport {
  decrypt(value: string,id: string): string;
  send(url: string,body: string,headers: Record<string,string>): Promise<{ status: number; retryAfter: string | null }>;
}
export function deliveryRetryDelay(attempt: number,retryAfter: string | null,now = Date.now(),random = Math.random()): number {
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter)*1000 : retryAfter ? Date.parse(retryAfter)-now : 0;
  return Math.min(3_600_000,Math.max(1000,Number.isFinite(seconds) ? seconds : 0,Math.min(900_000,1000*2**Math.min(attempt,10))*(0.5+random/2)));
}
/** A bounded one-occurrence tick. Network I/O never holds database locks. */
export function createDeliveryWorker(db: Kysely<DatabaseSchema>,authorize: TargetAuthority,transport: DeliveryTransport) {
  async function destination(tx: DatabaseTransaction,d: Delivery,completion = false): Promise<Destination | null> {
    const row = (await sql<Destination>`SELECT s.callback_url,s.secret_ciphertext,CASE WHEN s.previous_secret_until>clock_timestamp() THEN s.previous_secret_ciphertext END AS previous_secret_ciphertext,s.previous_secret_until,p.observation_json
      FROM automation_event_subscriptions s JOIN automation_targets t ON t.id=s.target_id JOIN automation_connection_profiles p ON p.id=s.profile_id
      WHERE s.id=${d.subscription_id} AND s.generation=${String(d.subscription_generation)}::bigint AND s.state='active'
      AND s.refresh_before>clock_timestamp() AND s.secret_ciphertext IS NOT NULL AND p.observation_json IS NOT NULL
      AND s.profile_revision=p.revision AND s.pairing_generation=t.pairing_generation
      AND t.paired AND NOT t.revoked AND coalesce(t.configuration_json->>'wakeMode','events')='events'`.execute(tx)).rows[0];
    if (!row) return null;
    try {
      const job = await lockWorkJob(tx,row.observation_json,d.job_id,authorize);
      return String(job.ready_generation) === String(d.ready_generation)
        && (completion || job.state === 'ready') && job.target_id === d.target_id ? row : null;
    } catch (error) { if (error instanceof AutomationError && error.code !== 'automation_paused') return null;throw error; }
  }
  async function cancel(tx: DatabaseTransaction,d: Delivery) {
    await sql`UPDATE automation_event_deliveries SET state='cancelled',generation=generation+1,lease_until=NULL,next_attempt_at=NULL
      WHERE id=${d.id} AND generation=${String(d.generation)}::bigint`.execute(tx);
  }
  return {
    async nextRecipient(excludedOwners: readonly string[],after: string): Promise<{ownerId:string;targetId:string}|null> {
      const row=(await sql<{owner_id:string;target_id:string}>`SELECT d.owner_id,d.target_id FROM automation_event_deliveries d
        LEFT JOIN automation_settings a ON a.owner_id=d.owner_id
        WHERE NOT coalesce(a.paused,false) AND ((d.state IN ('pending','retrying') AND d.next_attempt_at<=clock_timestamp())
          OR (d.state='sending' AND d.lease_until<clock_timestamp()))
        ${excludedOwners.length ? sql`AND d.owner_id NOT IN (${sql.join(excludedOwners)})` : sql``}
        ORDER BY (d.owner_id||':'||d.target_id<=${after}),d.owner_id,d.target_id,d.next_attempt_at,d.id LIMIT 1`.execute(db)).rows[0];
      return row ? {ownerId:row.owner_id,targetId:row.target_id} : null;
    },
    async tick(targetId?: string): Promise<boolean> {
    // Candidate selection is optimistic; account lock precedes delivery/job locks consistently.
    const candidate = (await sql<Delivery>`SELECT d.* FROM automation_event_deliveries d
      LEFT JOIN automation_settings a ON a.owner_id=d.owner_id
      WHERE NOT coalesce(a.paused,false) AND ((d.state IN ('pending','retrying') AND d.next_attempt_at<=clock_timestamp())
        OR (d.state='sending' AND d.lease_until<clock_timestamp()))
        ${targetId ? sql`AND d.target_id=${targetId}` : sql``} ORDER BY d.next_attempt_at,d.id LIMIT 1`.execute(db)).rows[0];
    if (!candidate) return false;
    const claimed = await db.transaction().execute(async tx => {
      await tx.selectFrom('accounts').select('id').where('id','=',candidate.owner_id).forUpdate().executeTakeFirst();
      const d = (await sql<Delivery>`SELECT * FROM automation_event_deliveries WHERE id=${candidate.id}
        AND ((state IN ('pending','retrying') AND next_attempt_at<=clock_timestamp()) OR (state='sending' AND lease_until<clock_timestamp())) FOR UPDATE`.execute(tx)).rows[0];
      if (!d) return null;
      let target: Destination | null;
      try { target=await destination(tx,d); } catch (error) { if (error instanceof AutomationError && error.code==='automation_paused') return null;throw error; }
      if (!target) { await cancel(tx,d);return null; }
      if (!wellFormedOccurrence(d.body)) {
        await sql`UPDATE automation_event_deliveries SET state='deadLetter',last_error_code='invalid_payload',lease_until=NULL,next_attempt_at=NULL
          WHERE id=${d.id}`.execute(tx);
        return null;
      }
      const updated = (await sql<Delivery>`UPDATE automation_event_deliveries SET state='sending',generation=generation+1,
        attempt_count=attempt_count+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=${d.id} RETURNING *`.execute(tx)).rows[0]!;
      return { d: updated,target };
    });
    if (!claimed) return true;
    const { d,target } = claimed;
    let status = 0,retryAfter: string | null = null;
    try {
      const secret=transport.decrypt(target.secret_ciphertext,d.subscription_id);
      // The query returns the previous secret only inside its database-clock grace window.
      const previous=target.previous_secret_ciphertext && target.previous_secret_until
        ? { secret: transport.decrypt(target.previous_secret_ciphertext,d.subscription_id),until: target.previous_secret_until } : undefined;
      const response=await transport.send(target.callback_url,d.body,signWebhook({ id: d.id,subscriptionId: d.subscription_id,body: d.body,secret,previous }));
      status=response.status;retryAfter=response.retryAfter;
    } catch { /* Persist only a stable error category, never URL/receiver text or secrets. */ }
    await db.transaction().execute(async tx => {
      await tx.selectFrom('accounts').select('id').where('id','=',d.owner_id).forUpdate().executeTakeFirst();
      const current=(await sql`SELECT id FROM automation_event_deliveries WHERE id=${d.id} AND generation=${String(d.generation)}::bigint AND state='sending' FOR UPDATE`.execute(tx)).rows[0];
      if (!current) return;
      let live: Destination | null;
      try { live=await destination(tx,d,true); } catch (error) {
        if (!(error instanceof AutomationError) || error.code!=='automation_paused') throw error;
        // A paused completion is uncertain; no automatic resend until resume and lease expiry.
        return;
      }
      if (!live) { await cancel(tx,d);return; }
      const accepted=status>=200 && status<300,terminal=status===410 || status===413 || d.attempt_count>=8;
      const state=accepted ? 'accepted' : terminal ? 'deadLetter' : 'retrying';
      const code=accepted ? null : status===413 ? 'payload_too_large' : status===410 ? 'subscription_gone' : status ? 'callback_http_error' : 'callback_unavailable';
      const delay=deliveryRetryDelay(d.attempt_count,retryAfter);
      await sql`UPDATE automation_event_deliveries SET state=${state},lease_until=NULL,last_error_code=${code},
        next_attempt_at=${state==='retrying' ? sql`clock_timestamp()+make_interval(secs => ${Math.round(delay)/1000})` : null} WHERE id=${d.id}`.execute(tx);
      if (terminal && !accepted) {
        const rule=(await sql<{ rule_id:string }>`SELECT v.rule_id FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id WHERE r.id=(SELECT run_id FROM automation_jobs WHERE id=${d.job_id})`.execute(tx)).rows[0]!;
        const now=new Date().toISOString(),id=randomUUID();
        const incident={ id,ruleId:rule.rule_id,role:'delivery',code:'deliveryFailure',severity:'error',state:'open',blockingStages:[],
          message:status===413 ? 'Callback rejected an oversized occurrence; other deliveries remain active.' : 'Delivery retry stopped; inspect the current subscription and durable queue.',
          firstSeenAt:now,lastSeenAt:now,dependencyRevision:d.id };
        await sql`INSERT INTO automation_incidents(id,owner_id,rule_id,dependency_key,code,revision,severity,state,incident_json)
          VALUES(${id},${d.owner_id},${rule.rule_id},'delivery','deliveryFailure',${d.id},'error','open',${JSON.stringify(incident)}::jsonb) ON CONFLICT DO NOTHING`.execute(tx);
      }
      if (status===410) {
        await sql`UPDATE automation_event_subscriptions SET state='revoked',generation=generation+1,secret_ciphertext=NULL,previous_secret_ciphertext=NULL WHERE id=${d.subscription_id}`.execute(tx);
        await sql`UPDATE automation_event_deliveries SET state='cancelled',generation=generation+1,next_attempt_at=NULL,lease_until=NULL
          WHERE subscription_id=${d.subscription_id} AND state IN ('pending','retrying','sending')`.execute(tx);
      }
    });
    return true;
  } };
}

/**
 * The wake trigger builds the occurrence in SQL. Check it against the advertised event payload schema
 * before it leaves the server, so a drifted trigger dead-letters instead of sending an off-contract body.
 */
export function wellFormedOccurrence(body: string): boolean {
  try {
    const occurrence = JSON.parse(body) as Record<string,unknown>,data = occurrence.data as Record<string,unknown> | null;
    const { properties,required } = MCP_AUTOMATION_EVENT_DESCRIPTOR.payloadSchema;
    return occurrence.name === MCP_AUTOMATION_EVENT && typeof occurrence.eventId === 'string' && typeof occurrence.timestamp === 'string'
      && !!data && typeof data === 'object' && Object.keys(data).length === required.length
      && required.every(key => properties[key]?.type === 'integer' ? Number.isInteger(data[key]) : typeof data[key] === 'string');
  } catch { return false; }
}
