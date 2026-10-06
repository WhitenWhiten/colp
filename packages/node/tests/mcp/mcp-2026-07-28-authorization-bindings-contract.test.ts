/**
 * COLP-MCP-04: generic MCP authorization bindings contract.
 *
 * Verifies the fixed anonymous/authenticated discriminated union, the strict
 * snapshot/freeze validator, token-free host evidence mapping (OAuth, API Key,
 * Service, stdio), authenticated-only Plan/Write helpers, resource audience and
 * security epoch mismatch handling, and raw-secret-marker rejection.
 */
import { describe, expect, it } from 'vitest';

import {
  McpAuthorizationBindingError,
  assertAuthenticatedBinding,
  assertBindingMatchesResourceAudience,
  assertBindingMatchesSecurityEpoch,
  bindingMatchesResourceAudience,
  bindingMatchesSecurityEpoch,
  containsRawSecretMarker,
  createAnonymousPublicBinding,
  createAuthenticatedBinding,
  isMcpAnonymousAuthorizationBinding,
  isMcpAuthenticatedAuthorizationBinding,
  isMcpAuthorizationBinding,
  mapApiKeyEvidenceToAuthenticatedBinding,
  mapOAuthEvidenceToAuthenticatedBinding,
  mapServiceEvidenceToAuthenticatedBinding,
  mapStdioEvidenceToAuthenticatedBinding,
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAnonymousAuthorizationBinding,
  type McpAnonymousBindingInput,
  type McpApiKeyCredentialEvidence,
  type McpAuthenticatedAuthorizationBinding,
  type McpAuthorizationBinding,
  type McpAuthorizationBindingErrorCode,
  type McpHostCredentialEvidence,
  type McpOAuthCredentialEvidence,
  type McpServiceCredentialEvidence,
  type McpStdioCredentialEvidence,
} from '../../src/mcp/shared/authorization.js';

const AUDIENCE = 'urn:colp:resource:public';
const EPOCH = 'epoch-2026-07-28-01';

function validAnonymous(): McpAnonymousAuthorizationBinding {
  return { kind: 'anonymous', principalId: 'public', resourceAudience: AUDIENCE, securityEpoch: EPOCH };
}

function validAuthenticated(): McpAuthenticatedAuthorizationBinding {
  return {
    kind: 'authenticated',
    principalId: 'principal-1',
    clientId: 'client-1',
    credentialBindingId: 'credential-binding-1',
    resourceAudience: AUDIENCE,
    securityEpoch: EPOCH,
  };
}

function oauthEvidence(): McpOAuthCredentialEvidence {
  return {
    credentialKind: 'oauth',
    principalId: 'principal-1',
    clientId: 'client-1',
    credentialBindingId: 'credential-binding-1',
    resourceAudience: AUDIENCE,
    securityEpoch: EPOCH,
  };
}

function apiKeyEvidence(): McpApiKeyCredentialEvidence {
  return { ...oauthEvidence(), credentialKind: 'api-key' };
}

function serviceEvidence(): McpServiceCredentialEvidence {
  return { ...oauthEvidence(), credentialKind: 'service' };
}

function stdioEvidence(): McpStdioCredentialEvidence {
  return { ...oauthEvidence(), credentialKind: 'stdio' };
}

function expectErrorCode(run: () => unknown, code: McpAuthorizationBindingErrorCode): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(McpAuthorizationBindingError);
  expect((error as McpAuthorizationBindingError).code).toBe(code);
}

function expectAuthenticated(binding: McpAuthenticatedAuthorizationBinding): void {
  expect(binding).toEqual(validAuthenticated());
  expect(Object.isFrozen(binding)).toBe(true);
}

