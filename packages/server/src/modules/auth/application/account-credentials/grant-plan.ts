import { loadCredentialAuthority, type CredentialAuthoritySnapshot } from './authority.js';
import { grantActionsCoverScopes, type CredentialGrantAction } from './grant-actions.js';
import type {
  CredentialGrantCommandPorts,
  CredentialGrantRecord,
  StoredCredentialPlan,
  StoredPlanBinding,
} from './grant-types.js';

export async function currentMachineBinding(
  ports: CredentialGrantCommandPorts,
  snapshot: CredentialAuthoritySnapshot,
  resourceAudience: string,
): Promise<StoredPlanBinding> {
  const serverSecurityEpoch = await ports.machine.securityEpoch();
  const accountEpoch = snapshot.account.securityEpoch.toString(10);
  const credentialEpoch = snapshot.credential.epoch.toString(10);
  return {
    kind: 'authenticated',
    principalId: snapshot.account.id,
    clientId: snapshot.credential.mcpClientId,
    credentialBindingId: ports.machine.expectedBindingId({
      clientId: snapshot.credential.mcpClientId,
      credentialId: snapshot.credential.id,
      resourceAudience,
      accountEpoch,
      credentialEpoch,
      ancestorEpochDigest: snapshot.ancestorEpoch,
      serverSecurityEpoch,
    }),
    resourceAudience,
    securityEpoch: serverSecurityEpoch,
  };
}

export function storedBindingMatches(
  stored: StoredPlanBinding,
  current: StoredPlanBinding,
): boolean {
  return stored.kind === current.kind
    && stored.principalId === current.principalId
    && stored.clientId === current.clientId
    && stored.credentialBindingId === current.credentialBindingId
    && stored.resourceAudience === current.resourceAudience
    && stored.securityEpoch === current.securityEpoch;
}

export function grantMatchesPlan(
  grant: CredentialGrantRecord,
  plan: StoredCredentialPlan,
): boolean {
  if (grant.resource.kind !== plan.planKind) return false;
  if (plan.resourceIds.length !== 1 || plan.resourceIds[0] !== grant.resource.id) return false;
  if (!plan.requiredActions || plan.requiredActions.length === 0) return false;
  if (!plan.requiredActions.every((action) => grant.actions.includes(action))) return false;
  return grantActionsCoverScopes(grant.actions as readonly CredentialGrantAction[], plan.requiredScopes);
}

export async function loadActiveChildSnapshot(
  ports: CredentialGrantCommandPorts,
  credentialId: string,
): Promise<CredentialAuthoritySnapshot | null> {
  return loadCredentialAuthority(ports, credentialId);
}
