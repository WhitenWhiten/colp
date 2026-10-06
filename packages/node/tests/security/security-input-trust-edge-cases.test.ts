import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

/**
 * U-1 security coverage gaps — high-risk deny/allow, cost/rate, and
 * snapshot/credential fail-closed branches identified from
 * `coverage/security/` at commit 50c9de7 (lines 92.41 / branches 88.84).
 *
 * Given/When/Then semantics live in each `it` title and body.
 * Assertions use full decisions / stable TypeError messages; secrets are
 * checked against String(error) and JSON.stringify(error).
 */

import {
  OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS,
  calculateExpandedOperationCost,
  classifyRateLimitBucket,
  emitContentIntegrityHeaders,
  enforceApiKeyTransport,
  enforceCredentialRestrictions,
  enforceHttpsFromTransport,
  enforceMutableResourceIntegrity,
  enforceOAuth21Profile,
  enforceOriginFromTransport,
  enforcePublisherAdmission,
  enforcePublisherStreamableHttpBoundary,
  enforceRateLimit,
  enforceRateLimitForOperation,
  enforceSenderConstraint,
  evaluateEffectiveScopes,
  hasEffectiveScope,
  resolveRequestIdentities,
  type CredentialRestrictionPorts,
  type OAuth21ProfileInput,
  type TrustedTransportEvidence,
} from '../../src/security/index.js';
import { enforceHttpsEndpoint } from '../../src/security/https-enforcement.js';
import { enforceOriginGuard } from '../../src/security/origin-guard.js';
import { hasSafeRecordPrototype } from '../../src/security/input-snapshot.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';

const publisher: PrincipalRef = { type: 'service', id: 'publisher' };

function policy(
  scopes: AccessPolicy['entries'][number]['scopes'],
  visibility: AccessPolicy['visibility'] = 'private',
  principal: PrincipalRef = publisher,
): AccessPolicy {
  return {
    visibility,
    entries: [{ principal, effect: 'allow', scopes }],
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'acl-u1-1',
  };
}

function openChain(layer: AccessPolicy) {
  return {
    serverDefault: layer,
    collection: layer,
    ancestors: [] as AccessPolicy[],
    object: layer,
  };
}

function expectEmpty(set: ReadonlySet<ScopeName>): void {
  expect(set.size).toBe(0);
  expect([...set]).toEqual([]);
}

function trustedEvidence(
  overrides: Partial<TrustedTransportEvidence> = {},
): TrustedTransportEvidence {
  return {
    networkExposure: 'public',
    tlsTerminated: true,
    transportScheme: 'https',
    protocol: 'other',
    requestTarget: 'https://publisher.example.test/collections/c-1',
    ...overrides,
  };
}

const ceiling = { policy: 'std', limit: 100, windowSeconds: 60 };