describe('MCP 2026-07-28 generic authorization bindings (COLP-MCP-04)', () => {
  it('exposes the fixed anonymous/authenticated discriminated union contract', () => {
    const anonymous: McpAuthorizationBinding = validAnonymous();
    const authenticated: McpAuthorizationBinding = validAuthenticated();

    expect(anonymous.kind).toBe('anonymous');
    expect(authenticated.kind).toBe('authenticated');
    expect(anonymous.principalId).toBe('public');

    expect(Object.keys(anonymous).sort()).toEqual(['kind', 'principalId', 'resourceAudience', 'securityEpoch']);
    expect(Object.keys(authenticated).sort()).toEqual([
      'clientId',
      'credentialBindingId',
      'kind',
      'principalId',
      'resourceAudience',
      'securityEpoch',
    ]);
  });

  it('builds a frozen anonymous public binding from verified audience and epoch', () => {
    const binding = createAnonymousPublicBinding({ resourceAudience: AUDIENCE, securityEpoch: EPOCH });
    expect(binding).toEqual(validAnonymous());
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it('rejects malformed anonymous public binding input', () => {
    expectErrorCode(() => createAnonymousPublicBinding({ resourceAudience: '', securityEpoch: EPOCH }), 'empty_id');
    expectErrorCode(() => createAnonymousPublicBinding({ resourceAudience: AUDIENCE, securityEpoch: '   ' }), 'empty_id');
    expectErrorCode(
      () => createAnonymousPublicBinding({ resourceAudience: AUDIENCE, securityEpoch: 7 } as unknown as McpAnonymousBindingInput),
      'non_string_text',
    );
    expectErrorCode(
      () => createAnonymousPublicBinding({ resourceAudience: AUDIENCE, securityEpoch: EPOCH, extra: 1 } as unknown as McpAnonymousBindingInput),
      'unknown_field',
    );
    expectErrorCode(
      () => createAnonymousPublicBinding({ resourceAudience: AUDIENCE } as unknown as McpAnonymousBindingInput),
      'missing_field',
    );
    expectErrorCode(
      () => createAnonymousPublicBinding(new Proxy({ resourceAudience: AUDIENCE, securityEpoch: EPOCH }, {})),
      'invalid_binding',
    );
  });

  it('maps verified OAuth evidence to a token-free authenticated binding', () => {
    expectAuthenticated(mapOAuthEvidenceToAuthenticatedBinding(oauthEvidence()));
  });

  it('maps verified API Key evidence to a token-free authenticated binding', () => {
    expectAuthenticated(mapApiKeyEvidenceToAuthenticatedBinding(apiKeyEvidence()));
  });

  it('maps verified Service evidence to a token-free authenticated binding', () => {
    expectAuthenticated(mapServiceEvidenceToAuthenticatedBinding(serviceEvidence()));
  });

  it('maps verified stdio host evidence to a token-free authenticated binding [evidence:mcp.stdio-credentials]', () => {
    expectAuthenticated(mapStdioEvidenceToAuthenticatedBinding(stdioEvidence()));
  });

  it('dispatches every verified host credential kind through createAuthenticatedBinding [evidence:mcp.stdio-credentials]', () => {
    const evidences: readonly McpHostCredentialEvidence[] = [oauthEvidence(), apiKeyEvidence(), serviceEvidence(), stdioEvidence()];
    for (const evidence of evidences) {
      expectAuthenticated(createAuthenticatedBinding(evidence));
    }
  });

  it('rejects evidence whose credentialKind does not match the mapping function [evidence:mcp.stdio-credentials]', () => {
    expectErrorCode(
      () => mapOAuthEvidenceToAuthenticatedBinding(apiKeyEvidence() as unknown as McpOAuthCredentialEvidence),
      'credential_kind_mismatch',
    );
    expectErrorCode(
      () => mapStdioEvidenceToAuthenticatedBinding(oauthEvidence() as unknown as McpStdioCredentialEvidence),
      'credential_kind_mismatch',
    );
    expectErrorCode(
      () => createAuthenticatedBinding({ ...oauthEvidence(), credentialKind: 'session' } as unknown as McpHostCredentialEvidence),
      'invalid_kind',
    );
  });

  it('rejects missing, extra, empty and non-string fields in credential evidence', () => {
    expectErrorCode(
      () => mapOAuthEvidenceToAuthenticatedBinding({ ...oauthEvidence(), credentialKind: undefined } as unknown as McpOAuthCredentialEvidence),
      'invalid_kind',
    );
    const missingClientId = { ...oauthEvidence() } as Record<string, unknown>;
    delete missingClientId.clientId;
    expectErrorCode(
      () => mapOAuthEvidenceToAuthenticatedBinding(missingClientId as unknown as McpOAuthCredentialEvidence),
      'missing_field',
    );
    expectErrorCode(
      () => mapOAuthEvidenceToAuthenticatedBinding({ ...oauthEvidence(), scope: 'extra' } as unknown as McpOAuthCredentialEvidence),
      'unknown_field',
    );
    expectErrorCode(
      () => mapOAuthEvidenceToAuthenticatedBinding({ ...oauthEvidence(), principalId: '' } as unknown as McpOAuthCredentialEvidence),
      'empty_id',
    );
    expectErrorCode(
      () => mapOAuthEvidenceToAuthenticatedBinding({ ...oauthEvidence(), securityEpoch: 99 } as unknown as McpOAuthCredentialEvidence),
      'non_string_text',
    );
  });

  it('rejects accessor/proxy evidence and never invokes getters', () => {
    let getterCalls = 0;
    const accessorEvidence = oauthEvidence();
    Object.defineProperty(accessorEvidence, 'clientId', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return 'client-1';
      },
    });
    expectErrorCode(
      () => mapOAuthEvidenceToAuthenticatedBinding(accessorEvidence as unknown as McpOAuthCredentialEvidence),
      'accessor_property',
    );
    expect(getterCalls).toBe(0);
    expectErrorCode(() => mapOAuthEvidenceToAuthenticatedBinding(new Proxy(oauthEvidence(), {})), 'invalid_binding');
  });

  it('snapshots evidence so mutation after the call cannot affect the binding', () => {
    const input = { ...oauthEvidence() } as Record<string, unknown>;
    const binding = mapOAuthEvidenceToAuthenticatedBinding(
      input as unknown as McpOAuthCredentialEvidence,
    );
    input.clientId = 'mutated-client';
    input.resourceAudience = 'mutated-audience';
    expect(binding.clientId).toBe('client-1');
    expect(binding.resourceAudience).toBe(AUDIENCE);
    expect(binding).not.toBe(input);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it('refuses raw credential material in evidence and in the produced binding', () => {
    expectErrorCode(
      () => mapOAuthEvidenceToAuthenticatedBinding({ ...oauthEvidence(), clientId: 'sk-live-1234567890abcdef' } as unknown as McpOAuthCredentialEvidence),
      'raw_secret_marker',
    );
    expectErrorCode(
      () => mapOAuthEvidenceToAuthenticatedBinding({ ...oauthEvidence(), token: 'abc123' } as unknown as McpOAuthCredentialEvidence),
      'unknown_field',
    );

    const binding = mapOAuthEvidenceToAuthenticatedBinding(oauthEvidence());
    expect(binding).not.toHaveProperty('token');
    expect(binding).not.toHaveProperty('secret');
    expect(binding).not.toHaveProperty('apiKey');
    expect(binding).not.toHaveProperty('authorization');
    expect(containsRawSecretMarker(binding)).toBe(false);
  });

  it('validates anonymous and authenticated binding literals through the strict snapshot validator', () => {
    const anonymous = snapshotMcpAuthorizationBinding(validAnonymous());
    const authenticated = snapshotMcpAuthorizationBinding(validAuthenticated());
    expect(anonymous).toEqual(validAnonymous());
    expect(authenticated).toEqual(validAuthenticated());
    expect(Object.isFrozen(anonymous)).toBe(true);
    expect(Object.isFrozen(authenticated)).toBe(true);
  });

  it('rejects missing and extra fields', () => {
    const missingAudience = { ...validAuthenticated() } as Record<string, unknown>;
    delete missingAudience.resourceAudience;
    expectErrorCode(() => snapshotMcpAuthorizationBinding(missingAudience), 'missing_field');
    expectErrorCode(
      () =>
        snapshotMcpAuthorizationBinding({
          kind: 'authenticated',
          principalId: 'principal-1',
          clientId: 'client-1',
          resourceAudience: AUDIENCE,
          securityEpoch: EPOCH,
        }),
      'missing_field',
    );
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAnonymous(), scope: 'read' }), 'unknown_field');
    const withSymbol = validAnonymous();
    Object.defineProperty(withSymbol, Symbol('hidden'), { enumerable: true, value: 1 });
    expectErrorCode(() => snapshotMcpAuthorizationBinding(withSymbol), 'unknown_field');
  });

  it('rejects empty ids and whitespace-only ids', () => {
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAuthenticated(), clientId: '' }), 'empty_id');
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAuthenticated(), principalId: '   ' }), 'empty_id');
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAnonymous(), resourceAudience: '' }), 'empty_id');
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAnonymous(), securityEpoch: '' }), 'empty_id');
  });

  it('rejects non-string text fields', () => {
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAnonymous(), resourceAudience: 42 }), 'non_string_text');
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAnonymous(), securityEpoch: null }), 'non_string_text');
    expectErrorCode(
      () => snapshotMcpAuthorizationBinding({ ...validAuthenticated(), credentialBindingId: { id: 'credential-binding-1' } }),
      'non_string_text',
    );
  });

  it('rejects proxies, arrays, class instances and non-enumerable data', () => {
    expectErrorCode(() => snapshotMcpAuthorizationBinding(new Proxy(validAuthenticated(), {})), 'invalid_binding');
    expectErrorCode(() => snapshotMcpAuthorizationBinding(Object.freeze([validAuthenticated()])), 'invalid_binding');
    class BindingLike {
      readonly kind = 'anonymous' as const;
      readonly principalId = 'public' as const;
      readonly resourceAudience = AUDIENCE;
      readonly securityEpoch = EPOCH;
    }
    expectErrorCode(() => snapshotMcpAuthorizationBinding(new BindingLike()), 'invalid_binding');
    const nonEnumerable = validAuthenticated();
    Object.defineProperty(nonEnumerable, 'clientId', { enumerable: false, configurable: true, value: 'client-1' });
    expectErrorCode(() => snapshotMcpAuthorizationBinding(nonEnumerable), 'invalid_binding');
  });

  it('rejects accessor properties without invoking them', () => {
    let getterCalls = 0;
    const input = validAuthenticated();
    Object.defineProperty(input, 'clientId', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return 'client-1';
      },
    });
    expectErrorCode(() => snapshotMcpAuthorizationBinding(input), 'accessor_property');
    expect(getterCalls).toBe(0);

    const setterOnly = validAnonymous();
    Object.defineProperty(setterOnly, 'securityEpoch', { enumerable: true, configurable: true, set() {} });
    expectErrorCode(() => snapshotMcpAuthorizationBinding(setterOnly), 'accessor_property');
  });

  it('rejects cross-kind confusion between anonymous and authenticated', () => {
    // Anonymous must not carry authenticated-only fields.
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAnonymous(), clientId: 'client-1' }), 'unknown_field');
    // Authenticated must not drop authenticated-only fields.
    expectErrorCode(
      () =>
        snapshotMcpAuthorizationBinding({
          ...validAuthenticated(),
          credentialBindingId: undefined,
        } as unknown as McpAuthorizationBinding),
      'non_string_text',
    );
    // The kind discriminant only accepts the two fixed values.
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAuthenticated(), kind: 'oauth' }), 'invalid_kind');
    // Anonymous principal is fixed to 'public'.
    expectErrorCode(() => snapshotMcpAuthorizationBinding({ ...validAnonymous(), principalId: 'someone-else' }), 'invalid_principal');
  });

  it('snapshots bindings so mutation after the call cannot affect the result', () => {
    const input = { ...validAuthenticated() } as Record<string, unknown>;
    const binding = snapshotMcpAuthorizationBinding(input) as McpAuthenticatedAuthorizationBinding;
    input.clientId = 'mutated-client';
    input.resourceAudience = 'mutated-audience';
    expect(binding.clientId).toBe('client-1');
    expect(binding.resourceAudience).toBe(AUDIENCE);
    expect(binding).not.toBe(input);

    const second = snapshotMcpAuthorizationBinding(binding);
    expect(second).toEqual(binding);
    expect(second).not.toBe(binding);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('rejects raw secret markers inside binding fields', () => {
    expectErrorCode(
      () => snapshotMcpAuthorizationBinding({ ...validAuthenticated(), clientId: 'Bearer abc123' }),
      'raw_secret_marker',
    );
    expectErrorCode(
      () => snapshotMcpAuthorizationBinding({ ...validAnonymous(), resourceAudience: 'ghp_1234567890abcdef' }),
      'raw_secret_marker',
    );
  });

  it('provides boolean predicates for the union and its branches', () => {
    expect(isMcpAuthorizationBinding(validAnonymous())).toBe(true);
    expect(isMcpAuthorizationBinding(validAuthenticated())).toBe(true);
    expect(isMcpAuthorizationBinding({ kind: 'nope' })).toBe(false);
    expect(isMcpAuthorizationBinding(null)).toBe(false);
    expect(isMcpAnonymousAuthorizationBinding(validAnonymous())).toBe(true);
    expect(isMcpAnonymousAuthorizationBinding(validAuthenticated())).toBe(false);
    expect(isMcpAuthenticatedAuthorizationBinding(validAuthenticated())).toBe(true);
    expect(isMcpAuthenticatedAuthorizationBinding(validAnonymous())).toBe(false);
  });

  it('narrows authenticated bindings through the authenticated-only helpers', () => {
    expect(() => assertAuthenticatedBinding(validAuthenticated())).not.toThrow();
    expectErrorCode(() => assertAuthenticatedBinding(validAnonymous()), 'anonymous_write_forbidden');
    expect(requireAuthenticatedWriteBinding(validAuthenticated())).toEqual(validAuthenticated());
    expectErrorCode(() => requireAuthenticatedWriteBinding(validAnonymous()), 'anonymous_write_forbidden');
  });

  it('checks resource audience and security epoch participation', () => {
    expect(bindingMatchesResourceAudience(validAuthenticated(), AUDIENCE)).toBe(true);
    expect(bindingMatchesResourceAudience(validAuthenticated(), 'other-audience')).toBe(false);
    expect(bindingMatchesSecurityEpoch(validAnonymous(), EPOCH)).toBe(true);
    expect(bindingMatchesSecurityEpoch(validAnonymous(), 'other-epoch')).toBe(false);

    expect(() => assertBindingMatchesResourceAudience(validAuthenticated(), AUDIENCE)).not.toThrow();
    expectErrorCode(
      () => assertBindingMatchesResourceAudience(validAuthenticated(), 'other-audience'),
      'resource_audience_mismatch',
    );
    expect(() => assertBindingMatchesSecurityEpoch(validAnonymous(), EPOCH)).not.toThrow();
    expectErrorCode(
      () => assertBindingMatchesSecurityEpoch(validAnonymous(), 'other-epoch'),
      'security_epoch_mismatch',
    );
  });

  it('flags recognizable raw credential material and ignores stable identifiers', () => {
    expect(containsRawSecretMarker('Bearer eyJhbGciOiJSUzI1NiJ9.token')).toBe(true);
    expect(containsRawSecretMarker('Basic dXNlcjpwYXNz')).toBe(true);
    expect(containsRawSecretMarker('sk-live-1234567890abcdef')).toBe(true);
    expect(containsRawSecretMarker({ token: 'abc123' })).toBe(true);
    expect(containsRawSecretMarker({ nested: { apiKey: 'x' } })).toBe(true);
    expect(containsRawSecretMarker(['ghp_1234567890abcdef'])).toBe(true);

    expect(containsRawSecretMarker('principal-1')).toBe(false);
    expect(containsRawSecretMarker('client-1')).toBe(false);
    expect(containsRawSecretMarker({ principalId: 'principal-1', clientId: 'client-1' })).toBe(false);
    expect(containsRawSecretMarker(null)).toBe(false);
    expect(containsRawSecretMarker(42)).toBe(false);
    expect(containsRawSecretMarker(new Proxy({}, {}))).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(containsRawSecretMarker(cyclic)).toBe(false);
  });
});