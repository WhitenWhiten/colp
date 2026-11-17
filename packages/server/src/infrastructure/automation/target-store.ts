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
type ResourceRow<Input> = { id: string; revision: string; configuration_json: Input };
type ResourcePageRow<Input> = ResourceRow<Input> & { sort_created_at: string };
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
  const targets = resource<Target,TargetInput>('automation_targets',async row => (await targetViews([row as unknown as TargetRow]))[0]!,
    async rows => {
      const views = await targetViews(rows as unknown as TargetRow[]);
      return views.map((view,index) => ({ view,createdAt: rows[index]!.sort_created_at }));
    });
  const executors = resource<Executor,ExecutorInput>('automation_executors',async row => executorView(row,
    row.configuration_json.targetId ? await targets.load(row.configuration_json.targetId) : null),async rows => {
    const targetIds = [...new Set(rows.flatMap(row => row.configuration_json.targetId ? [row.configuration_json.targetId] : []))];
    const views = await targetViewsById(targetIds);
    return rows.map(row => ({ view: executorView(row,row.configuration_json.targetId ? views.get(row.configuration_json.targetId) ?? null : null),
      createdAt: row.sort_created_at }));
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
  /** Batch a page: profiles once, binding once per distinct profile, then one
   * aggregate each for non-revoked targets and verified subscriptions. */
  async function targetViews(rows: TargetRow[]): Promise<Target[]> {
    if (!rows.length) return [];
    const profileIds = [...new Set(rows.map(row => row.profile_id))];
    const profiles = new Map((await sql<ProfileRow>`SELECT * FROM automation_connection_profiles
      WHERE owner_id=${ownerId} AND id IN (${sql.join(profileIds)})`.execute(tx)).rows.map(profile => [profile.id,profile]));

    const verified = new Map<string,{ dedicated: boolean } | null>();
    const verify = verifyBinding;
    const pairedProfileIds = verify
      ? [...new Set(rows.filter(row => row.paired && profiles.get(row.profile_id)?.observation_json).map(row => row.profile_id))]
      : [];
    await Promise.all(pairedProfileIds.map(async profileId => {
      if (!verify) return;
      try { verified.set(profileId,await verify(tx,profiles.get(profileId)!.observation_json as unknown as WorkPrincipal)); }
      catch (error) { if (!(error instanceof AutomationError)) throw error; verified.set(profileId,null); }
    }));
    const verifiedProfileIds = [...verified].filter(([,current]) => current !== null).map(([profileId]) => profileId);
    const nonRevoked = new Map<string,number>();
    if (verifiedProfileIds.length) {
      const counts = (await sql<{ profile_id: string; count: number }>`SELECT profile_id,count(*)::int AS count FROM automation_targets
        WHERE owner_id=${ownerId} AND profile_id IN (${sql.join(verifiedProfileIds)}) AND NOT revoked GROUP BY profile_id`.execute(tx)).rows;
      for (const row of counts) nonRevoked.set(row.profile_id,row.count);
    }

    const views = rows.map(row => {
      const profile = profiles.get(row.profile_id),current = verified.get(row.profile_id);
      let credentialCurrent = !row.paired;
      if (row.paired && current) {
        const count = nonRevoked.get(row.profile_id) ?? 0;
        row.dedicated_binding = current.dedicated && count === 1;
        credentialCurrent = row.configuration_json.privacy !== 'restricted' || (current.dedicated && count === 1);
      }
      const view = targetView(row,!!profile?.configuration_json.automationEnabled && profile.configuration_json.catalogs.includes('automationWorker'),credentialCurrent);
      return view.wakeMode === 'events' && eventsEnabled === false && view.wakeReadiness === 'waitingForSubscription'
        ? { ...view,wakeReadiness: 'blocked' as const,wakeReason: 'Events delivery is disabled on this server.' } : view;
    });

    const subscriptionTargetIds = rows.filter((row,index) => views[index]!.wakeMode === 'events'
      && views[index]!.wakeReadiness === 'waitingForSubscription' && profiles.has(row.profile_id)).map(row => row.id);
    if (subscriptionTargetIds.length) {
      const counts = (await sql<{ target_id: string; n: number }>`SELECT s.target_id,count(*)::int AS n
        FROM automation_event_subscriptions s
        JOIN automation_targets t ON t.id=s.target_id AND t.owner_id=s.owner_id
        JOIN automation_connection_profiles p ON p.id=t.profile_id AND p.owner_id=t.owner_id
        WHERE s.target_id IN (${sql.join(subscriptionTargetIds)}) AND s.owner_id=${ownerId}
          AND s.state='active' AND s.refresh_before>clock_timestamp()
          AND s.profile_revision=p.revision AND s.pairing_generation=t.pairing_generation
        GROUP BY s.target_id`.execute(tx)).rows;
      const byTarget = new Map(counts.map(row => [row.target_id,row.n]));
      for (const [index,row] of rows.entries()) {
        const count = byTarget.get(row.id);
        if (!count) continue;
        views[index] = { ...views[index]!,status: 'active',wakeReadiness: 'active',subscriptionCount: count,
          wakeReason: 'Verified subscription available; receipt and job execution are separate.' };
      }
    }
    return views;
  }
  async function targetViewsById(ids: string[]): Promise<Map<string,Target>> {
    if (!ids.length) return new Map();
    const rows = (await sql<TargetRow>`SELECT * FROM automation_targets WHERE owner_id=${ownerId} AND id IN (${sql.join(ids)})`.execute(tx)).rows;
    const views = await targetViews(rows);
    return new Map(rows.map((row,index) => [row.id,views[index]!]));
  }
  function executorView(row: ResourceRow<ExecutorInput>,target: Target | null): Executor {
    return { id: row.id,revision: String(row.revision),configuration: row.configuration_json,
      status: target?.status === 'active' ? 'available' : target?.status === 'revoked' ? 'revoked' : 'offline',verifiedCapabilities: [] };
  }
  function resource<View,Input>(table: 'automation_connection_profiles' | 'automation_targets' | 'automation_executors',
    map: (row: ResourceRow<Input>) => View | Promise<View>,
    mapPage?: (rows: ResourcePageRow<Input>[]) => Promise<{ view: View; createdAt: string }[]>): ConfigurationStore<View,Input> {
    const store: ConfigurationStore<View,Input> = {
      async load(id) { const row = (await sql<ResourceRow<Input>>`SELECT * FROM ${sql.table(table)} WHERE id=${id} AND owner_id=${ownerId}`.execute(tx)).rows[0]; return row ? map(row) : null; },
      async list(after,limit) {
        const cursor = after ? sql`AND (created_at,id)<(${after.createdAt}::timestamptz,${after.id})` : sql``;
        const rows = (await sql<ResourcePageRow<Input>>`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
          FROM ${sql.table(table)} WHERE owner_id=${ownerId} ${cursor} ORDER BY created_at DESC,id DESC LIMIT ${limit}`.execute(tx)).rows;
        return mapPage ? mapPage(rows) : Promise.all(rows.map(async row => ({ view: await map(row),createdAt: row.sort_created_at })));
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
          const previousRow = id ? (await sql<{ configuration_json: ConnectionProfileInput; revision: string }>`SELECT configuration_json,revision FROM automation_connection_profiles
            WHERE id=${key} AND owner_id=${ownerId} FOR UPDATE`.execute(tx)).rows[0] : undefined;
          const previous = previousRow?.configuration_json;
          // Renames keep pairings; a different credential, client, opt-in or worker catalog does not.
          const reauthorize = !!previous && profileAuthorityChanged(previous,input as ConnectionProfileInput);
          await sql`INSERT INTO automation_connection_profiles(id,owner_id,configuration_json) VALUES(${key},${ownerId},${JSON.stringify(input)}::jsonb)
            ON CONFLICT(id) DO UPDATE SET configuration_json=EXCLUDED.configuration_json,revision=automation_connection_profiles.revision+1,
              observation_json=CASE WHEN ${reauthorize} THEN NULL ELSE automation_connection_profiles.observation_json END
            WHERE automation_connection_profiles.owner_id=${ownerId}`.execute(tx);
          if (previousRow && !reauthorize) {
            // Display edits preserve only bindings that were current before this update.
            await sql`UPDATE automation_pairings g SET profile_revision=p.revision
              FROM automation_targets t,automation_connection_profiles p
              WHERE g.target_id=t.id AND t.profile_id=p.id AND p.id=${key} AND p.owner_id=${ownerId}
              AND g.profile_revision=${String(previousRow.revision)}::bigint`.execute(tx);
            if (eventsEnabled !== false) await sql`UPDATE automation_event_subscriptions s SET profile_revision=p.revision
              FROM automation_connection_profiles p WHERE s.profile_id=p.id AND p.id=${key} AND p.owner_id=${ownerId}
              AND s.profile_revision=${String(previousRow.revision)}::bigint`.execute(tx);
          }
          if (reauthorize) await sql`UPDATE automation_targets SET paired=false,pairing_generation=pairing_generation+1,revision=revision+1 WHERE owner_id=${ownerId} AND profile_id=${key}`.execute(tx);
        }
        await touchAutomationConfiguration(tx,ownerId);
        return (await store.load(key))!;
      },
    };
    return store;
  }
}

function profileAuthorityChanged(previous: ConnectionProfileInput,next: ConnectionProfileInput): boolean {
  const worker = (profile: ConnectionProfileInput) => profile.catalogs.includes('automationWorker');
  return previous.authorizedClientId !== next.authorizedClientId || previous.credentialBindingId !== next.credentialBindingId
    || previous.automationEnabled !== next.automationEnabled || worker(previous) !== worker(next);
}
