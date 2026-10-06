import { describe, expect, it } from 'vitest';

import {
  createPublicationAuthorizedDirectoryPage,
  createPublicationAuthorizedDirectoryResponse,
  createPublicationCachePolicy,
  createPublicationCollectionMetadataResponse,
  createPublicationSnapshotPageResponse,
  selectPublicationAuthorizedDirectoryCandidates,
  type PublicationCachePolicyHeaders,
  type PublicationCachePolicyInput,
  type PublicationAuthorizedDirectoryCacheInput,
} from '../../src/server/index.js';

const evidence = 'http.cache.authorization';

function policy(
  kind: PublicationCachePolicyInput['kind'],
  overrides: Record<string, unknown> = {},
): PublicationCachePolicyHeaders {
  return createPublicationCachePolicy({ kind, ...overrides } as PublicationCachePolicyInput);
}

function tokens(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(',').map((token) => token.trim());
}

/**
 * Real production path that selects authorization-varying cache headers.
 * Directory responses do not bind an HTTP status; adapters attach status later.
 */
function authorizedDirectoryCacheHeaders(
  cache: PublicationAuthorizedDirectoryCacheInput = {},
): PublicationCachePolicyHeaders {
  const selected = selectPublicationAuthorizedDirectoryCandidates(
    [
      {
        id: 'cache-policy-public',
        canonicalUrl: 'https://catalog.example/collections/cache-policy-public',
        title: 'Collection cache-policy-public',
        kind: 'knowledge_collection',
        nodeCount: 1,
        updatedAt: '2026-07-18T00:00:00.000Z',
        visibility: 'public',
        links: {
          self: 'https://api.example/collections/cache-policy-public',
          canonical: 'https://catalog.example/collections/cache-policy-public',
          snapshot: 'https://cdn.example/snapshots/cache-policy-public.json',
        },
      },
    ],
    () => true,
  );
  const page = createPublicationAuthorizedDirectoryPage(selected, {
    collections: selected.collections,
    nextCursor: null,
  });
  return createPublicationAuthorizedDirectoryResponse(page, cache).headers;
}

