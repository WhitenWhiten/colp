/**
 * PR5 composition cookbook smoke.
 *
 * Freezes the recommended guard order at the API import surface so
 * `docs/SECURITY_COMPOSITION.md` cannot drift to non-existent renames without
 * breaking CI. Names below mirror that cookbook sketch and pipeline table.
 *
 * Explicit non-claims:
 * - This is **not** end-to-end security verification.
 * - Full OAuth/DPoP success paths, adapter HTTP middleware, Profile claims,
 *   and conformance evidence are out of scope.
 * - Steps that need heavy ports use typeof-only checks or documented
 *   `not_applicable` short-circuits only.
 *
 * Evidence: [evidence:security.composition-cookbook]
 */
import { describe, expect, it, vi } from 'vitest';

import {
  calculateExpandedOperationCost,
  emitContentIntegrityHeaders,
  enforceApiKeyOnlyTransport,
  enforceApiKeyTransport,
  enforceCredentialRestrictions,
  enforceOAuth21Profile,
  enforcePublisherAdmission,
  enforcePublisherStreamableHttpBoundary,
  enforceRateLimitForOperation,
  enforceSenderConstraint,
  enforceSubscriptionLimits,
  evaluateEffectiveScopes,
  hasEffectiveScope,
  resolveRequestIdentities,
  serializeRateLimitFields,
  type AtomicRateLimitCharge,
  type AtomicRateLimitPort,
  type AtomicRateLimitResult,
  type OAuth21ProfileInput,
  type OAuth21ProfilePorts,
  type TrustedTransportEvidence,
} from '../../src/security/index.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';

const evidence = '[evidence:security.composition-cookbook]';

/**
 * Names mirrored from docs/SECURITY_COMPOSITION.md §3 pipeline + §6 sketch.
 * `enforceApiKeyTransport` is the alias target of `enforceApiKeyOnlyTransport`.
 * `calculateExpandedOperationCost` is the sync SEC-0013 sample companion to
 * `enforcePublisherAdmission` (admission remains typeof / heavy-port only here).
 */
const COOKBOOK_EXPORTS = {
  enforcePublisherStreamableHttpBoundary,
  enforceApiKeyOnlyTransport,
  enforceApiKeyTransport,
  enforceOAuth21Profile,
  resolveRequestIdentities,
  evaluateEffectiveScopes,
  hasEffectiveScope,
  enforceCredentialRestrictions,
  enforceSenderConstraint,
  enforceRateLimitForOperation,
  serializeRateLimitFields,
  calculateExpandedOperationCost,
  enforcePublisherAdmission,
  enforceSubscriptionLimits,
  emitContentIntegrityHeaders,
} as const;

function publicHttpsStreamable(
  overrides: Partial<TrustedTransportEvidence> = {},
): TrustedTransportEvidence {
  return {
    networkExposure: 'public',
    tlsTerminated: true,
    transportScheme: 'https',
    protocol: 'streamable-http',
    requestTarget: '/mcp',
    origin: 'https://app.example.test',
    ...overrides,
  };
}

function openPublicPolicy(): AccessPolicy {
  return {
    visibility: 'public',
    entries: [],
    publication: { listInDirectory: true, allowSearchIndexing: true, allowEmbedding: true },
    revision: 'acl-public-smoke-1',
  };
}

function rateLimitPort(): AtomicRateLimitPort {
  return {
    charge: vi.fn(async (charge: AtomicRateLimitCharge): Promise<AtomicRateLimitResult> => ({
      ceilings: charge.ceilings.map((ceiling) => ({
        dimension: ceiling.dimension,
        key: ceiling.key,
        allowed: true,
        remaining: Math.max(0, ceiling.limit - charge.cost),
        resetSeconds: 20,
      })),
    })),
  };
}

describe(`${evidence} composition cookbook export surface`, () => {
  it(`${evidence} documents only real function exports from security/index`, () => {
    // Prevents doc/cookbook drift: every name below must remain a function export.
    for (const [name, value] of Object.entries(COOKBOOK_EXPORTS)) {
      expect(typeof value, name).toBe('function');
    }
    // Alias parity sample (API-key-only surface).
    expect(enforceApiKeyOnlyTransport).toBe(enforceApiKeyTransport);
  });
});

