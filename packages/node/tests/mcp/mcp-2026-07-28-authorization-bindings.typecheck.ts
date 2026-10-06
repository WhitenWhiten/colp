/**
 * COLP-MCP-04: compile-time rejection of anonymous bindings in authenticated
 * Plan/Write APIs and cross-kind confusion at the type level.
 *
 * This file is never executed (vitest only discovers `*.test.ts`); it is
 * type-checked by `npm run typecheck`. Every `@ts-expect-error` below must
 * actually error, so `tsc --noEmit` passing proves the compile-time contract:
 * the anonymous branch cannot reach authenticated-only APIs and the
 * discriminated union cannot be impersonated.
 */
import type {
  McpAnonymousAuthorizationBinding,
  McpAuthenticatedAuthorizationBinding,
  McpAuthorizationBinding,
  McpApiKeyCredentialEvidence,
  McpOAuthCredentialEvidence,
} from '../../src/mcp/shared/authorization.js';
import {
  assertAuthenticatedBinding,
  createAnonymousPublicBinding,
  createAuthenticatedBinding,
  mapApiKeyEvidenceToAuthenticatedBinding,
  mapOAuthEvidenceToAuthenticatedBinding,
  requireAuthenticatedWriteBinding,
} from '../../src/mcp/shared/authorization.js';

const anon = createAnonymousPublicBinding({
  resourceAudience: 'urn:colp:resource:public',
  securityEpoch: 'epoch-1',
});

const oauthEvidence: McpOAuthCredentialEvidence = {
  credentialKind: 'oauth',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-binding-1',
  resourceAudience: 'urn:colp:resource:public',
  securityEpoch: 'epoch-1',
};

const apiKeyEvidence: McpApiKeyCredentialEvidence = {
  credentialKind: 'api-key',
  principalId: 'principal-1',
  clientId: 'key-id-1',
  credentialBindingId: 'credential-binding-1',
  resourceAudience: 'urn:colp:resource:public',
  securityEpoch: 'epoch-1',
};

// @ts-expect-error anonymous bindings are not assignable to authenticated bindings
export const anonAsAuthenticated: McpAuthenticatedAuthorizationBinding = anon;

export function writePlanApi(binding: McpAuthenticatedAuthorizationBinding): string {
  return `${binding.clientId}:${binding.credentialBindingId}`;
}

// @ts-expect-error Plan/Write APIs reject the anonymous branch at compile time
export const anonPlan = writePlanApi(anon);

// @ts-expect-error Plan/Write APIs reject the anonymous branch at compile time
export const anonPlanViaUnion = writePlanApi(anon satisfies McpAuthorizationBinding);

export function planGateway(binding: McpAuthorizationBinding): string {
  assertAuthenticatedBinding(binding);
  // Narrowed to the authenticated branch: authenticated-only fields are usable.
  return `${binding.clientId}:${binding.credentialBindingId}`;
}

// @ts-expect-error authenticated-only fields are only visible after narrowing
export const untrustedClientId = (binding: McpAuthorizationBinding): string => binding.clientId;

export const oauthBinding: McpAuthenticatedAuthorizationBinding =
  mapOAuthEvidenceToAuthenticatedBinding(oauthEvidence);
export const genericBinding: McpAuthenticatedAuthorizationBinding =
  createAuthenticatedBinding(apiKeyEvidence);
export const narrowedBinding: McpAuthenticatedAuthorizationBinding =
  requireAuthenticatedWriteBinding(oauthBinding);

// @ts-expect-error API Key evidence must not map through the OAuth mapper
export const confusedEvidence = mapOAuthEvidenceToAuthenticatedBinding(apiKeyEvidence);

export const confusedAnon: McpAnonymousAuthorizationBinding = {
  kind: 'anonymous',
  principalId: 'public',
  // @ts-expect-error anonymous bindings cannot carry authenticated-only fields
  clientId: 'client-1',
  resourceAudience: 'urn:colp:resource:public',
  securityEpoch: 'epoch-1',
};

export const oauthKind: McpAuthorizationBinding = {
  // @ts-expect-error the binding kind discriminant only accepts anonymous | authenticated
  kind: 'oauth',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-binding-1',
  resourceAudience: 'urn:colp:resource:public',
  securityEpoch: 'epoch-1',
};