import { principalObservation } from './principal-observation.js';
import type { AutomationProfileAccess } from '../../modules/mcp/index.js';
import { randomUUID,timingSafeEqual } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import type { Target } from '@know-n/colp/automation';
import { AutomationError,parseContract,type WorkPrincipal } from '../../modules/automation/index.js';
import { canonicalCommandFingerprint,type ProductCommandClaim } from '../../modules/commands/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
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
export type CurrentBindingVerifier = (tx: DatabaseTransaction,actor: WorkPrincipal,options?: BindingCheckOptions) => Promise<{ dedicated: boolean }>;
export type PairingCommandOutcome = { kind: 'succeeded'; target: Target } | Exclude<ProductCommandClaim,{ kind: 'claimed' }>;
export interface TargetWorkerService {
  access(actor: WorkPrincipal): Promise<AutomationProfileAccess | null>;
  profile(tx: DatabaseTransaction,actor: WorkPrincipal): Promise<ProfileRow>;
  authorize: TargetAuthority;
  pair(actor: WorkPrincipal,body: unknown,commandId?: string): Promise<PairingCommandOutcome>;
}
export function createTargetWorkerService(db: Kysely<DatabaseSchema>,verifyBinding: CurrentBindingVerifier,
  admitPairing: (actor: WorkPrincipal) => Promise<void>): TargetWorkerService {
  const profile = async (tx: DatabaseTransaction,actor: WorkPrincipal,options: BindingCheckOptions = {}): Promise<ProfileRow> => {
    if (!actor.scopes.includes('automation:work')) throw unavailable();
    const row = (await sql<ProfileRow>`SELECT p.* FROM automation_connection_profiles p JOIN accounts a ON a.id=p.owner_id
      WHERE p.owner_id=${actor.accountId} AND a.subject_id=${actor.subjectId} AND a.status='active' AND a.deleted_at IS NULL
      AND p.configuration_json->>'authorizedClientId'=${actor.clientId} AND p.configuration_json->>'credentialBindingId'=${actor.credentialBindingId}
      AND p.configuration_json->>'automationEnabled'='true' AND p.configuration_json->'catalogs' ? 'automationWorker'`.execute(tx)).rows[0];
    if (!row) throw unavailable();
    await verifyBinding(tx,actor,options);
    // Refresh token-free observations only after the current credential passed all
    // checks. Background health/delivery must not keep using the pairing token.
    if (actor.credentialDigest && actor.expiresAt) {
      await sql`UPDATE automation_connection_profiles SET observation_json=${JSON.stringify(principalObservation(actor))}::jsonb
        WHERE id=${row.id} AND (observation_json IS NULL OR observation_json->>'credentialDigest' IS DISTINCT FROM ${actor.credentialDigest})
        AND (observation_json IS NULL OR (observation_json->>'issuedAtSeconds')::bigint <= ${actor.issuedAtSeconds ?? 0})`.execute(tx);
    }
    return row;
  };
  const authorize = async (tx: DatabaseTransaction,actor: WorkPrincipal,targetId: string,privacy?: 'standard' | 'restricted',options: BindingCheckOptions = {}): Promise<void> => {
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
  return { profile,authorize,
    access: actor => db.transaction().execute(async tx => {
      const row = (await sql<ProfileRow>`SELECT p.* FROM automation_connection_profiles p JOIN accounts a ON a.id=p.owner_id
        WHERE p.owner_id=${actor.accountId} AND a.subject_id=${actor.subjectId} AND a.status='active' AND a.deleted_at IS NULL
          AND p.configuration_json->>'authorizedClientId'=${actor.clientId} AND p.configuration_json->>'credentialBindingId'=${actor.credentialBindingId}`.execute(tx)).rows[0];
      if (!row) return confirmableAccess(tx,actor);
      const access = { id: row.id,revision: String(row.revision),automationEnabled: row.configuration_json.automationEnabled,catalogs: row.configuration_json.catalogs,pairedTargets: [] as { id: string; generation: string }[] };
      try { await verifyBinding(tx,actor); }
      catch (error) { if (!(error instanceof AutomationError)) throw error; return { ...access,automationEnabled: false,catalogs: [] }; }
      const targets = (await sql<{ id: string; generation: string }>`SELECT id,pairing_generation::text AS generation FROM automation_targets
        WHERE owner_id=${actor.accountId} AND profile_id=${row.id} AND paired AND NOT revoked ORDER BY id LIMIT 501`.execute(tx)).rows;
      if (targets.length>500) throw new AutomationError('payload_too_large','Profile target bound exceeded.');
      return { ...access,pairedTargets: targets };
    }),
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
          await profile(tx,actor);
          if (claim.kind === 'replay') {
            const target = JSON.parse(new TextDecoder().decode(claim.result.body)) as Target;
            await authorize(tx,actor,target.id);
          }
          return claim;
        }
        await adoptCredential(tx,actor,input);
        const current = await profile(tx,actor);
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
function codeMatches(code: string,hash: string): boolean {
  const actual = Buffer.from(claimTokenHash(code)),expected = Buffer.from(hash);
  return actual.length === expected.length && timingSafeEqual(actual,expected);
}
const unavailable = () => new AutomationError('resource_not_found','Worker pairing or current target authority is unavailable.');