describe(`${evidence} ordered composition smoke (export surface + order samples only)`, () => {
  it(`${evidence} walks a minimal valid-ish path in recommended guard order`, async () => {
    // --- 1. Request boundary (HTTPS → Origin composition) ---
    const boundary = enforcePublisherStreamableHttpBoundary(publicHttpsStreamable(), {
      allowedOrigins: ['https://app.example.test'],
    });
    expect(boundary.allowed).toBe(true);
    if (boundary.allowed) {
      expect(boundary.remote).toBe(true);
      expect(boundary.https).toMatchObject({ allowed: true });
      expect(boundary.origin).toMatchObject({ allowed: true });
    }

    // Loopback sample: HTTPS not_applicable; the matching Origin is still enforced.
    const loopbackBoundary = enforcePublisherStreamableHttpBoundary(
      publicHttpsStreamable({
        networkExposure: 'loopback',
        tlsTerminated: false,
        transportScheme: 'http',
        requestTarget: '/mcp',
      }),
      { allowedOrigins: ['https://app.example.test'] },
    );
    expect(loopbackBoundary.allowed).toBe(true);
    if (loopbackBoundary.allowed) {
      expect(loopbackBoundary.remote).toBe(false);
      expect(loopbackBoundary.https.reason).toBe('not_applicable');
      expect(loopbackBoundary.origin.reason).toBe('origin_allowed');
    }

    // --- 2. API-key transport (credential-free relative target; no OAuth token) ---
    const apiKeyDecision = enforceApiKeyOnlyTransport({
      requestTarget: '/collections?limit=10',
    });
    expect(apiKeyDecision).toMatchObject({ allowed: true, reason: 'allowed' });

    // --- 3. OAuth 2.1 profile (not_applicable local only — no full DPoP/OAuth success) ---
    const oauthPorts: OAuth21ProfilePorts = {
      authorizationServerProvenance: {
        isAuthorized: vi.fn(async () => {
          throw new Error('OAuth provenance must not run on not-applicable path');
        }),
      },
    };
    const oauthDecision = await enforceOAuth21Profile(oauthPorts, {
      integration: 'local-mcp',
      applicability: 'not-applicable',
    } as OAuth21ProfileInput);
    expect(oauthDecision).toMatchObject({
      allowed: true,
      disposition: 'not_applicable',
      reason: 'not_applicable',
    });
    expect(oauthPorts.authorizationServerProvenance.isAuthorized).not.toHaveBeenCalled();

    // --- 4. Identity resolution + effective scopes (open public policy) ---
    const identities = resolveRequestIdentities({ status: 'anonymous', identities: [] });
    expect(identities).toEqual([{ type: 'public', id: 'public' }]);

    const publicPolicy = openPublicPolicy();
    const scopeInput = {
      grantedScopes: new Set<ScopeName>(['collections:read', 'nodes:read', 'feed:read']),
      identityResolution: {
        status: 'anonymous' as const,
        identities: [] as readonly PrincipalRef[],
      },
      policyChain: {
        serverDefault: publicPolicy,
        collection: publicPolicy,
        ancestors: [] as const,
        object: publicPolicy,
      },
    };
    const effective = evaluateEffectiveScopes(scopeInput);
    expect(effective.has('collections:read')).toBe(true);
    expect(hasEffectiveScope(scopeInput, 'collections:read')).toBe(true);
    expect(hasEffectiveScope(scopeInput, 'nodes:write')).toBe(false);

    // --- 5. Credential restrictions (empty restriction list, non-public exposure) ---
    const credentialDecision = await enforceCredentialRestrictions(
      {},
      {
        credentialId: 'smoke-credential',
        restrictions: [],
        publicExposure: false,
      },
    );
    expect(credentialDecision).toEqual({ allowed: true, reason: 'allowed' });

    // --- 6. Sender constraint (explicit not_applicable for non-admin ops; no DPoP ports) ---
    const senderDecision = await enforceSenderConstraint(
      {},
      {
        operation: 'other',
        location: 'remote',
        applicability: 'not_applicable',
        mode: 'not_applicable',
      },
    );
    expect(senderDecision).toMatchObject({
      allowed: true,
      disposition: 'not_applicable',
      reason: 'not_applicable',
    });

    // --- 7. Rate limit for classified operation ---
    const ratePort = rateLimitPort();
    const rateDecision = await enforceRateLimitForOperation(ratePort, {
      authentication: 'authenticated',
      operation: 'read',
      cost: 1,
      credentialId: 'smoke-credential',
      ipAddress: '203.0.113.7',
      instanceId: 'instance-smoke-1',
      ceilings: {
        credential: { policy: 'read:credential', limit: 100, windowSeconds: 60 },
        ip: { policy: 'read:ip', limit: 1_000, windowSeconds: 60 },
        instance: { policy: 'read:instance', limit: 10_000, windowSeconds: 300 },
      },
    });
    expect(rateDecision).toMatchObject({ allowed: true, reason: 'allowed' });
    expect(ratePort.charge).toHaveBeenCalledOnce();

    // --- 8. Operation cost / admission / subscription (sync cost sample; ports typeof-only) ---
    // Cookbook step 8: enforcePublisherAdmission / enforceSubscriptionLimits need
    // AtomicPublisherAdmissionPort / subscription ports — not faked as full success here.
    const costDecision = calculateExpandedOperationCost([
      { kind: 'read', affectedObjects: 2, writeObjects: 0 },
    ]);
    expect(costDecision).toMatchObject({ calculated: true });
    expect(typeof enforcePublisherAdmission).toBe('function');
    expect(typeof enforceSubscriptionLimits).toBe('function');

    // --- 9. Content integrity header emission (emit-only; not signature verification) ---
    // Cookbook step 10 (response side). Success disposition is headers_emitted only.
    const integrity = emitContentIntegrityHeaders({
      resourceType: 'snapshot',
      visibility: 'public',
      method: 'GET',
      targetUri: 'https://publisher.example.test/collections/c-1/snapshot',
      contentType: 'application/json',
      body: '{"nodes":[]}',
      signature: new Uint8Array(64),
      algorithm: 'ed25519',
      keySource: 'jwks',
      keyId: 'current',
      rotation: { activeKeyId: 'current', retainedKeyIds: ['old'] },
    });
    expect(integrity).toMatchObject({ allowed: true,
      disposition: 'headers_emitted',
    });

    // --- 10. RFC 9651 rate-limit field serialization (attach after charge decision) ---
    const rateLimitHeaders = serializeRateLimitFields({
      policy: 'feed',
      limit: 120,
      remaining: 83,
      resetSeconds: 27,
      windowSeconds: 60,
    });
    expect(rateLimitHeaders).toEqual({
      RateLimit: '"feed";r=83;t=27',
      'RateLimit-Policy': '"feed";q=120;w=60',
    });
  });
});