describe('U-1 gaps: effective-scopes deny→empty / identity trust (SEC-0001/0002/0011)', () => {
  it('Given a non-record policy layer, When evaluating scopes, Then returns empty deny-all (does not throw)', () => {
    const layer = policy(['nodes:read']);
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        identities: [publisher],
        policyChain: {
          serverDefault: null as unknown as AccessPolicy,
          collection: layer,
          ancestors: [],
          object: layer,
        },
      }),
    );
    expect(
      hasEffectiveScope(
        {
          grantedScopes: new Set<ScopeName>(['nodes:read']),
          identities: [publisher],
          policyChain: {
            serverDefault: 'not-a-policy' as unknown as AccessPolicy,
            collection: layer,
            ancestors: [],
            object: layer,
          },
        },
        'nodes:read',
      ),
    ).toBe(false);
  });

  it('Given an entry with invalid effect, When evaluating, Then fails closed to empty scopes', () => {
    const broken = {
      ...policy(['nodes:read']),
      entries: [{ principal: publisher, effect: 'permit', scopes: ['nodes:read'] }],
    } as unknown as AccessPolicy;
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        identities: [publisher],
        policyChain: openChain(broken),
      }),
    );
  });

  it('Given an entry with empty scopes, When evaluating, Then fails closed to empty scopes', () => {
    const broken = {
      ...policy(['nodes:read']),
      entries: [{ principal: publisher, effect: 'allow', scopes: [] }],
    } as unknown as AccessPolicy;
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        identities: [publisher],
        policyChain: openChain(broken),
      }),
    );
  });

  it('Given an unknown scope name in an allow entry, When evaluating, Then fails closed to empty scopes', () => {
    const broken = {
      ...policy(['nodes:read']),
      entries: [{ principal: publisher, effect: 'allow', scopes: ['nodes:hack'] }],
    } as unknown as AccessPolicy;
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        identities: [publisher],
        policyChain: openChain(broken),
      }),
    );
  });

  it('Given both identityResolution and legacy identities, When evaluating, Then fails closed (no dual trust)', () => {
    const layer = policy(['nodes:read']);
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        identityResolution: { status: 'authenticated', identities: [publisher] },
        identities: [publisher],
        policyChain: openChain(layer),
      } as never),
    );
  });

  it('Given neither identityResolution nor identities, When evaluating, Then fails closed to empty scopes', () => {
    const layer = policy(['nodes:read']);
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        policyChain: openChain(layer),
      } as never),
    );
  });

  it('Given non-Set grantedScopes, When evaluating, Then starts from empty granted set', () => {
    const layer = policy(['nodes:read']);
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: ['nodes:read'] as unknown as Set<ScopeName>,
        identities: [publisher],
        policyChain: openChain(layer),
      }),
    );
  });

  it('Given a successful evaluation, When using ReadonlySet iterators, Then entries/keys/values/forEach match', () => {
    const layer = policy(['nodes:read', 'collections:read']);
    const effective = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read', 'collections:read']),
      identities: [publisher],
      policyChain: openChain(layer),
    });
    expect([...effective.keys()].sort()).toEqual(['collections:read', 'nodes:read']);
    expect([...effective.values()].sort()).toEqual(['collections:read', 'nodes:read']);
    expect([...effective.entries()].map(([k]) => k).sort()).toEqual(['collections:read', 'nodes:read']);
    const seen: string[] = [];
    effective.forEach((value, value2, set) => {
      expect(value).toBe(value2);
      expect(set).toBe(effective);
      seen.push(value);
    });
    expect(seen.sort()).toEqual(['collections:read', 'nodes:read']);
  });

  it('Given invalid identityResolution discriminator, When resolveRequestIdentities, Then throws stable TypeError', () => {
    expect(() => resolveRequestIdentities({ status: 'maybe', identities: [] } as never)).toThrow(
      /Identity resolution credential state is required/,
    );
    expect(() => resolveRequestIdentities({ status: 'authenticated' } as never)).toThrow(
      /Identity resolution identities are required/,
    );
    expect(() => resolveRequestIdentities({ credentialEstablished: true } as never)).toThrow(
      /Identity resolution identities are required/,
    );
  });

  it('Given sparse identity array via legacy identities, When evaluating, Then fails closed empty', () => {
    const layer = policy(['nodes:read']);
    const sparse = new Array<PrincipalRef>(2);
    sparse[0] = publisher;
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        identities: sparse,
        policyChain: openChain(layer),
      }),
    );
  });

  it('Given identity entry as accessor, When evaluating, Then fails closed without invoking getter', () => {
    const layer = policy(['nodes:read']);
    const getter = vi.fn(() => publisher);
    const identities = Object.defineProperty([publisher], '0', {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        identities: identities as PrincipalRef[],
        policyChain: openChain(layer),
      }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it('Given non-record principal in policy entry, When evaluating, Then fails closed to empty', () => {
    const broken = {
      ...policy(['nodes:read']),
      entries: [{ principal: null, effect: 'allow', scopes: ['nodes:read'] }],
    } as unknown as AccessPolicy;
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        identities: [publisher],
        policyChain: openChain(broken),
      }),
    );
  });

  it('Given non-array identities, When evaluating, Then fails closed to empty', () => {
    const layer = policy(['nodes:read']);
    expectEmpty(
      evaluateEffectiveScopes({
        grantedScopes: new Set<ScopeName>(['nodes:read']),
        identities: { 0: publisher, length: 1 } as never,
        policyChain: openChain(layer),
      }),
    );
  });
});

