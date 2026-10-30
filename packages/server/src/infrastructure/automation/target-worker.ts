import { principalObservation, observationArrival, refreshPrincipalObservation } from './principal-observation.js';
import type { AutomationProfileAccess } from '../../modules/mcp/index.js';
import { randomUUID,timingSafeEqual } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import type { Target,TargetPage } from '@know-n/colp/automation';
import { AutomationError,createAutomationPagination,parseContract,type WorkPrincipal } from '../../modules/automation/index.js';
import { canonicalCommandFingerprint,type ProductCommandClaim } from '../../modules/commands/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { databaseNow } from '../database/time.js';
import type { TargetAuthority } from './work-authority.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { claimTokenHash } from './lease-store.js';
import { touchAutomationConfiguration } from './configuration-epoch.js';
import { createTargetStore,type ProfileRow,type TargetRow } from './target-store.js';
import { AUTOMATION_CONTRACT_VERSION } from '@know-n/colp/automation';

/**
 * allowExpiredObservation: the pinned-proposal path (guard, server-applied approvals) only needs the worker to be
 * unrevoked, not online; revocation, epochs and profile binding are still checked.
 */
export interface BindingCheckOptions { allowExpiredObservation?: boolean }
/** Only the request entry points may create bindings or refresh their stored evidence. */
interface ProfileCheckOptions extends BindingCheckOptions { liveRequest?: boolean }
export type CurrentBindingVerifier = (tx: DatabaseTransaction,actor: WorkPrincipal,options?: BindingCheckOptions) => Promise<{ dedicated: boolean }>;
export type PairingCommandOutcome = { kind: 'succeeded'; target: Target } | Exclude<ProductCommandClaim,{ kind: 'claimed' }>;
export interface TargetWorkerService {
  access(actor: WorkPrincipal): Promise<AutomationProfileAccess | null>;
  profile(tx: DatabaseTransaction,actor: WorkPrincipal): Promise<ProfileRow>;
  /** Verify existing authority only; safe for delivery and stored proposals. */
  authorize: TargetAuthority;
  /** A verified live worker request may first bind or repair under consent. */
  authorizeRequest: TargetAuthority;
  pair(actor: WorkPrincipal,body: unknown,commandId?: string): Promise<PairingCommandOutcome>;
  mine(actor: WorkPrincipal,query?: { cursor?: string; limit?: string }): Promise<TargetPage>;
}
export interface TargetWorkerOptions { cursorKey: string; eventsEnabled?: boolean }
export function createTargetWorkerService(db: Kysely<DatabaseSchema>,verifyBinding: CurrentBindingVerifier,
  admitPairing: (actor: WorkPrincipal) => Promise<void>,options: TargetWorkerOptions): TargetWorkerService {
  const pages = createAutomationPagination(options.cursorKey);
  /** The profile this credential is bound to, whatever the Owner's current opt-ins. */
  const boundProfile = async (tx: DatabaseTransaction,actor: WorkPrincipal): Promise<ProfileRow | undefined> =>
    (await sql<ProfileRow>`SELECT p.* FROM automation_connection_profiles p JOIN accounts a ON a.id=p.owner_id
      WHERE p.owner_id=${actor.accountId} AND a.subject_id=${actor.subjectId} AND a.status='active' AND a.deleted_at IS NULL
        AND p.configuration_json->>'authorizedClientId'=${actor.clientId} AND p.configuration_json->>'credentialBindingId'=${actor.credentialBindingId}`.execute(tx)).rows[0];
  /**
   * The Owner's permit for an OAuth agent is the consent that granted automation:work: the consent page
   * names the client and says that allowing the scope makes it a worker. A live token of that client
   * therefore binds its own connection on first contact, with no code. Only consented clients bind; an
   * API key keeps the one-use code, because its token scopes are the script's choice, not the Owner's.
   * Stored observations never reach here, so background delivery and approvals cannot create authority.
   */
  const consentedScopes = async (tx: DatabaseTransaction,actor: WorkPrincipal): Promise<{ name: string | null; scopes: string[] } | null> => {
    if (!actor.scopes.includes('automation:work') || !actor.credentialDigest || !actor.expiresAt) return null;
    const row = (await sql<{ name: string | null; scopes: unknown }>`SELECT c.name,consent.scopes FROM "auth_oauth_consent" consent
      JOIN auth_user_account_map m ON m.auth_user_id=consent."userId" JOIN accounts a ON a.id=m.account_id
      JOIN "auth_oauth_client" c ON c."clientId"=consent."clientId"
      WHERE consent."clientId"=${actor.clientId} AND m.account_id=${actor.accountId} AND a.subject_id=${actor.subjectId}
        AND a.status='active' AND a.deleted_at IS NULL AND c.disabled IS DISTINCT FROM true
      ORDER BY consent."updatedAt" DESC LIMIT 1`.execute(tx)).rows[0];
    if (!row) return null;
    const scopes = scopeList(row.scopes);
    return scopes.includes('automation:work') ? { name: row.name,scopes } : null;
  };
  /** Inboxes an opt-in change unpaired come back on the agent's next call: the consent still stands. */
  const repairInboxes = async (tx: DatabaseTransaction,actor: WorkPrincipal,profileId: string,unpaired: boolean): Promise<void> => {
    if (!unpaired || !await consentedScopes(tx,actor)) return;
    const binding = await verifyBinding(tx,actor);
    await sql`UPDATE automation_targets SET paired=true,dedicated_binding=${binding.dedicated},last_seen_at=clock_timestamp(),revision=revision+1
      WHERE owner_id=${actor.accountId} AND profile_id=${profileId} AND NOT paired AND NOT revoked`.execute(tx);
    await touchAutomationConfiguration(tx,actor.accountId);
  };
  const bindByConsent = async (tx: DatabaseTransaction,actor: WorkPrincipal): Promise<void> => {
    const consent = await consentedScopes(tx,actor);
    if (!consent) return;
    const binding = await verifyBinding(tx,actor);
    // One Owner's first contacts run one at a time; the unique binding index turns a lost race into a plain retry.
    await tx.selectFrom('accounts').select('id').where('id','=',actor.accountId).forUpdate().execute();
    if (await boundProfile(tx,actor)) return;
    // The Owner may have registered this agent before it connected (guided rule setup), or an earlier credential of
    // it may have lapsed: adopt that registration. One another live credential of the same client works on stays.
    const registered = (await sql<ProfileRow>`SELECT * FROM automation_connection_profiles WHERE owner_id=${actor.accountId}
      AND configuration_json->>'authorizedClientId'=${actor.clientId} ORDER BY created_at,id FOR UPDATE`.execute(tx)).rows;
    let profile: ProfileRow | undefined;
    for (const row of registered) {
      if (row.observation_json) {
        try { await verifyBinding(tx,row.observation_json as unknown as WorkPrincipal); continue; }
        catch (error) { if (!(error instanceof AutomationError)) throw error; }
      }
      profile = row; break;
    }
    if (profile) {
      await sql`UPDATE automation_connection_profiles SET configuration_json=jsonb_set(configuration_json,'{credentialBindingId}',to_jsonb(${actor.credentialBindingId}::text)),
        revision=revision+1,observation_json=NULL WHERE id=${profile.id}`.execute(tx);
    } else {
      const store = createTargetStore(tx,actor.accountId,verifyBinding,options.eventsEnabled),name = agentDisplayName(consent.name,actor.clientId);
      const created = await store.profiles.save({ name,authorizedClientId: actor.clientId,credentialBindingId: actor.credentialBindingId,automationEnabled: true,
        catalogs: ['standard','automationWorker',...(consent.scopes.includes('automation:manage') ? ['automationManager' as const] : [])] });
      await store.targets.save({ name,providerLabel: '',broadcastOptIn: false,privacy: 'standard',connectionProfileId: created.id,
        wakeMode: options.eventsEnabled ? 'events' : 'poll',pollIntervalMinutes: 1 });
      profile = (await sql<ProfileRow>`SELECT * FROM automation_connection_profiles WHERE id=${created.id}`.execute(tx)).rows[0]!;
    }
    // A new generation ends subscriptions and grants of the previous credential; the Owner's inboxes carry over paired.
    await sql`UPDATE automation_targets SET paired=true,dedicated_binding=${binding.dedicated},pairing_generation=pairing_generation+1,last_seen_at=clock_timestamp(),revision=revision+1
      WHERE owner_id=${actor.accountId} AND profile_id=${profile.id} AND NOT revoked`.execute(tx);
    await sql`UPDATE automation_connection_profiles SET observation_json=${JSON.stringify(principalObservation(actor))}::jsonb WHERE id=${profile.id}`.execute(tx);
    await touchAutomationConfiguration(tx,actor.accountId);
  };
  const enabledProfile = async (tx: DatabaseTransaction,actor: WorkPrincipal): Promise<(ProfileRow & { unpaired: boolean }) | undefined> =>
    (await sql<ProfileRow & { unpaired: boolean }>`SELECT p.*,EXISTS(SELECT 1 FROM automation_targets t WHERE t.owner_id=p.owner_id AND t.profile_id=p.id AND NOT t.paired AND NOT t.revoked) AS unpaired
      FROM automation_connection_profiles p JOIN accounts a ON a.id=p.owner_id
      WHERE p.owner_id=${actor.accountId} AND a.subject_id=${actor.subjectId} AND a.status='active' AND a.deleted_at IS NULL
      AND p.configuration_json->>'authorizedClientId'=${actor.clientId} AND p.configuration_json->>'credentialBindingId'=${actor.credentialBindingId}
      AND p.configuration_json->>'automationEnabled'='true' AND p.configuration_json->'catalogs' ? 'automationWorker'`.execute(tx)).rows[0];
  const profile = async (tx: DatabaseTransaction,actor: WorkPrincipal,options: ProfileCheckOptions = {}): Promise<ProfileRow> => {
    await observationArrival(tx,actor);
    if (!actor.scopes.includes('automation:work')) throw unavailable();
    let row = await enabledProfile(tx,actor);
    // Evidence provenance and expiry are separate: even unexpired stored observations only verify.
    if (options.liveRequest) {
      if (!row) { await bindByConsent(tx,actor); row = await enabledProfile(tx,actor); }
      if (row) await repairInboxes(tx,actor,row.id,row.unpaired);
    }
    if (!row) throw unavailable();
    await verifyBinding(tx,actor,options);
    // Refresh token-free observations only after the current credential passed all
    // checks. Background health/delivery must not keep using the pairing token.
    if (options.liveRequest && actor.credentialDigest && actor.expiresAt) {
      await refreshPrincipalObservation(tx,row.id,actor);
    }
    return row;
  };
  const authorize = async (tx: DatabaseTransaction,actor: WorkPrincipal,targetId: string,privacy?: 'standard' | 'restricted',options: ProfileCheckOptions = {}): Promise<void> => {
    const current = await profile(tx,actor,options);
    const target = (await sql<TargetRow>`SELECT * FROM automation_targets WHERE id=${targetId} AND owner_id=${actor.accountId}
      AND profile_id=${current.id} AND paired AND NOT revoked`.execute(tx)).rows[0];
    if (!target) throw unavailable();
    if (target.configuration_json.privacy === 'restricted' || privacy === 'restricted') {
      const binding = await verifyBinding(tx,actor,options);
      const count = (await sql<{ count: number }>`SELECT count(*)::int AS count FROM automation_targets WHERE owner_id=${actor.accountId} AND profile_id=${current.id} AND NOT revoked`.execute(tx)).rows[0]!.count;
      if (!binding.dedicated || !target.dedicated_binding || count !== 1) throw unavailable();
    }
  };
  /**
   * The Owner names the agent (authorizedClientId); a valid one-use code redeemed by that agent confirms
   * which of its credentials the connection trusts. Nothing changes without the code, for another client or
   * Owner, or while another worker on the connection is paired, so a code never moves a working worker.
   */
  const adoptCredential = async (tx: DatabaseTransaction,actor: WorkPrincipal,input: { pairingId: string; code: string }): Promise<void> => {
    if (!actor.scopes.includes('automation:work')) return;
    const row = (await sql<{ profile_id: string; code_hash: string }>`SELECT p.id AS profile_id,g.code_hash FROM automation_pairings g
      JOIN automation_targets t ON t.id=g.target_id AND t.owner_id=g.owner_id
      JOIN automation_connection_profiles p ON p.id=t.profile_id AND p.owner_id=t.owner_id JOIN accounts a ON a.id=p.owner_id
      WHERE g.id=${input.pairingId} AND g.owner_id=${actor.accountId} AND a.subject_id=${actor.subjectId} AND a.status='active' AND a.deleted_at IS NULL
      AND p.configuration_json->>'authorizedClientId'=${actor.clientId} AND p.configuration_json->>'credentialBindingId'<>${actor.credentialBindingId}
      AND p.configuration_json->>'automationEnabled'='true' AND p.configuration_json->'catalogs' ? 'automationWorker'
      AND g.profile_revision=p.revision AND g.pairing_generation=t.pairing_generation
      AND NOT t.revoked AND g.consumed_at IS NULL AND g.expires_at>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM automation_targets o WHERE o.owner_id=p.owner_id AND o.profile_id=p.id AND o.id<>t.id AND o.paired AND NOT o.revoked)
      AND NOT EXISTS(SELECT 1 FROM automation_connection_profiles q WHERE q.owner_id=p.owner_id AND q.id<>p.id
        AND q.configuration_json->>'authorizedClientId'=${actor.clientId} AND q.configuration_json->>'credentialBindingId'=${actor.credentialBindingId})
      FOR UPDATE OF g,t,p`.execute(tx)).rows[0];
    if (!row || !codeMatches(input.code,row.code_hash)) return;
    await verifyBinding(tx,actor);
    // A new credential is new authority: drop the old observation, and carry this grant over to the new revision.
    const next = (await sql<{ revision: string }>`UPDATE automation_connection_profiles
      SET configuration_json=jsonb_set(configuration_json,'{credentialBindingId}',to_jsonb(${actor.credentialBindingId}::text)),revision=revision+1,observation_json=NULL
      WHERE id=${row.profile_id} AND owner_id=${actor.accountId} RETURNING revision::text AS revision`.execute(tx)).rows[0]!;
    await sql`UPDATE automation_pairings SET profile_revision=${next.revision}::bigint WHERE id=${input.pairingId}`.execute(tx);
    await touchAutomationConfiguration(tx,actor.accountId);
  };
  /**
   * While the Owner has a live code out for a connection this credential could confirm (see adoptCredential),
   * MCP shows it the pair tool and nothing else new: standard tools stay as they were, no manager or job tools.
   */
  const confirmableAccess = async (tx: DatabaseTransaction,actor: WorkPrincipal): Promise<AutomationProfileAccess | null> => {
    if (!actor.scopes.includes('automation:work')) return null;
    const row = (await sql<{ id: string; revision: string }>`SELECT p.id,p.revision::text AS revision FROM automation_connection_profiles p JOIN accounts a ON a.id=p.owner_id
      WHERE p.owner_id=${actor.accountId} AND a.subject_id=${actor.subjectId} AND a.status='active' AND a.deleted_at IS NULL
      AND p.configuration_json->>'authorizedClientId'=${actor.clientId} AND p.configuration_json->>'credentialBindingId'<>${actor.credentialBindingId}
      AND p.configuration_json->>'automationEnabled'='true' AND p.configuration_json->'catalogs' ? 'automationWorker'
      AND EXISTS(SELECT 1 FROM automation_pairings g JOIN automation_targets t ON t.id=g.target_id AND t.owner_id=g.owner_id
        WHERE t.owner_id=p.owner_id AND t.profile_id=p.id AND g.profile_revision=p.revision AND g.pairing_generation=t.pairing_generation
        AND NOT t.revoked AND g.consumed_at IS NULL AND g.expires_at>clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM automation_targets o WHERE o.owner_id=p.owner_id AND o.profile_id=p.id AND o.id<>t.id AND o.paired AND NOT o.revoked))
      ORDER BY p.created_at,p.id LIMIT 1`.execute(tx)).rows[0];
    if (!row) return null;
    try { await verifyBinding(tx,actor); }
    catch (error) { if (!(error instanceof AutomationError)) throw error; return null; }
    return { id: row.id,revision: row.revision,automationEnabled: true,catalogs: ['standard','automationWorker'],pairedTargets: [] };
  };
  return { profile: (tx,actor) => profile(tx,actor,{ liveRequest: true }),authorize,
    authorizeRequest: (tx,actor,targetId,privacy) => authorize(tx,actor,targetId,privacy,{ liveRequest: true }),
    access: actor => db.transaction().execute(async tx => {
      let row = await boundProfile(tx,actor);
      if (!row) { await bindByConsent(tx,actor); row = await boundProfile(tx,actor); }
      if (!row) return confirmableAccess(tx,actor);
      const access = { id: row.id,revision: String(row.revision),automationEnabled: row.configuration_json.automationEnabled,catalogs: row.configuration_json.catalogs,pairedTargets: [] as { id: string; generation: string }[] };
      try { await verifyBinding(tx,actor); }
      catch (error) { if (!(error instanceof AutomationError)) throw error; return { ...access,automationEnabled: false,catalogs: [] }; }
      const inboxes = (await sql<{ id: string; generation: string; paired: boolean }>`SELECT id,pairing_generation::text AS generation,paired FROM automation_targets
        WHERE owner_id=${actor.accountId} AND profile_id=${row.id} AND NOT revoked ORDER BY id LIMIT 501`.execute(tx)).rows;
      if (inboxes.length>500) throw new AutomationError('payload_too_large','Profile target bound exceeded.');
      let targets = inboxes.filter(target => target.paired);
      if (access.automationEnabled && access.catalogs.includes('automationWorker') && targets.length<inboxes.length) {
        await repairInboxes(tx,actor,row.id,true);
        targets = (await sql<{ id: string; generation: string; paired: boolean }>`SELECT id,pairing_generation::text AS generation,paired FROM automation_targets
          WHERE owner_id=${actor.accountId} AND profile_id=${row.id} AND paired AND NOT revoked ORDER BY id LIMIT 501`.execute(tx)).rows;
      }
      return { ...access,pairedTargets: targets.map(({ id,generation }) => ({ id,generation })) };
    }),
    /** Own paired inboxes only, through the same binding (and consent) checks as any work call. */
    async mine(actor,query = {}) {
      return db.transaction().execute(async tx => {
        await tx.selectFrom('accounts').select('id').where('id','=',actor.accountId).forUpdate().executeTakeFirst();
        const current = await profile(tx,actor,{ liveRequest: true }),store = createTargetStore(tx,actor.accountId,verifyBinding,options.eventsEnabled);
        const now = await databaseNow(tx),identity = JSON.stringify([actor.accountId,actor.clientId,actor.credentialBindingId]);
        const scope = JSON.stringify(['targets.mine',current.id]),{ limit,after } = pages.read(query,identity,scope,now);
        const cursor = after ? sql`AND (created_at,id)>(${after.createdAt}::timestamptz,${after.id})` : sql``;
        const rows = (await sql<{ id: string; sort_created_at: string }>`SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_created_at
          FROM automation_targets WHERE owner_id=${actor.accountId} AND profile_id=${current.id} AND paired AND NOT revoked ${cursor}
          ORDER BY created_at,id LIMIT ${limit+1}`.execute(tx)).rows;
        const targets: Target[] = [];
        for (const row of rows.slice(0,limit)) { const target = await store.targets.load(row.id); if (target) targets.push(target); }
        const last = rows[limit-1];
        return { items: targets,nextCursor: rows.length>limit && last
          ? pages.next(identity,scope,limit,{ id: last.id,createdAt: last.sort_created_at },now) : null };
      });
    },
    async pair(actor,body,commandId = randomUUID()) {
      const input = parseContract('PairingClaimInput',body);
      await admitPairing(actor);
      return db.transaction().execute(async tx => {
        const account = await tx.selectFrom('accounts').select('id').where('id','=',actor.accountId).forUpdate().executeTakeFirst();
        if (!account) throw unavailable();
        const receipts = createPostgresProductCommandReceiptPort(tx), command = { principalId: actor.accountId,
          commandScope: JSON.stringify(['automation:pair',actor.clientId,actor.credentialBindingId]),commandId };
        const fingerprint = canonicalCommandFingerprint({ method: 'POST',route: '/api/v1/automation-work/pairings/claim',mediaType: 'application/json',body: input });
        // A failure below rolls this claim back with everything else in the transaction.
        const claim = await receipts.claim(command,fingerprint);
        if (claim.kind !== 'claimed') {
          await profile(tx,actor,{ liveRequest: true });
          if (claim.kind === 'replay') {
            const target = JSON.parse(new TextDecoder().decode(claim.result.body)) as Target;
            await authorize(tx,actor,target.id);
          }
          return claim;
        }
        await adoptCredential(tx,actor,input);
        const current = await profile(tx,actor,{ liveRequest: true });
        const grant = (await sql<{ code_hash: string; target_id: string }>`SELECT g.code_hash,g.target_id FROM automation_pairings g
          JOIN automation_targets t ON t.id=g.target_id AND t.owner_id=g.owner_id
          WHERE g.id=${input.pairingId} AND g.owner_id=${actor.accountId} AND t.profile_id=${current.id}
          AND g.profile_revision=${String(current.revision)}::bigint AND g.pairing_generation=t.pairing_generation
          AND NOT t.revoked AND g.consumed_at IS NULL AND g.expires_at>clock_timestamp() FOR UPDATE OF g,t`.execute(tx)).rows[0];
        if (!grant || !codeMatches(input.code,grant.code_hash)) throw unavailable();
        const binding = await verifyBinding(tx,actor);
        await sql`UPDATE automation_pairings SET consumed_at=clock_timestamp() WHERE id=${input.pairingId}`.execute(tx);
        await sql`UPDATE automation_targets SET paired=true,dedicated_binding=${binding.dedicated},last_seen_at=clock_timestamp(),revision=revision+1 WHERE id=${grant.target_id}`.execute(tx);
        // Whitelist token-free identity fields. Never serialize an arbitrary actor object or request.
        const observation = principalObservation(actor);
        await sql`UPDATE automation_connection_profiles SET observation_json=${JSON.stringify(observation)}::jsonb WHERE id=${current.id}`.execute(tx);
        const target = (await createTargetStore(tx,actor.accountId,verifyBinding).targets.load(grant.target_id))!;
        await receipts.complete(command,fingerprint,{ status: 200,body: new TextEncoder().encode(JSON.stringify(target)),mediaType: 'application/json',
          contractVersion: AUTOMATION_CONTRACT_VERSION,stableHeaders: { 'cache-control': 'private, no-store' } });
        return { kind: 'succeeded' as const,target };
      });
    },
  };
}
/** Better Auth stores consented scopes as a JSON array; older rows may hold one space-separated string. */
function scopeList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/u) : [];
  return [...new Set(source.filter((item): item is string => typeof item === 'string' && item.length>0 && item.length<=128))];
}
/** The registered client name, else the host of a CIMD client URL, else the client ID itself. */
function agentDisplayName(name: string | null,clientId: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed) return [...trimmed].slice(0,200).join('');
  try { return new URL(clientId).hostname || clientId.slice(0,200); } catch { return clientId.slice(0,200); }
}
function codeMatches(code: string,hash: string): boolean {
  const actual = Buffer.from(claimTokenHash(code)),expected = Buffer.from(hash);
  return actual.length === expected.length && timingSafeEqual(actual,expected);
}
const unavailable = () => new AutomationError('resource_not_found','Worker pairing or current target authority is unavailable.');
