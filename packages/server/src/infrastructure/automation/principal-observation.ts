import type { WorkPrincipal } from '../../modules/automation/index.js';
/** Persist only verified token-free binding evidence, never a raw request or bearer. */
export function principalObservation(actor:WorkPrincipal){
  return {accountId:actor.accountId,subjectId:actor.subjectId,clientId:actor.clientId,credentialBindingId:actor.credentialBindingId,
    resourceAudience:actor.resourceAudience ?? null,securityEpoch:actor.securityEpoch ?? null,scopes:[...actor.scopes],
    credentialDigest:actor.credentialDigest ?? null,expiresAt:actor.expiresAt ?? null,issuedAtSeconds:actor.issuedAtSeconds ?? null,
    accountSecurityEpoch:actor.accountSecurityEpoch ?? null};
}