describe('U-1 gaps: HTTPS / Origin / request-boundary declaration trust (SEC-0015/0016)', () => {
  it('Given absolute HTTPS host with trailing/leading/double dots, When enforceHttpsEndpoint, Then denies https_required', () => {
    for (const requestTarget of [
      'https://publisher.example.test./collections/c-1',
      'https://.publisher.example.test/collections/c-1',
      'https://publisher..example.test/collections/c-1',
    ]) {
      expect(
        enforceHttpsEndpoint({
          remote: true,
          applicability: 'applicable',
          transport: { scheme: 'https' },
          requestTarget,
        }),
      ).toEqual({ allowed: false, reason: 'https_required' });
    }
  });

  it('Given missing remote or applicability own fields, When enforceHttpsEndpoint, Then denies invalid_input', () => {
    expect(
      enforceHttpsEndpoint({
        applicability: 'applicable',
        transport: { scheme: 'https' },
        requestTarget: '/collections/c-1',
      }),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
    expect(
      enforceHttpsEndpoint({
        remote: true,
        transport: { scheme: 'https' },
        requestTarget: '/collections/c-1',
      }),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it('Given non-boolean remote, When enforceHttpsEndpoint, Then denies invalid_input', () => {
    expect(
      enforceHttpsEndpoint({
        remote: 'true',
        applicability: 'applicable',
        transport: { scheme: 'https' },
        requestTarget: '/collections/c-1',
      }),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it('Given remote/applicability mismatch pairs, When enforceHttpsEndpoint, Then denies applicability_mismatch', () => {
    expect(enforceHttpsEndpoint({ remote: true, applicability: 'not_applicable' })).toEqual({
      allowed: false,
      reason: 'applicability_mismatch',
    });
    expect(enforceHttpsEndpoint({ remote: false, applicability: 'applicable' })).toEqual({
      allowed: false,
      reason: 'applicability_mismatch',
    });
  });

  it('Given Origin host labels with leading/trailing hyphens, When enforceOriginGuard, Then denies origin_invalid', () => {
    for (const requestOrigin of [
      'https://-bad.example.test',
      'https://bad-.example.test',
      'https://bad.-example.test',
    ]) {
      const decision = enforceOriginGuard({
        protocol: 'streamable-http',
        remote: true,
        applicability: 'applicable',
        requestOrigin,
        allowedOrigins: [requestOrigin],
      });
      expect(decision).toEqual({ allowed: false, reason: 'origin_invalid' });
      expect(JSON.stringify(decision)).not.toContain(requestOrigin);
    }
  });

  it('Given invalid Origin port spellings, When enforceOriginGuard, Then denies origin_invalid', () => {
    for (const requestOrigin of [
      'https://publisher.example.test:0',
      'https://publisher.example.test:65536',
      'https://publisher.example.test:08',
    ]) {
      expect(
        enforceOriginGuard({
          protocol: 'streamable-http',
          remote: true,
          applicability: 'applicable',
          requestOrigin,
          allowedOrigins: ['https://publisher.example.test'],
        }),
      ).toEqual({ allowed: false, reason: 'origin_invalid' });
    }
  });

  it('Given missing Origin guard discriminators, When enforceOriginGuard, Then denies invalid_input', () => {
    expect(
      enforceOriginGuard({
        remote: true,
        applicability: 'applicable',
        requestOrigin: 'https://publisher.example.test',
        allowedOrigins: ['https://publisher.example.test'],
      }),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
    expect(
      enforceOriginGuard({
        protocol: 'streamable-http',
        remote: 'yes',
        applicability: 'applicable',
        requestOrigin: 'https://publisher.example.test',
        allowedOrigins: ['https://publisher.example.test'],
      }),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it('Given remote streamable-http with not_applicable, When enforceOriginGuard, Then denies applicability_mismatch', () => {
    expect(
      enforceOriginGuard({
        protocol: 'streamable-http',
        remote: true,
        applicability: 'not_applicable',
      }),
    ).toEqual({ allowed: false, reason: 'applicability_mismatch' });
  });

  it('Given invalid tlsTerminated / transportScheme / protocol / empty requestTarget, When boundary, Then invalid_evidence or invalid_input', () => {
    expect(
      enforcePublisherStreamableHttpBoundary(
        { ...trustedEvidence(), tlsTerminated: 'yes' } as never,
        { allowedOrigins: ['https://publisher.example.test'] },
      ),
    ).toEqual({ allowed: false, reason: 'invalid_evidence' });
    expect(
      enforceHttpsFromTransport({ ...trustedEvidence(), transportScheme: 'ftp' } as never),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
    expect(
      enforcePublisherStreamableHttpBoundary(
        { ...trustedEvidence(), protocol: 'http' } as never,
        { allowedOrigins: ['https://publisher.example.test'] },
      ),
    ).toEqual({ allowed: false, reason: 'invalid_evidence' });
    expect(
      enforcePublisherStreamableHttpBoundary(
        { ...trustedEvidence(), requestTarget: '' },
        { allowedOrigins: ['https://publisher.example.test'] },
      ),
    ).toEqual({ allowed: false, reason: 'invalid_evidence' });
  });

  it('Given origin array with non-string entries, When boundary, Then invalid_evidence; non-string allowlist → invalid_input', () => {
    expect(
      enforcePublisherStreamableHttpBoundary(
        trustedEvidence({
          protocol: 'streamable-http',
          origin: [1, 2] as unknown as string[],
        }),
        { allowedOrigins: ['https://publisher.example.test'] },
      ),
    ).toEqual({ allowed: false, reason: 'invalid_evidence' });
    expect(
      enforceOriginFromTransport(
        trustedEvidence({
          protocol: 'streamable-http',
          origin: 'https://publisher.example.test',
        }),
        [42 as unknown as string],
      ),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
  });
});

describe('U-1 gaps: credential-restrictions input trust (SEC-0007)', () => {
  const now = Date.parse('2026-07-18T04:00:00.000Z');

  function ports(): CredentialRestrictionPorts {
    return {
      nodeSubtree: { isAllowed: vi.fn(async () => true) },
      operationBudget: { checkAndConsume: vi.fn(async () => true) },
      clock: { now: vi.fn(() => now) },
    };
  }

  it('Given non-boolean allowPublicExposure, When enforcing, Then invalid_input and budget port is not called', async () => {
    const budget = { checkAndConsume: vi.fn(async () => true) };
    const decision = await enforceCredentialRestrictions(
      { ...ports(), operationBudget: budget },
      {
        credentialId: 'key-42',
        restrictions: [{ allowPublicExposure: 'yes' as unknown as boolean }],
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'invalid_input' });
    expect(budget.checkAndConsume).not.toHaveBeenCalled();
  });

  it('Given non-boolean publicExposure, When enforcing, Then invalid_input and budget port is not called', async () => {
    const budget = { checkAndConsume: vi.fn(async () => true) };
    const decision = await enforceCredentialRestrictions(
      { ...ports(), operationBudget: budget },
      {
        credentialId: 'key-42',
        restrictions: [],
        publicExposure: 'true' as unknown as boolean,
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'invalid_input' });
    expect(budget.checkAndConsume).not.toHaveBeenCalled();
  });

  it('Given restrictions that are not an array, When enforcing, Then invalid_input', async () => {
    const budget = { checkAndConsume: vi.fn(async () => true) };
    const decision = await enforceCredentialRestrictions(
      { ...ports(), operationBudget: budget },
      {
        credentialId: 'key-42',
        restrictions: { maxOperations: 1 } as never,
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'invalid_input' });
    expect(budget.checkAndConsume).not.toHaveBeenCalled();
  });

  it('Given non-object nodeSubtree port when subtree check is required, When enforcing, Then port_failure without charging', async () => {
    const budget = { checkAndConsume: vi.fn(async () => true) };
    const decision = await enforceCredentialRestrictions(
      {
        nodeSubtree: 'not-a-port' as never,
        operationBudget: budget,
        clock: { now: () => now },
      },
      {
        credentialId: 'key-42',
        restrictions: [{ nodeSubtrees: [{ collectionId: 'c-1', rootNodeId: 'n-1' }] }],
        collectionId: 'c-1',
        nodeId: 'n-2',
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'port_failure' });
    expect(budget.checkAndConsume).not.toHaveBeenCalled();
  });

  it('Given only notBefore or only expiresAt, When within window, Then allows and consumes budget once each', async () => {
    const budget = { checkAndConsume: vi.fn(async () => true) };
    await expect(
      enforceCredentialRestrictions(
        { operationBudget: budget, clock: { now: () => now } },
        {
          credentialId: 'key-42',
          restrictions: [{ notBefore: now - 1_000, maxOperations: 3 }],
          operationCost: 1,
        },
      ),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
    await expect(
      enforceCredentialRestrictions(
        { operationBudget: budget, clock: { now: () => now } },
        {
          credentialId: 'key-42',
          restrictions: [{ expiresAt: now + 1_000, maxOperations: 3 }],
          operationCost: 1,
        },
      ),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
    expect(budget.checkAndConsume).toHaveBeenCalledTimes(2);
    expect(budget.checkAndConsume).toHaveBeenNthCalledWith(1, {
      credentialId: 'key-42',
      cost: 1,
      maxOperations: 3,
    });
  });

  it('Given control characters in credentialId, When enforcing, Then invalid_input without secret echo', async () => {
    const secret = 'key-\u0001-secret';
    const decision = await enforceCredentialRestrictions(ports(), {
      credentialId: secret,
      restrictions: [],
    });
    expect(decision).toEqual({ allowed: false, reason: 'invalid_input' });
    expect(JSON.stringify(decision)).not.toContain('secret');
    expect(String(decision)).not.toContain(secret);
  });
});

describe('U-1 gaps: operation-cost / rate-limit boundaries (SEC-0013/0004/0012)', () => {
  it('Given wrapped {operations} object form, When calculating cost, Then equals array form', () => {
    const operations = [
      { kind: 'read' as const, affectedObjects: 2, writeObjects: 0 },
      { kind: 'write' as const, affectedObjects: 3, writeObjects: 3 },
    ];
    expect(calculateExpandedOperationCost({ operations })).toEqual({
      calculated: true,
      cost: 8,
      affectedObjects: 5,
      writeObjects: 3,
      operationCount: 2,
    });
    expect(calculateExpandedOperationCost(operations)).toEqual(
      calculateExpandedOperationCost({ operations }),
    );
  });

  it('Given write/sync-push that under-debits writeObjects, When calculating, Then calculated:false', () => {
    expect(
      calculateExpandedOperationCost([
        { kind: 'write', affectedObjects: 4, writeObjects: 2 },
      ]),
    ).toEqual({ calculated: false, reason: 'invalid_input' });
    expect(
      calculateExpandedOperationCost([
        { kind: 'sync-push', affectedObjects: 5, writeObjects: 1 },
      ]),
    ).toEqual({ calculated: false, reason: 'invalid_input' });
  });

  it('Given custom-prototype operations array, When calculating, Then calculated:false', () => {
    const customProto = Object.create(Array.prototype) as unknown[];
    const hostile = Object.setPrototypeOf(
      [{ kind: 'read', affectedObjects: 1, writeObjects: 0 }],
      customProto,
    );
    expect(calculateExpandedOperationCost(hostile)).toEqual({
      calculated: false,
      reason: 'invalid_input',
    });
  });

  it('Given invalid publisher identity kind, When admission, Then denies invalid_input without charging', async () => {
    const checkAndConsume = vi.fn(async () => ({
      committed: true,
      ceilings: [],
      grant: { kind: 'none' as const, allowed: true, debitedWrites: 0 },
    }));
    const decision = await enforcePublisherAdmission(
      { checkAndConsume },
      {
        bucket: 'general-write',
        identity: { kind: 'api_key', id: 'id-1' },
        ipAddress: '203.0.113.7',
        instanceId: 'inst-1',
        operations: [{ kind: 'read', affectedObjects: 1, writeObjects: 0 }],
        ceilings: {
          subjectCredential: { limit: 10, windowSeconds: 60 },
          ip: { limit: 10, windowSeconds: 60 },
          instance: { limit: 10, windowSeconds: 60 },
        },
        grant: null,
      } as never,
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'invalid_input' });
    expect(checkAndConsume).not.toHaveBeenCalled();
  });

  it('Given non-string ceiling policy, When enforceRateLimit, Then throws before charging', async () => {
    const charge = vi.fn(async () => ({ committed: true, ceilings: [], retryAfterSeconds: 0 }));
    await expect(
      enforceRateLimit(
        { charge },
        {
          bucket: 'publisher:authenticated-read',
          cost: 1,
          ipAddress: '203.0.113.7',
          instanceId: 'inst-1',
          ceilings: {
            credential: { policy: 12 as unknown as string, limit: 10, windowSeconds: 60 },
            ip: ceiling,
            instance: ceiling,
          },
        },
      ),
    ).rejects.toThrow(/credential policy must be a string/);
    expect(charge).not.toHaveBeenCalled();
  });

  it('Given non-string credentialId, When enforceRateLimit, Then throws before charging', async () => {
    const charge = vi.fn(async () => ({ committed: true, ceilings: [], retryAfterSeconds: 0 }));
    await expect(
      enforceRateLimit(
        { charge },
        {
          bucket: 'publisher:authenticated-read',
          cost: 1,
          credentialId: 42 as unknown as string,
          ipAddress: '203.0.113.7',
          instanceId: 'inst-1',
          ceilings: { credential: ceiling, ip: ceiling, instance: ceiling },
        },
      ),
    ).rejects.toThrow(/credentialId must be a string/);
    expect(charge).not.toHaveBeenCalled();
  });

  it('Given Proxy / non-object operation classify input, When classifyRateLimitBucket, Then classified:false', () => {
    expect(classifyRateLimitBucket(null)).toEqual({ classified: false, reason: 'invalid_input' });
    expect(
      classifyRateLimitBucket(
        new Proxy({ authentication: 'anonymous', operation: 'feed-read' }, {}),
      ),
    ).toEqual({ classified: false, reason: 'invalid_input' });
  });

  it('Given forged extra own key on operation enforce input, When enforceRateLimitForOperation, Then invalid_classification and no charge', async () => {
    const charge = vi.fn(async () => ({ committed: true, ceilings: [], retryAfterSeconds: 0 }));
    const decision = await enforceRateLimitForOperation(
      { charge },
      {
        authentication: 'authenticated',
        operation: 'read',
        cost: 1,
        ipAddress: '203.0.113.7',
        instanceId: 'inst-1',
        ceilings: { credential: ceiling, ip: ceiling, instance: ceiling },
        bucket: 'forged',
      } as never,
    );
    expect(decision).toEqual({ allowed: false, reason: 'invalid_classification' });
    expect(charge).not.toHaveBeenCalled();
  });
});

describe('U-1 gaps: api-key / oauth / sender / integrity / snapshot (SEC-0008/0009/0010/0017/0018)', () => {
  it('Given asterisk-form request target, When enforceApiKeyTransport, Then allows without authorization', () => {
    expect(enforceApiKeyTransport({ requestTarget: '*' })).toEqual({
      allowed: true,
      reason: 'allowed',
      authorizationPresent: false,
    });
  });

  it('Given credentialQueryParameterNames that are not strings, When enforceApiKeyTransport, Then denies invalid_input without echoing secret names', () => {
    const decision = enforceApiKeyTransport({
      requestTarget: '/collections',
      credentialQueryParameterNames: [42 as unknown as string],
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'invalid_input' });
    expect(JSON.stringify(decision)).not.toContain('42');
  });

  it('Given Proxy authorization array, When enforceApiKeyTransport, Then denies invalid_input without trap execution', () => {
    const getTrap = vi.fn(() => 'Bearer colp_live_Aa9._~-safe');
    const decision = enforceApiKeyTransport({
      requestTarget: '/collections',
      authorization: new Proxy(['Bearer colp_live_Aa9._~-safe'], { get: getTrap }),
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'invalid_input' });
    expect(getTrap).not.toHaveBeenCalled();
    expect(JSON.stringify(decision)).not.toContain('colp_live');
  });

  it('Given absolute HTTPS OAuth transport requestTarget with userinfo, When profile applicable, Then denies invalid_input without echoing secret', async () => {
    const secret = 'https://user:oauth-secret@publisher.example.test/mcp';
    const resource = 'https://publisher.example.test/mcp';
    const authorizationServer = 'https://authorization.example.test';
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const upstreamToken = 'upstream-access-token-secret-Aa9';
    const input: OAuth21ProfileInput = {
      integration: 'remote-mcp',
      applicability: 'applicable',
      protectedResourceMetadata: {
        resource,
        authorizationServers: [authorizationServer],
      },
      authorizationServerDiscovery: {
        authorizationServer,
        method: 'authorization-server-metadata',
        discoveryUrl: `${authorizationServer}/.well-known/oauth-authorization-server`,
        issuer: authorizationServer,
        authorizationEndpoint: `${authorizationServer}/authorize`,
        tokenEndpoint: `${authorizationServer}/token`,
      },
      authorizationRequest: { resource },
      tokenRequest: { resource },
      accessToken: {
        audience: resource,
        issuedAt: 1_000_000,
        expiresAt: 1_000_000 + OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS,
      },
      transport: {
        requestTarget: secret,
        authorization: `Bearer ${upstreamToken}`,
      },
      client: {
        type: 'public',
        pkce: { challengeMethod: 'S256', challenge, verifier },
      },
      refreshToken: {
        issued: true,
        rotation: 'rotate-on-use',
        previousToken: 'previous-refresh-token-secret-Cc7',
        currentToken: 'current-refresh-token-secret-Dd6',
      },
      tokenFlow: {
        upstream: { value: upstreamToken, source: 'authorization-header' },
        outbound: { value: 'outbound-access-token-secret-Bb8', source: 'server-issued' },
      },
    };
    const decision = await enforceOAuth21Profile(
      { authorizationServerProvenance: { isAuthorized: vi.fn(async () => true) } },
      input,
    );
    expect(decision).toMatchObject({ allowed: false, disposition: 'denied', reason: 'invalid_input' });
    expect(JSON.stringify(decision)).not.toContain('oauth-secret');
    expect(String(decision)).not.toContain('oauth-secret');
  });

  it('Given unknown sender-constraint mode/operation, When enforceSenderConstraint, Then denies invalid_input without port calls', async () => {
    const verify = vi.fn(async () => ({ valid: false as const }));
    const decision = await enforceSenderConstraint(
      {
        dpopProof: { verify },
        clock: { now: () => 1_800_000_000 },
        dpopReplay: { consume: vi.fn(async () => true) },
      },
      {
        operation: 'unknown-op',
        location: 'remote',
        applicability: 'applicable',
        mode: 'dpop',
        accessToken: { value: 'token', cnf: { jkt: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
        dpop: {
          proof: 'proof',
          method: 'POST',
          targetUri: 'https://publisher.example.test/admin',
        },
      } as never,
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'invalid_input' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('Given DPoP mode with x5t#S256 confirmation, When enforceSenderConstraint, Then denies mode_conflict without verify', async () => {
    const thumb = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const verify = vi.fn(async () => ({ valid: false as const }));
    const decision = await enforceSenderConstraint(
      {
        dpopProof: { verify },
        clock: { now: () => 1_800_000_000 },
        dpopReplay: { consume: vi.fn(async () => true) },
      },
      {
        operation: 'key',
        location: 'remote',
        applicability: 'applicable',
        mode: 'dpop',
        accessToken: { value: 'access-token-secret', cnf: { 'x5t#S256': thumb } },
        dpop: {
          proof: 'proof-secret',
          method: 'POST',
          targetUri: 'https://publisher.example.test/admin/keys',
        },
      } as never,
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'mode_conflict' });
    expect(verify).not.toHaveBeenCalled();
    expect(JSON.stringify(decision)).not.toContain('access-token-secret');
    expect(JSON.stringify(decision)).not.toContain('proof-secret');
  });

  it('Given relative DPoP target URI, When enforceSenderConstraint, Then denies invalid_input', async () => {
    const thumb = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const verify = vi.fn(async () => ({ valid: false as const }));
    const decision = await enforceSenderConstraint(
      {
        dpopProof: { verify },
        clock: { now: () => 1_800_000_000 },
        dpopReplay: { consume: vi.fn(async () => true) },
      },
      {
        operation: 'key',
        location: 'remote',
        applicability: 'applicable',
        mode: 'dpop',
        accessToken: { value: 'access-token', cnf: { jkt: thumb } },
        dpop: { proof: 'proof', method: 'POST', targetUri: '/admin/keys' },
      } as never,
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'invalid_input' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('Given Proxy Uint8Array body, When emitContentIntegrityHeaders, Then invalid_input', () => {
    const body = new Proxy(new Uint8Array([1, 2, 3]), {});
    expect(
      emitContentIntegrityHeaders({
        resourceType: 'snapshot',
        visibility: 'public',
        method: 'GET',
        targetUri: 'https://publisher.example.test/snapshot',
        contentType: 'application/json',
        body,
        signature: new Uint8Array(64),
        algorithm: 'ed25519',
        keySource: 'jwks',
        keyId: 'current',
        rotation: { activeKeyId: 'current', retainedKeyIds: ['old'] },
      }),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it('Given missing resourceType/visibility discriminators, When emitContentIntegrityHeaders, Then invalid_input before reading secrets', () => {
    const getter = vi.fn(() => 'secret-body');
    const input = Object.defineProperty(
      {
        method: 'GET',
        targetUri: 'https://publisher.example.test/snapshot',
        contentType: 'application/json',
        signature: new Uint8Array(64),
        algorithm: 'ed25519',
        keySource: 'jwks',
        keyId: 'current',
        rotation: { activeKeyId: 'current', retainedKeyIds: ['old'] },
      },
      'body',
      { enumerable: true, get: getter },
    );
    expect(emitContentIntegrityHeaders(input)).toEqual({ allowed: false, reason: 'invalid_input' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('Given mutable resource carrying historical fields, When enforceMutableResourceIntegrity, Then invalid_input without verify', async () => {
    const verify = vi.fn(async () => true);
    const decision = await enforceMutableResourceIntegrity(
      {
        signatureVerification: { verify },
        clock: { now: () => 1_700_000_000 },
      },
      {
        resourceType: 'mutable',
        uri: 'https://publisher.example.test/items/i-1',
        immutable: true,
        claims: {
          '@status': 200,
          created: 1_699_999_970,
          expires: 1_700_000_300,
          etag: '"v1"',
          'protocol-version': '1.0',
        },
        maxStaleSeconds: 300,
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'invalid_input' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('Given input-first argument order with resourceType, When enforceMutableResourceIntegrity, Then still verifies via ports-second', async () => {
    const now = 1_700_000_000;
    const decision = await enforceMutableResourceIntegrity(
      {
        resourceType: 'mutable',
        uri: 'https://publisher.example.test/items/i-1',
        maxStaleSeconds: 300,
        claims: {
          '@status': 200,
          created: now - 30,
          expires: now + 300,
          etag: '"v1"',
          'protocol-version': '1.0',
        },
      },
      {
        signatureVerification: { verify: async () => true },
        clock: { now: () => now },
      },
    );
    expect(decision).toMatchObject({
      allowed: true,
      disposition: 'enforced',
      reason: 'mutable_integrity',
    });
  });

  it('Given a Proxy object, When hasSafeRecordPrototype, Then returns false without trap execution', () => {
    const getTrap = vi.fn(() => true);
    const proxied = new Proxy({}, { get: getTrap });
    expect(hasSafeRecordPrototype(proxied)).toBe(false);
    expect(getTrap).not.toHaveBeenCalled();
  });
});
