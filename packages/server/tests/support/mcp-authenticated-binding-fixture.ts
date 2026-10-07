import {
  createAuthenticatedBinding,
  type McpAuthenticatedAuthorizationBinding,
} from '@know-n/colp/mcp';

export type { McpAuthenticatedAuthorizationBinding };

/**
 * COLP-MCP-05 test fixture: builds immutable authenticated authorization
 * bindings through the shared snapshot/freeze factory (never hand-frozen
 * literals) so Plan/Approval tests exercise the exact production binding.
 */

export const FIXTURE_RESOURCE_AUDIENCE = 'urn:colp:resource:public';
export const FIXTURE_SECURITY_EPOCH = 'epoch-2026-07-28-01';

export function authenticatedBinding(
  overrides: Readonly<Partial<Omit<McpAuthenticatedAuthorizationBinding, 'kind'>>> = {},
): McpAuthenticatedAuthorizationBinding {
  return createAuthenticatedBinding({
    credentialKind: 'oauth',
    principalId: 'user-a',
    clientId: 'client-a',
    credentialBindingId: 'credential-binding-a',
    resourceAudience: FIXTURE_RESOURCE_AUDIENCE,
    securityEpoch: FIXTURE_SECURITY_EPOCH,
    ...overrides,
  });
}

export const bindingA: McpAuthenticatedAuthorizationBinding = authenticatedBinding();

export const bindingB: McpAuthenticatedAuthorizationBinding = authenticatedBinding({
  principalId: 'user-b',
});