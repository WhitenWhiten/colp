import type { CurrentBindingVerifier } from './target-worker.js';
import type { WorkPrincipal } from '../../modules/automation/index.js';
import { randomBytes,randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { ConnectionProfile,ConnectionProfileInput,Target,TargetInput,Executor,ExecutorInput } from '@know-n/colp/automation';
import { AutomationError, type TargetStore, type ConfigurationStore } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { claimTokenHash } from './lease-store.js';
import { touchAutomationConfiguration } from './configuration-epoch.js';

export interface TargetRow { id: string; owner_id: string; revision: string; configuration_json: TargetInput; profile_id: string; paired: boolean; revoked: boolean; dedicated_binding: boolean; pairing_generation: string; created_at: string }
export interface ProfileRow { id: string; owner_id: string; revision: string; configuration_json: ConnectionProfileInput; observation_json: Record<string,unknown> | null; created_at: string }
export function targetView(row: TargetRow,profileEnabled: boolean,credentialCurrent = true): Target {
  const configuration = row.configuration_json,wakeMode = configuration.wakeMode ?? 'events';
  const restricted = configuration.privacy === 'restricted' && !row.dedicated_binding;
  const blocked = !profileEnabled || !credentialCurrent || restricted;
  return { id: row.id,revision: String(row.revision),configuration,status: row.revoked ? 'revoked' : !row.paired ? 'unpaired' : blocked ? 'error' : wakeMode === 'poll' ? 'active' : 'awaitingSubscription',
    subscriptionCount: 0,isolation: row.dedicated_binding ? 'dedicatedCredential' : 'sharedCredential',wakeMode,
    ...(configuration.pollIntervalMinutes ? { pollIntervalMinutes: configuration.pollIntervalMinutes } : {}),
    wakeReadiness: row.revoked ? 'disabled' : !row.paired ? 'waitingForPairing' : blocked ? 'blocked' : wakeMode === 'poll' ? 'active' : 'waitingForSubscription',
    wakeReason: row.revoked ? 'Target authorization was revoked.' : !row.paired ? 'Redeem a short-lived Owner pairing grant.'
      : !profileEnabled ? 'Automation worker catalog is disabled on the connection profile.' : !credentialCurrent ? 'Current credential authority is unavailable; reconnect or re-pair.' : restricted ? 'Restricted work requires a verified dedicated credential binding.'
      : wakeMode === 'poll' ? 'The paired worker may poll the durable queue; the server does not schedule the worker.' : 'A verified current subscription is required; reconcile the durable queue on reconnect.' };
}
export function createTargetStore(tx: DatabaseTransaction,ownerId: string,verifyBinding?: CurrentBindingVerifier,eventsEnabled?: boolean): TargetStore {
  const profiles = resource<ConnectionProfile,ConnectionProfileInput>('automation_connection_profiles',row => ({ id: row.id,revision: String(row.revision),configuration: row.configuration_json as ConnectionProfileInput,eventsSupport: 'unknown' }));
  const targets = resource<Target,TargetInput>('automation_targets',async row => {
    const target = row as unknown as TargetRow;
    const profile = (await sql<ProfileRow>`SELECT * FROM automation_connection_profiles WHERE id=${target.profile_id} AND owner_id=${ownerId}`.execute(tx)).rows[0];
    let credentialCurrent = !target.paired;
    if (target.paired && verifyBinding && profile?.observation_json) {
      try {
        const observation = profile.observation_json as unknown as WorkPrincipal;
        const current = await verifyBinding(tx,observation);
        const count = (await sql<{ count: number }>`SELECT count(*)::int AS count FROM automation_targets WHERE owner_id=${ownerId} AND profile_id=${target.profile_id} AND NOT revoked`.execute(tx)).rows[0]!.count;
        target.dedicated_binding = current.dedicated && count === 1;
        credentialCurrent = target.configuration_json.privacy !== 'restricted' || (current.dedicated && count === 1);
      } catch (error) { if (!(error instanceof AutomationError)) throw error; credentialCurrent=false; }
    }
    const view=targetView(target,!!profile?.configuration_json.automationEnabled && profile.configuration_json.catalogs.includes('automationWorker'),credentialCurrent);
    if(view.wakeMode==='events' && eventsEnabled===false && view.wakeReadiness==='waitingForSubscription')return {...view,wakeReadiness:'blocked',wakeReason:'Events delivery is disabled on this server.'};
    if (view.wakeMode==='events' && view.wakeReadiness==='waitingForSubscription' && profile) {
      const count=(await sql<{ n:number }>`SELECT count(*)::int AS n FROM automation_event_subscriptions
        WHERE target_id=${target.id} AND state='active' AND refresh_before>clock_timestamp()
        AND profile_revision=${String(profile.revision)}::bigint AND pairing_generation=${String(target.pairing_generation)}::bigint`.execute(tx)).rows[0]!.n;
      if (count) return { ...view,status:'active',wakeReadiness:'active',subscriptionCount:count,wakeReason:'Verified subscription available; receipt and job execution are separate.' };
    }
    return view;
  });
  const executors = resource<Executor,ExecutorInput>('automation_executors',async row => {
    const configuration = row.configuration_json as ExecutorInput,target = configuration.targetId ? await targets.load(configuration.targetId) : null;
    return { id: row.id,revision: String(row.revision),configuration,status: target?.status === 'active' ? 'available' : target?.status === 'revoked' ? 'revoked' : 'offline',verifiedCapabilities: [] };
  });
  return { profiles,targets,executors,
    async issuePairing(id) {
      const row = (await sql<{ profile_revision: string; generation: string }>`UPDATE automation_targets t SET pairing_generation=pairing_generation+1,revision=t.revision+1
        FROM automation_connection_profiles p WHERE t.id=${id} AND t.owner_id=${ownerId} AND p.id=t.profile_id AND NOT t.revoked
        AND p.configuration_json->>'automationEnabled'='true' AND p.configuration_json->'catalogs' ? 'automationWorker'
        RETURNING p.revision::text AS profile_revision,t.pairing_generation::text AS generation`.execute(tx)).rows[0];
      if (!row) throw new AutomationError('resource_not_found','Enabled worker target is unavailable.');
      const pairingId = randomUUID(),code = randomBytes(32).toString('base64url');
      const grant = (await sql<{ expires_at: Date }>`INSERT INTO automation_pairings(id,owner_id,target_id,profile_revision,pairing_generation,code_hash,expires_at)
        VALUES(${pairingId},${ownerId},${id},${row.profile_revision}::bigint,${row.generation}::bigint,${claimTokenHash(code)},clock_timestamp()+interval '5 minutes') RETURNING expires_at`.execute(tx)).rows[0]!;
      await sql`DELETE FROM automation_pairings WHERE id IN (SELECT id FROM automation_pairings WHERE owner_id=${ownerId} AND expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100)`.execute(tx);
      return { pairingId,targetId: id,code,expiresAt: grant.expires_at.toISOString() };
    },
    async revoke(id) {
      const rows = (await sql`UPDATE automation_targets SET revoked=true,paired=false,pairing_generation=pairing_generation+1,revision=revision+1 WHERE id=${id} AND owner_id=${ownerId} RETURNING id`.execute(tx)).rows;
      if (!rows.length) throw new AutomationError('resource_not_found','Target is unavailable.');
      await touchAutomationConfiguration(tx,ownerId);
      return (await targets.load(id))!;
    },
  };
  function resource<View,Input>(table: 'automation_connection_profiles' | 'automation_targets' | 'automation_executors',map: (row: { id: string; revision: string; configuration_json: Input }) => View | Promise<View>): ConfigurationStore<View,Input> {
    return {
      async load(id) { const row = (await sql<{ id: string; revision: string; configuration_json: Input }>`SELECT * FROM ${sql.table(table)} WHERE id=${id} AND owner_id=${ownerId}`.execute(tx)).rows[0]; return row ? map(row) : null; },
      async list(after,limit) {
        const cursor = after ? sql`AND (created_at,id)<(${after.createdAt}::timestamptz,${after.id})` : sql``;
        const rows = (await sql<{ id: string; revision: string; configuration_json: Input; sort_created_at: string }>`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
          FROM ${sql.table(table)} WHERE owner_id=${ownerId} ${cursor} ORDER BY created_at DESC,id DESC LIMIT ${limit}`.execute(tx)).rows;
        return Promise.all(rows.map(async row => ({ view: await map(row),createdAt: row.sort_created_at })));
      },
      async save(input,id) {
        const key = id ?? randomUUID();
        if (table === 'automation_targets') {
          const configuration = input as TargetInput;
          await sql`INSERT INTO automation_targets(id,owner_id,profile_id,configuration_json) VALUES(${key},${ownerId},${configuration.connectionProfileId},${JSON.stringify(input)}::jsonb)
            ON CONFLICT(id) DO UPDATE SET configuration_json=EXCLUDED.configuration_json,profile_id=EXCLUDED.profile_id,revision=automation_targets.revision+1,
              paired=CASE WHEN automation_targets.profile_id=EXCLUDED.profile_id THEN automation_targets.paired ELSE false END,
              dedicated_binding=CASE WHEN automation_targets.profile_id=EXCLUDED.profile_id THEN automation_targets.dedicated_binding ELSE false END,
              -- Only a new identity or data terms end existing subscriptions and queued deliveries; a rename does not.
              pairing_generation=automation_targets.pairing_generation+CASE WHEN automation_targets.profile_id IS DISTINCT FROM EXCLUDED.profile_id
                OR automation_targets.configuration_json->>'privacy' IS DISTINCT FROM EXCLUDED.configuration_json->>'privacy' THEN 1 ELSE 0 END
            WHERE automation_targets.owner_id=${ownerId}`.execute(tx);
          if (!id) await executors.save({ name: configuration.name,kind: 'mcpEventsBot',dataLocation: 'thirdParty',providerLabel: configuration.providerLabel,capabilities: [],targetId: key });
        } else if (table === 'automation_executors') {
          await sql`INSERT INTO automation_executors(id,owner_id,target_id,configuration_json) VALUES(${key},${ownerId},${(input as ExecutorInput).targetId!},${JSON.stringify(input)}::jsonb)
            ON CONFLICT(id) DO UPDATE SET configuration_json=EXCLUDED.configuration_json,target_id=EXCLUDED.target_id,revision=automation_executors.revision+1 WHERE automation_executors.owner_id=${ownerId}`.execute(tx);
        } else {
          const previous = id ? (await sql<{ configuration_json: ConnectionProfileInput }>`SELECT configuration_json FROM automation_connection_profiles
            WHERE id=${key} AND owner_id=${ownerId} FOR UPDATE`.execute(tx)).rows[0]?.configuration_json : undefined;
          // Renames keep pairings; a different credential, client, opt-in or worker catalog does not.
          const reauthorize = !!previous && profileAuthorityChanged(previous,input as ConnectionProfileInput);
          await sql`INSERT INTO automation_connection_profiles(id,owner_id,configuration_json) VALUES(${key},${ownerId},${JSON.stringify(input)}::jsonb)
            ON CONFLICT(id) DO UPDATE SET configuration_json=EXCLUDED.configuration_json,revision=automation_connection_profiles.revision+1,
              observation_json=CASE WHEN ${reauthorize} THEN NULL ELSE automation_connection_profiles.observation_json END
            WHERE automation_connection_profiles.owner_id=${ownerId}`.execute(tx);
          if (reauthorize) await sql`UPDATE automation_targets SET paired=false,pairing_generation=pairing_generation+1,revision=revision+1 WHERE owner_id=${ownerId} AND profile_id=${key}`.execute(tx);
        }
        await touchAutomationConfiguration(tx,ownerId);
        return (await this.load(key))!;
      },
    };
  }
}

function profileAuthorityChanged(previous: ConnectionProfileInput,next: ConnectionProfileInput): boolean {
  const worker = (profile: ConnectionProfileInput) => profile.catalogs.includes('automationWorker');
  return previous.authorizedClientId !== next.authorizedClientId || previous.credentialBindingId !== next.credentialBindingId
    || previous.automationEnabled !== next.automationEnabled || worker(previous) !== worker(next);
}
