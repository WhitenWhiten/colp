/**
 * U-4 Security mutation survivors — priority 1 (allow/deny, scope/principal,
 * transport truth). Each case targets a concrete Survived/NoCoverage mutant
 * with a distinguishing public observation. Do not assert private helpers.
 *
 * Targeted mutant IDs (security/mutation.json): see case titles.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  classifyRateLimitBucket,
  enforceCredentialRestrictions,
  enforcePublisherStreamableHttpBoundary,
  evaluateEffectiveScopes,
  type CredentialRestrictionPorts,
  type TrustedTransportEvidence,
} from '../../src/security/index.js';
import { enforceHttpsEndpoint } from '../../src/security/https-enforcement.js';
import { enforceOriginGuard } from '../../src/security/origin-guard.js';
import type { AccessPolicy, PrincipalRef, ScopeName } from '../../src/types/index.js';

const evidence = '[review:security.mutation-survivors-u4-p1]';

const publisher: PrincipalRef = { type: 'service', id: 'publisher' };
const publicPrincipal: PrincipalRef = { type: 'public', id: 'public' };

function policy(
  scopes: AccessPolicy['entries'][number]['scopes'],
  visibility: AccessPolicy['visibility'] = 'private',
  principal: PrincipalRef = publisher,
): AccessPolicy {
  return {
    visibility,
    entries: [{ principal, effect: 'allow', scopes }],
    publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
    revision: 'acl-u4-1',
  };
}

function openChain(layer: AccessPolicy, ancestors: readonly AccessPolicy[] = []) {
  return {
    serverDefault: layer,
    collection: layer,
    ancestors,
    object: layer,
  };
}

function expectEmpty(set: ReadonlySet<ScopeName>): void {
  expect(set.size).toBe(0);
  expect([...set]).toEqual([]);
}

describe(`U-4 P1 effective-scopes principal/empty-id / dense ancestors ${evidence}`, () => {
  it(`mutants ~864: empty principal id on public visibility fails closed (not anonymous allow) ${evidence}`, () => {
    // Original: id.length > 0 → empty id invalid → evaluatePolicy clears all scopes.
    // Mutant >= 0: empty id parses; public visibility keeps anonymous reads.
    // Identities must include a non-public principal so readIdentities stays valid
    // (public-only identity arrays fail authenticated snapshot and deny-all first).
    const brokenEntry = policy(['nodes:read'], 'public', { type: 'user', id: '' });
    const scopes = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read', 'collections:read', 'feed:read']),
      identities: [{ type: 'user', id: 'alice' }],
      policyChain: openChain(brokenEntry),
    });
    expectEmpty(scopes);
  });

  it(`mutants ~40/812 allowExtraOwnKeys: ancestors array with extra own key still evaluates ${evidence}`, () => {
    const layer = policy(['nodes:read'], 'private', publisher);
    const ancestors = Object.assign([layer], { extraOwn: 'noise' });
    const scopes = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read']),
      identities: [publisher],
      policyChain: openChain(layer, ancestors as unknown as AccessPolicy[]),
    });
    expect([...scopes]).toEqual(['nodes:read']);
  });

  it(`mutant ~814/requireStandardPrototype: custom-prototype ancestors deny-all; Array.prototype ok ${evidence}`, () => {
    const layer = policy(['nodes:read'], 'private', publisher);
    const customProto = Object.create(Array.prototype) as unknown[];
    const hostile = Object.setPrototypeOf([layer], customProto) as AccessPolicy[];
    // effective-scopes uses requireStandardPrototype: true → custom proto → empty
    const scopes = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read']),
      identities: [publisher],
      policyChain: openChain(layer, hostile),
    });
    expectEmpty(scopes);

    // Control: genuine Array stays allow when other layers grant nodes:read.
    const scopesOk = evaluateEffectiveScopes({
      grantedScopes: new Set<ScopeName>(['nodes:read']),
      identities: [publisher],
      policyChain: openChain(layer, [layer]),
    });
    expect([...scopesOk]).toEqual(['nodes:read']);
  });
});

describe(`U-4 P1 https / origin transport truth ${evidence}`, () => {
  it(`mutants ~1130/hasSafeString: empty requestTarget denies invalid_input ${evidence}`, () => {
    expect(
      enforceHttpsEndpoint({
        remote: true,
        applicability: 'applicable',
        transport: { scheme: 'https' },
        requestTarget: '',
      }),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it(`mutants ~1133 MAX length boundary: target at 4096 allowed shape, 4097 denied ${evidence}`, () => {
    const okPath = `/${'a'.repeat(4095)}`;
    expect(okPath.length).toBe(4096);
    expect(
      enforceHttpsEndpoint({
        remote: true,
        applicability: 'applicable',
        transport: { scheme: 'https' },
        requestTarget: okPath,
      }),
    ).toMatchObject({ allowed: true, disposition: 'enforced' });

    const tooLong = `/${'a'.repeat(4096)}`;
    expect(tooLong.length).toBe(4097);
    expect(
      enforceHttpsEndpoint({
        remote: true,
        applicability: 'applicable',
        transport: { scheme: 'https' },
        requestTarget: tooLong,
      }),
    ).toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it(`mutants ~1285 rawPath mismatch: absolute URL with rewritten path spelling denies https_required ${evidence}`, () => {
    // Path that URL would normalize differently from raw spelling.
    expect(
      enforceHttpsEndpoint({
        remote: true,
        applicability: 'applicable',
        transport: { scheme: 'https' },
        requestTarget: 'https://publisher.example.test/./collections/c-1',
      }),
    ).toEqual({ allowed: false, reason: 'https_required' });
  });

  it(`mutant ~1581 IPv6 origin bracket exception: expanded form that URL compresses still allowlisted ${evidence}`, () => {
    // Raw host spelling differs from URL.hostname compression; bracket exception
    // must skip the raw≠canonical deny. Mutating away `!host.startsWith('[')`
    // rejects this Origin while the allowlist uses the same spelling.
    const origin = 'https://[2001:0db8:0000:0000:0000:0000:0000:0001]';
    const decision = enforceOriginGuard({
      protocol: 'streamable-http',
      remote: true,
      applicability: 'applicable',
      requestOrigin: origin,
      allowedOrigins: [origin],
    });
    expect(decision).toEqual({
      allowed: true,
      disposition: 'enforced',
      location: 'remote',
      reason: 'origin_allowed',
    });
  });
});

describe(`U-4 P1 credential restrictions origin/CIDR ${evidence}`, () => {
  function ports(): CredentialRestrictionPorts {
    return {
      nodeSubtree: { isAllowed: vi.fn(async () => true) },
      operationBudget: { checkAndConsume: vi.fn(async () => true) },
      clock: { now: vi.fn(() => Date.parse('2026-07-18T04:00:00.000Z')) },
    };
  }

  it(`mutants ~134/123 protocol: http origin allowlist entry is accepted; ftp denied as invalid_input ${evidence}`, async () => {
    const base = {
      credentialId: 'key-u4',
      collectionId: 'collection-a',
      nodeId: 'bookmark-a',
      ipAddress: '203.0.113.7',
      operationCost: 1,
      publicExposure: false,
    };
    await expect(
      enforceCredentialRestrictions(ports(), {
        ...base,
        origin: 'http://console.example.test',
        restrictions: [
          {
            collectionAllowlist: ['collection-a'],
            originAllowlist: ['http://console.example.test'],
            allowPublicExposure: false,
          },
        ],
      }),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });

    await expect(
      enforceCredentialRestrictions(ports(), {
        ...base,
        origin: 'https://console.example.test',
        restrictions: [
          {
            collectionAllowlist: ['collection-a'],
            originAllowlist: ['ftp://console.example.test'],
            allowPublicExposure: false,
          },
        ],
      }),
    ).resolves.toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it(`mutants ~206/209 prefixLength 0 and max-32 allowed; 33 invalid_input ${evidence}`, async () => {
    const base = {
      credentialId: 'key-u4',
      collectionId: 'collection-a',
      nodeId: 'bookmark-a',
      ipAddress: '198.51.100.9',
      origin: 'https://console.example.test',
      operationCost: 1,
      publicExposure: false,
    };
    // Original: prefixLength < 0 rejects negatives; mutant <= 0 would reject 0.
    await expect(
      enforceCredentialRestrictions(ports(), {
        ...base,
        restrictions: [
          {
            collectionAllowlist: ['collection-a'],
            ipAllowlist: [{ address: '0.0.0.0', prefixLength: 0 }],
            allowPublicExposure: false,
          },
        ],
      }),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
    // Original: prefixLength > 32 rejects; mutant >= 32 would reject exact 32.
    await expect(
      enforceCredentialRestrictions(ports(), {
        ...base,
        ipAddress: '198.51.100.9',
        restrictions: [
          {
            collectionAllowlist: ['collection-a'],
            ipAllowlist: [{ address: '198.51.100.9', prefixLength: 32 }],
            allowPublicExposure: false,
          },
        ],
      }),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
    await expect(
      enforceCredentialRestrictions(ports(), {
        ...base,
        restrictions: [
          {
            collectionAllowlist: ['collection-a'],
            ipAllowlist: [{ address: '198.51.100.0', prefixLength: 33 }],
            allowPublicExposure: false,
          },
        ],
      }),
    ).resolves.toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it(`mutants ~40/41 dense allowlist: extra own keys and custom prototype arrays still allow ${evidence}`, async () => {
    const origins = Object.assign(['https://console.example.test'], { tag: 'extra' });
    await expect(
      enforceCredentialRestrictions(ports(), {
        credentialId: 'key-u4',
        collectionId: 'collection-a',
        nodeId: 'bookmark-a',
        ipAddress: '203.0.113.7',
        origin: 'https://console.example.test',
        operationCost: 1,
        publicExposure: false,
        restrictions: [
          {
            collectionAllowlist: ['collection-a'],
            originAllowlist: origins as unknown as string[],
            allowPublicExposure: false,
          },
        ],
      }),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });

    const customProto = Object.create(Array.prototype) as string[];
    const customOrigins = Object.setPrototypeOf(['https://console.example.test'], customProto) as string[];
    await expect(
      enforceCredentialRestrictions(ports(), {
        credentialId: 'key-u4',
        collectionId: 'collection-a',
        nodeId: 'bookmark-a',
        ipAddress: '203.0.113.7',
        origin: 'https://console.example.test',
        operationCost: 1,
        publicExposure: false,
        restrictions: [
          {
            collectionAllowlist: ['collection-a'],
            originAllowlist: customOrigins,
            allowPublicExposure: false,
          },
        ],
      }),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
  });
});

describe(`U-4 P1 request-boundary evidence completeness ${evidence}`, () => {
  function evidenceBase(overrides: Partial<TrustedTransportEvidence> = {}): TrustedTransportEvidence {
    return {
      networkExposure: 'public',
      tlsTerminated: true,
      transportScheme: 'https',
      protocol: 'streamable-http',
      requestTarget: 'https://publisher.example.test/collections/c-1',
      origin: 'https://client.example.test',
      ...overrides,
    };
  }

  it(`mutants ~2398/2404: missing required evidence field → invalid_evidence ${evidence}`, () => {
    // Public observation collapses all snapshotTrustedEvidence TypeErrors to
    // invalid_evidence, so ||→&& incomplete-check mutants are equivalent at this
    // API (see ledger equivalence note). Still lock the fail-closed reason.
    const incomplete = {
      networkExposure: 'public',
      tlsTerminated: true,
      transportScheme: 'https',
      protocol: 'other',
      // requestTarget omitted on purpose
    };
    expect(
      enforcePublisherStreamableHttpBoundary(incomplete as TrustedTransportEvidence, {
        allowedOrigins: ['https://client.example.test'],
      }),
    ).toEqual({ allowed: false, reason: 'invalid_evidence' });
  });

  it(`mutant ~2462: origin may be omitted for non-streamable protocol without invalid_evidence ${evidence}`, () => {
    const decision = enforcePublisherStreamableHttpBoundary(
      {
        networkExposure: 'loopback',
        tlsTerminated: true,
        transportScheme: 'https',
        protocol: 'other',
        requestTarget: 'https://publisher.example.test/collections/c-1',
      },
      { allowedOrigins: ['https://client.example.test'] },
    );
    expect(decision.allowed).toBe(true);
    expect(decision).toMatchObject({ remote: false });
  });
});

describe(`U-4 P2 rate-limit classified boolean literals ${evidence}`, () => {
  it(`mutants ~1711/1715/1720: invalid / anonymous feed-read / sync-pull keep exact classified flags ${evidence}`, () => {
    // These hit module-level frozen decision constants (often Stryker static).
    // Assert full public shapes so classified BooleanLiteral flips cannot hide.
    const invalid = classifyRateLimitBucket({ authentication: 'anonymous', operation: 'write' });
    expect(invalid).toEqual({ classified: false, reason: 'invalid_input' });
    expect(invalid.classified).toBe(false);

    const anonymousFeed = classifyRateLimitBucket({
      authentication: 'anonymous',
      operation: 'feed-read',
    });
    expect(anonymousFeed).toEqual({
      classified: true,
      bucketId: 'publisher:anonymous-feed-read',
      category: 'anonymous-feed-read',
      operationSubtype: 'feed-read',
    });
    expect(anonymousFeed.classified).toBe(true);

    const syncPull = classifyRateLimitBucket({
      authentication: 'authenticated',
      operation: 'sync-pull',
    });
    expect(syncPull).toEqual({
      classified: true,
      bucketId: 'publisher:sync-pull',
      category: 'sync-pull',
      operationSubtype: 'sync-pull',
    });
    expect(syncPull.classified).toBe(true);

    const authenticatedFeed = classifyRateLimitBucket({
      authentication: 'authenticated',
      operation: 'feed-read',
    });
    expect(authenticatedFeed).toEqual({
      classified: true,
      bucketId: 'publisher:authenticated-read',
      category: 'authenticated-read',
      operationSubtype: 'feed-read',
    });
    expect(authenticatedFeed.classified).toBe(true);
  });
});
