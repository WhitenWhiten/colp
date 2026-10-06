/**
 * COLP-MCP-07 test fixture: builds frozen per-request trusted read contexts
 * (anonymous or authenticated) through the shared authorization factories and
 * the read-side budget resolver, mirroring the Write gateway contract suite.
 */
import type { McpAuthorizationBinding } from '../../src/mcp/shared/authorization.js';
import { createAnonymousPublicBinding } from '../../src/mcp/shared/authorization.js';
import type {
  McpResourceReadBudget,
  McpTrustedReadRequestContext,
} from '../../src/mcp/shared/resources.js';
import { resolveMcpResourceReadBudget } from '../../src/mcp/shared/resources.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

export const READ_RESOURCE_AUDIENCE = 'urn:colp:resource:public';
export const READ_SECURITY_EPOCH = 'epoch-2026-07-28-01';

export const DEFAULT_READ_BUDGET: Required<McpResourceReadBudget> = resolveMcpResourceReadBudget();

export function readContext(
  overrides: Readonly<{
    binding?: McpAuthorizationBinding;
    scope?: readonly string[];
    budget?: McpResourceReadBudget;
    abortSignal?: AbortSignal;
    authorization?: Readonly<Record<string, unknown>>;
  }> = {},
): McpTrustedReadRequestContext {
  return Object.freeze({
    binding: overrides.binding ?? authenticatedBinding({
      principalId: 'principal-read',
      clientId: 'client-read',
    }),
    scope: overrides.scope ?? Object.freeze(['collections:read']),
    budget: overrides.budget ?? DEFAULT_READ_BUDGET,
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    authorization: overrides.authorization ?? Object.freeze({
      subject: 'principal-read',
      scopes: Object.freeze(['collections:read']),
    }),
  });
}

export function anonymousReadContext(
  overrides: Readonly<{
    scope?: readonly string[];
    budget?: McpResourceReadBudget;
    abortSignal?: AbortSignal;
    authorization?: Readonly<Record<string, unknown>>;
  }> = {},
): McpTrustedReadRequestContext {
  const anonymous: McpAuthorizationBinding = createAnonymousPublicBinding({
    resourceAudience: READ_RESOURCE_AUDIENCE,
    securityEpoch: READ_SECURITY_EPOCH,
  });
  return Object.freeze({
    binding: anonymous,
    scope: overrides.scope ?? Object.freeze(['public:read']),
    budget: overrides.budget ?? DEFAULT_READ_BUDGET,
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    authorization: overrides.authorization ?? Object.freeze({
      subject: 'public',
      scopes: Object.freeze(['public:read']),
    }),
  });
}
