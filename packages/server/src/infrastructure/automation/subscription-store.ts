import { principalObservation } from './principal-observation.js';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { McpEventsError, type McpEventSubscription } from '@know-n/colp/mcp';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { AutomationError, type WorkPrincipal } from '../../modules/automation/index.js';
import type { AutomationEventsService } from '../../modules/mcp/index.js';
import type { TargetWorkerService } from './target-worker.js';
import type { TargetRow } from './target-store.js';
export interface SubscriptionVerifier {
  verify(input: { id: string; url: string; secret: string }): Promise<void>;
  encrypt(secret: string, id: string): string;
}
interface SubscriptionRow { occupies_slot?: boolean; id: string; generation: string; verification_generation: string; refresh_before: Date; secret_ciphertext: string | null }
/** Reserve a generation, verify outside the transaction, then recheck authority and generation. */
export function createSubscriptionStore(db: Kysely<DatabaseSchema>, targets: TargetWorkerService, verifier?: SubscriptionVerifier): AutomationEventsService {
  async function authority(tx: DatabaseTransaction, actor: WorkPrincipal, targetId: string) {
    await tx.selectFrom('accounts').select('id').where('id','=',actor.accountId).forUpdate().executeTakeFirstOrThrow();
    await targets.authorize(tx, actor, targetId);
    const profile = await targets.profile(tx, actor);
    const target = (await sql<TargetRow>`SELECT * FROM automation_targets WHERE id=${targetId} AND owner_id=${actor.accountId} FOR UPDATE`.execute(tx)).rows[0]!;
    if ((target.configuration_json.wakeMode ?? 'events') !== 'events') throw new AutomationError('resource_not_found', 'Events target unavailable.');
    return { profile, target };
  }
  function identity(actor: WorkPrincipal, input: McpEventSubscription) {
    return createHash('sha256').update(JSON.stringify([actor.accountId,actor.clientId,actor.credentialBindingId,input.name,input.arguments.targetId,input.delivery.url])).digest('hex');
  }
  return {
    async available(actor) {
      if (!verifier) return false;
      const access = await targets.access(actor);
      return !!access?.automationEnabled && access.catalogs.includes('automationWorker') && access.pairedTargets.length > 0;
    },
    async subscribe(actor,input) {
      if (!verifier) throw new McpEventsError(-32015, 'Callback verification unavailable.');
      const requestedTtl = Math.max(60_000, Math.min(input.ttlMs ?? 3_600_000, 86_400_000));
      const credentialTtl = actor.expiresAt ? Date.parse(actor.expiresAt)-Date.now() : requestedTtl;
      const ttl = Math.min(requestedTtl,credentialTtl);
      if(!Number.isFinite(ttl) || ttl<60_000)throw new McpEventsError(-32602,'Refresh the credential before subscribing.');
      const pending = await db.transaction().execute(async tx => {
        const { profile,target } = await authority(tx,actor,input.arguments.targetId);
        const count = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM automation_event_subscriptions WHERE owner_id=${actor.accountId}
          AND state IN ('active','verifying') AND refresh_before>clock_timestamp()`.execute(tx)).rows[0]!.n;
        const existing = (await sql<SubscriptionRow>`SELECT *,state IN ('active','verifying') AND refresh_before>clock_timestamp() AS occupies_slot
          FROM automation_event_subscriptions WHERE identity_digest=${identity(actor,input)}`.execute(tx)).rows[0];
        if (!existing?.occupies_slot && count >= 100) throw new AutomationError('payload_too_large', 'Subscription limit reached.');
        // Renewal verification has its own fence. A live subscription continues
        // delivering and receiving queued wakes until the new key is verified.
        const live = sql`automation_event_subscriptions.state='active'
          AND automation_event_subscriptions.refresh_before>clock_timestamp()
          AND automation_event_subscriptions.profile_revision=EXCLUDED.profile_revision
          AND automation_event_subscriptions.pairing_generation=EXCLUDED.pairing_generation`;
        return (await sql<SubscriptionRow>`INSERT INTO automation_event_subscriptions
          (id,owner_id,target_id,profile_id,identity_digest,callback_url,profile_revision,pairing_generation,state,refresh_before,verification_refresh_before,verification_generation)
          VALUES(${randomUUID()},${actor.accountId},${target.id},${profile.id},${identity(actor,input)},${input.delivery.url},${String(profile.revision)}::bigint,${String(target.pairing_generation)}::bigint,'verifying',
            least(clock_timestamp()+${requestedTtl}*interval '1 millisecond',${actor.expiresAt ?? null}::timestamptz),
            least(clock_timestamp()+${requestedTtl}*interval '1 millisecond',${actor.expiresAt ?? null}::timestamptz),1)
          ON CONFLICT(identity_digest) DO UPDATE SET
            verification_generation=automation_event_subscriptions.verification_generation+1,
            verification_refresh_before=EXCLUDED.verification_refresh_before,
            generation=automation_event_subscriptions.generation+CASE WHEN ${live} THEN 0 ELSE 1 END,
            state=CASE WHEN ${live} THEN 'active' ELSE 'verifying' END,
            refresh_before=CASE WHEN ${live} THEN automation_event_subscriptions.refresh_before ELSE EXCLUDED.refresh_before END,
            profile_revision=EXCLUDED.profile_revision,pairing_generation=EXCLUDED.pairing_generation
          RETURNING id,generation::text,verification_generation::text,refresh_before,secret_ciphertext`.execute(tx)).rows[0]!;
      });
      try { await verifier.verify({ id: pending.id,url: input.delivery.url,secret: input.delivery.secret! }); }
      catch {
        await sql`UPDATE automation_event_subscriptions SET state='revoked',generation=generation+1,secret_ciphertext=NULL,previous_secret_ciphertext=NULL WHERE id=${pending.id} AND generation=${pending.generation}::bigint AND verification_generation=${pending.verification_generation}::bigint AND state='verifying'`.execute(db);
        throw new McpEventsError(-32015, 'Callback verification failed.');
      }
      return db.transaction().execute(async tx => {
        const { profile,target } = await authority(tx,actor,input.arguments.targetId);
        const rows = (await sql<{refresh_before:Date}>`UPDATE automation_event_subscriptions SET state='active',refresh_before=verification_refresh_before,
          previous_secret_ciphertext=secret_ciphertext,previous_secret_until=clock_timestamp()+interval '5 minutes',
          secret_ciphertext=${verifier.encrypt(input.delivery.secret!,pending.id)}
          WHERE id=${pending.id} AND generation=${pending.generation}::bigint AND verification_generation=${pending.verification_generation}::bigint AND state IN ('active','verifying') AND verification_refresh_before>clock_timestamp()
          AND profile_revision=${String(profile.revision)}::bigint AND pairing_generation=${String(target.pairing_generation)}::bigint RETURNING refresh_before`.execute(tx)).rows;
        if (!rows.length) throw new McpEventsError(-32015, 'Subscription changed during verification.');
        await sql`UPDATE automation_connection_profiles SET observation_json=${JSON.stringify(principalObservation(actor))}::jsonb WHERE id=${profile.id}`.execute(tx);
        return { id: pending.id,refreshBefore: rows[0]!.refresh_before.toISOString(),cursor: null,truncated: false as const };
      });
    },
    async unsubscribe(actor,input) {
      await db.transaction().execute(async tx => {
        await authority(tx,actor,input.arguments.targetId);
        await sql`UPDATE automation_event_subscriptions SET state='revoked',generation=generation+1,secret_ciphertext=NULL,
          previous_secret_ciphertext=NULL,previous_secret_until=NULL WHERE identity_digest=${identity(actor,input)}`.execute(tx);
      });
    },
  };
}
