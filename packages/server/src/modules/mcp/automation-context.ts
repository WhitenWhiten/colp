import type { WorkPrincipal } from '../automation/index.js';
import type { McpApplicationContext } from './application-context.js';
import { requireMcpAccountSubjectId } from './account-context.js';

/** Convert only the existing verified, token-free host context. This does not authenticate a request. */
export function automationWorkPrincipal(context: McpApplicationContext): WorkPrincipal {
  if (context.principal.kind !== 'authenticated') throw new TypeError('Automation requires an authenticated MCP context.');
  const p = context.principal;
  const observation = context.authorization.automationCredential as Readonly<Record<string,unknown>> | undefined;
  return { accountId: p.principalId,subjectId: requireMcpAccountSubjectId(context.authorization),clientId: p.clientId,
    credentialBindingId: typeof observation?.connectionId === 'string' ? observation.connectionId : p.credentialBindingId,resourceAudience: p.resourceAudience,securityEpoch: p.securityEpoch,scopes: context.scopes,
    ...(typeof observation?.credentialDigest === 'string' ? { credentialDigest: observation.credentialDigest } : {}),
    ...(typeof observation?.expiresAt === 'string' ? { expiresAt: observation.expiresAt } : {}),
    ...(typeof observation?.issuedAtSeconds === 'number' ? { issuedAtSeconds: observation.issuedAtSeconds } : {}),
    ...(typeof observation?.accountSecurityEpoch === 'string' ? { accountSecurityEpoch: observation.accountSecurityEpoch } : {}) };
}