describe(`PUB-0023 authorization-sensitive HTTP caching [evidence:${evidence}]`, () => {
  it(`uses private no-store and varies by Authorization for the normal auth-varying response [evidence:${evidence}]`, () => {
    expect(policy('authorization-varying')).toEqual({
      'Cache-Control': 'private, no-store',
      Vary: 'Authorization',
    });
  });

  it.each([
    ['public', 'public'],
    ['freshness', 'public, max-age=60'],
    ['shared freshness', 's-maxage=300'],
    ['immutable', 'public, immutable, max-age=31536000'],
  ] as const)(`replaces unsafe existing Cache-Control (%s) on an authorized response [evidence:${evidence}]`, (_name, existingCacheControl) => {
    const headers = policy('authorization-varying', { existingCacheControl });
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(headers['Cache-Control']).not.toMatch(/public|max-age|s-maxage|immutable/iu);
  });

  it.each([
    ['Origin and Accept', 'Origin, Accept', ['Origin', 'Accept', 'Authorization']],
    ['repeated fields', ['Origin, Accept', 'origin, X-Tenant'], ['Origin', 'Accept', 'X-Tenant', 'Authorization']],
    ['existing Authorization', 'authorization', ['authorization']],
  ] as const)(`merges the boundary Vary fields for %s without overwriting or duplicating Authorization [evidence:${evidence}]`, (_name, existingVary, expected) => {
    const headers = policy('authorization-varying', { existingVary });
    expect(tokens(headers.Vary)).toEqual(expected);
    expect(tokens(headers.Vary).filter((token) => token.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it(`keeps anonymous public representations eligible for a shared cache while auth-varying stays private [evidence:${evidence}]`, () => {
    const anonymous = policy('anonymous-public', {
      existingCacheControl: 'public, max-age=60',
      existingVary: 'Origin',
    });
    expect(anonymous).toEqual({ 'Cache-Control': 'public, max-age=60', Vary: 'Origin' });

    const authorized = policy('authorization-varying', {
      existingCacheControl: 'public, max-age=60',
      existingVary: 'Origin',
    });
    expect(authorized).toEqual({ 'Cache-Control': 'private, no-store', Vary: 'Origin, Authorization' });
  });

  it.each([
    ['invalid Vary token', { existingVary: 'Origin,,Accept' }],
    ['wildcard combined with a field', { existingVary: '*, Origin' }],
    ['conflicting cache visibility', { existingCacheControl: 'public, private' }],
    ['duplicate cache directive', { existingCacheControl: 'max-age=60, MAX-AGE=120' }],
  ])(`fails closed for %s instead of emitting a cacheable authorization response [evidence:${evidence}]`, (_name, input) => {
    expect(() => policy('authorization-varying', input)).toThrow();
  });

  /**
   * Policy is deliberately status-decoupled: createPublicationCachePolicy has no
   * status input, rejects unknown fields (including status), and always emits
   * the same private authorization-varying headers. Adapters choose status and
   * must preserve these headers on every representation they emit.
   *
   * The previous status matrix only attached policy() output to `new Response`
   * and re-read it — a false positive that never exercised production builders.
   */
  it(`treats authorization-varying cache policy as independent of HTTP status [evidence:${evidence}]`, () => {
    expect(() =>
      createPublicationCachePolicy({
        kind: 'authorization-varying',
        status: 403,
      } as never),
    ).toThrow(TypeError);

    const headers = policy('authorization-varying', {
      existingCacheControl: 'public, max-age=60',
      existingVary: 'Origin',
    });
    expect(Object.keys(headers).sort()).toEqual(['Cache-Control', 'Vary']);
    expect(headers).toEqual({
      'Cache-Control': 'private, no-store',
      Vary: 'Origin, Authorization',
    });
    expect(headers).not.toHaveProperty('status');
  });

  it(`applies private no-store Authorization policy through the authorized Directory response builder [evidence:${evidence}]`, () => {
    const headers = authorizedDirectoryCacheHeaders({
      existingCacheControl: 'public, max-age=3600, immutable',
      existingVary: 'Origin, Accept',
    });

    expect(Object.isFrozen(headers)).toBe(true);
    expect(Object.keys(headers).sort()).toEqual(['Cache-Control', 'Vary']);
    expect(headers).toEqual({
      'Cache-Control': 'private, no-store',
      Vary: 'Origin, Accept, Authorization',
    });
    expect(headers['Cache-Control']).not.toMatch(/public|max-age|s-maxage|immutable/iu);
    expect(tokens(headers.Vary).filter((token) => token.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it.each([
    ['authorization denial', 403, 'snapshot'],
    ['concealed response', 404, 'metadata'],
  ] as const)(
    `preserves authorization-varying cache headers on a %s response via a real outbound builder [evidence:${evidence}]`,
    (_name, status, builder) => {
      const headers = authorizedDirectoryCacheHeaders({
        existingCacheControl: 'public, max-age=60',
        existingVary: 'Origin, Accept',
      });

      const response = builder === 'snapshot'
        ? createPublicationSnapshotPageResponse(
          { type: 'about:blank', status },
          { method: 'GET', status, headers },
        )
        : createPublicationCollectionMetadataResponse(
          { type: 'about:blank', status },
          { method: 'GET', status, headers },
        );

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(tokens(response.headers.get('Vary') ?? undefined)).toEqual([
        'Origin',
        'Accept',
        'Authorization',
      ]);
      expect(response.headers.get('Cache-Control')).not.toMatch(/public|max-age|s-maxage|immutable/iu);
      // Error outbound builders must not invent shared-cache eligibility.
      expect(response.headers.get('Cache-Control')?.toLowerCase()).not.toContain('public');
    },
  );
});
