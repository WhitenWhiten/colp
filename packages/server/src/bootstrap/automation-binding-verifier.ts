import { sql } from 'kysely';
import { AutomationError } from '../modules/automation/index.js';
import { loadCredentialAuthority,currentMachineBinding,storedBindingMatches } from '../modules/auth/index.js';
import { digestMcpOauthRevocationField } from '../modules/mcp/index.js';
import { createPostgresAccountCredentialPorts } from '../infrastructure/auth/account-credentials-postgres.js';
import type { CurrentBindingVerifier } from '../infrastructure/automation/index.js';
import { createGrantMachineBindingPort } from './account-credential-grant-composition.js';
import type { AppConfig } from './config.js';

/** Reuses the credential authority/epoch machinery. No bearer or new authentication class. */
export function createAutomationBindingVerifier(config: AppConfig,securityEpoch: () => Promise<string>): CurrentBindingVerifier {
  const machine = config.accountCredentials.enabled ? createGrantMachineBindingPort(config,securityEpoch) : null;
  return async (tx,actor) => {
    const currentEpoch = await securityEpoch();
    if (actor.securityEpoch !== currentEpoch || !actor.resourceAudience) throw unavailable();
    const credential = await tx.selectFrom('account_credentials').select('id').where('mcp_client_id','=',actor.clientId).executeTakeFirst();
    if (credential && machine) {
      const ports = createPostgresAccountCredentialPorts(tx);
      const authority = await loadCredentialAuthority(ports,credential.id);
      if (!authority || authority.account.id !== actor.accountId) throw unavailable();
      const current = await currentMachineBinding({ machine },authority,actor.resourceAudience);
      if (!storedBindingMatches(current,{ kind: 'authenticated',principalId: actor.accountId,clientId: actor.clientId,credentialBindingId: actor.credentialBindingId,
        resourceAudience: actor.resourceAudience,securityEpoch: actor.securityEpoch })) throw unavailable();
      return { dedicated: actor.scopes.every(scope => scope === 'automation:work' || scope === 'offline_access') };
    }
    // OAuth observations are token-free evidence written only after the existing verifier succeeded.
    const stored = (await sql<{ observation_json: Record<string,unknown> | null }>`SELECT observation_json FROM automation_connection_profiles
      WHERE owner_id=${actor.accountId} AND configuration_json->>'authorizedClientId'=${actor.clientId}
        AND configuration_json->>'credentialBindingId'=${actor.credentialBindingId}`.execute(tx)).rows[0]?.observation_json;
    const account = await tx.selectFrom('accounts').select('security_epoch').where('id','=',actor.accountId).executeTakeFirst();
    const observedAccountEpoch = actor.accountSecurityEpoch ?? stored?.accountSecurityEpoch;
    if (!account || typeof observedAccountEpoch !== 'string' || String(account.security_epoch) !== observedAccountEpoch) throw unavailable();
    const digest = actor.credentialDigest ?? stored?.credentialDigest,expiresAt = actor.expiresAt ?? stored?.expiresAt,issued = actor.issuedAtSeconds ?? stored?.issuedAtSeconds;
    if (typeof digest !== 'string' || typeof expiresAt !== 'string' || typeof issued !== 'number' || !Number.isSafeInteger(issued)) throw unavailable();
    const verdict = (await sql<{ revoked: boolean }>`SELECT (
      ${expiresAt}::timestamptz<=clock_timestamp()
      OR EXISTS(SELECT 1 FROM mcp_oauth_revocations WHERE credential_digest=${digest})
      OR EXISTS(SELECT 1 FROM mcp_oauth_client_revocations WHERE client_id_digest=${digestMcpOauthRevocationField(actor.clientId)})
      OR EXISTS(SELECT 1 FROM mcp_oauth_subject_revocations WHERE client_id_digest=${digestMcpOauthRevocationField(actor.clientId)}
        AND subject_digest=${digestMcpOauthRevocationField(actor.subjectId)} AND revoked_at>=to_timestamp(${issued}))) AS revoked`.execute(tx)).rows[0];
    if (!verdict || verdict.revoked) throw unavailable();
    return { dedicated: false };
  };
}
const unavailable = () => new AutomationError('resource_not_found','Current credential authority is unavailable.');
