import type { AutomationProfileAccess } from '../../modules/mcp/index.js';
import { randomUUID,timingSafeEqual } from 'node:crypto';
import { sql,type Kysely } from 'kysely';
import type { Target } from '@know-n/colp/automation';
import { AutomationError,parseContract,type WorkPrincipal } from '../../modules/automation/index.js';
import { canonicalCommandFingerprint,type ProductCommandClaim } from '../../modules/commands/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { claimTokenHash } from './lease-store.js';
import { createTargetStore,type ProfileRow,type TargetRow } from './target-store.js';

export type CurrentBindingVerifier = (tx: DatabaseTransaction,actor: WorkPrincipal) => Promise<{ dedicated: boolean }>;
export type PairingCommandOutcome = { kind: 'succeeded'; target: Target } | Exclude<ProductCommandClaim,{ kind: 'claimed' }>;
export interface TargetWorkerService {
  access(actor: WorkPrincipal): Promise<AutomationProfileAccess | null>;
  profile(tx: DatabaseTransaction,actor: WorkPrincipal): Promise<ProfileRow>;
  authorize(tx: DatabaseTransaction,actor: WorkPrincipal,targetId: string,privacy?: 'standard' | 'restricted'): Promise<void>;
  pair(actor: WorkPrincipal,body: unknown,commandId?: string): Promise<PairingCommandOutcome>;
}
export function createTargetWorkerService(db: Kysely<DatabaseSchema>,verifyBinding: CurrentBindingVerifier,
  admitPairing: (actor: WorkPrincipal) => Promise<void>): TargetWorkerService {
  const profile = async (tx: DatabaseTransaction,actor: WorkPrincipal): Promise<ProfileRow> => {
    if (!actor.scopes.includes('automation:work')) throw unavailable();
    const row = (await sql<ProfileRow>`SELECT p.* FROM automation_connection_profiles p JOIN accounts a ON a.id=p.owner_id
      WHERE p.owner_id=${actor.accountId} AND a.subject_id=${actor.subjectId} AND a.status='active' AND a.deleted_at IS NULL
      AND p.configuration_json->>'authorizedClientId'=${actor.clientId} AND p.configuration_json->>'credentialBindingId'=${actor.credentialBindingId}
      AND p.configuration_json->>'automationEnabled'='true' AND p.configuration_json->'catalogs' ? 'automationWorker'`.execute(tx)).rows[0];
    if (!row) throw unavailable();
    await verifyBinding(tx,actor);
    return row;
  };
  const authorize = async (tx: DatabaseTransaction,actor: WorkPrincipal,targetId: string,privacy?: 'standard' | 'restricted'): Promise<void> => {
    const current = await profile(tx,actor);
    const target = (await sql<TargetRow>`SELECT * FROM automation_targets WHERE id=${targetId} AND owner_id=${actor.accountId}
      AND profile_id=${current.id} AND paired AND NOT revoked`.execute(tx)).rows[0];
    if (!target) throw unavailable();
    if (target.configuration_json.privacy === 'restricted' || privacy === 'restricted') {
      const binding = await verifyBinding(tx,actor);
      const count = (await sql<{ count: number }>`SELECT count(*)::int AS count FROM automation_targets WHERE owner_id=${actor.accountId} AND profile_id=${current.id} AND NOT revoked`.execute(tx)).rows[0]!.count;
      if (!binding.dedicated || !target.dedicated_binding || count !== 1) throw unavailable();
    }
  };
  return { profile,authorize,
    access: actor => db.transaction().execute(async tx => {
      const row = (await sql<ProfileRow>`SELECT p.* FROM automation_connection_profiles p JOIN accounts a ON a.id=p.owner_id
        WHERE p.owner_id=${actor.accountId} AND a.subject_id=${actor.subjectId} AND a.status='active' AND a.deleted_at IS NULL
          AND p.configuration_json->>'authorizedClientId'=${actor.clientId} AND p.configuration_json->>'credentialBindingId'=${actor.credentialBindingId}`.execute(tx)).rows[0];
      if (!row) return null;
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
        const current = await profile(tx,actor);
        const receipts = createPostgresProductCommandReceiptPort(tx), command = { principalId: actor.accountId,
          commandScope: JSON.stringify(['automation:pair',actor.clientId,actor.credentialBindingId]),commandId };
        const fingerprint = canonicalCommandFingerprint({ method: 'POST',route: '/api/v1/automation-work/pairings/claim',mediaType: 'application/json',body: input });
        const claim = await receipts.claim(command,fingerprint);
        if (claim.kind !== 'claimed') {
          if (claim.kind === 'replay') {
            const target = JSON.parse(new TextDecoder().decode(claim.result.body)) as Target;
            await authorize(tx,actor,target.id);
          }
          return claim;
        }
        const grant = (await sql<{ code_hash: string; target_id: string }>`SELECT g.code_hash,g.target_id FROM automation_pairings g
          JOIN automation_targets t ON t.id=g.target_id AND t.owner_id=g.owner_id
          WHERE g.id=${input.pairingId} AND g.owner_id=${actor.accountId} AND t.profile_id=${current.id}
          AND g.profile_revision=${String(current.revision)}::bigint AND g.pairing_generation=t.pairing_generation
          AND NOT t.revoked AND g.consumed_at IS NULL AND g.expires_at>clock_timestamp() FOR UPDATE OF g,t`.execute(tx)).rows[0];
        const actual = Buffer.from(claimTokenHash(input.code)),expected = Buffer.from(grant?.code_hash ?? '');
        if (!grant || actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw unavailable();
        const binding = await verifyBinding(tx,actor);
        await sql`UPDATE automation_pairings SET consumed_at=clock_timestamp() WHERE id=${input.pairingId}`.execute(tx);
        await sql`UPDATE automation_targets SET paired=true,dedicated_binding=${binding.dedicated},last_seen_at=clock_timestamp(),revision=revision+1 WHERE id=${grant.target_id}`.execute(tx);
        // Whitelist token-free identity fields. Never serialize an arbitrary actor object or request.
        const observation = { accountId: actor.accountId,subjectId: actor.subjectId,clientId: actor.clientId,credentialBindingId: actor.credentialBindingId,
          resourceAudience: actor.resourceAudience ?? null,securityEpoch: actor.securityEpoch ?? null,scopes: [...actor.scopes],
          credentialDigest: actor.credentialDigest ?? null,expiresAt: actor.expiresAt ?? null,issuedAtSeconds: actor.issuedAtSeconds ?? null,accountSecurityEpoch: actor.accountSecurityEpoch ?? null };
        await sql`UPDATE automation_connection_profiles SET observation_json=${JSON.stringify(observation)}::jsonb WHERE id=${current.id}`.execute(tx);
        const target = (await createTargetStore(tx,actor.accountId,verifyBinding).targets.load(grant.target_id))!;
        await receipts.complete(command,fingerprint,{ status: 200,body: new TextEncoder().encode(JSON.stringify(target)),mediaType: 'application/json',
          contractVersion: '0.2.1-design',stableHeaders: { 'cache-control': 'private, no-store' } });
        return { kind: 'succeeded' as const,target };
      });
    },
  };
}
const unavailable = () => new AutomationError('resource_not_found','Worker pairing or current target authority is unavailable.');
