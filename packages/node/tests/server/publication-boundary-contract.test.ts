import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createPublicationAuthorizedDirectoryPage,
  createPublicationAuthorizedDirectoryPublicProjectionResponse,
  createPublicationCachePolicy,
  createPublicationCollectionMetadataLinkHeader,
  createPublicationCollectionMetadataResponse,
  createPublicationRepresentationHttpHeaders,
  mergePublicationCollectionMetadataLinkHeaders,
  selectPublicationAuthorizedDirectoryCandidates,
} from '../../src/server/index.js';
import {
  assertPublicationEndpointRequestUrl,
  getPublicationEndpointTemplateContract,
} from '../../src/semantic/index.js';

const evidence = '[evidence:publication.coverage-boundaries]';
const metadataFixturePath = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'collection-metadata.json');

describe(`Publication cache-policy parser boundaries ${evidence}`, () => {
  it.each([
    null,
    [],
    { kind: 'anonymous-public', unsupported: true },
    { kind: 'unknown' },
  ])('rejects malformed policy input %j without emitting headers', (input) => {
    expect(() => createPublicationCachePolicy(input as never)).toThrow(TypeError);
  });

  it.each([
    'public,, max-age=60',
    'bad name=value',
    'max-age=not(a)token',
    'max-age="unterminated',
    'max-age="bad\\',
    'max-age="bad\u0001"',
    'max-age="bad\\\u0001"',
  ])('rejects malformed Cache-Control directive %j', (value) => {
    expect(() => createPublicationCachePolicy({
      kind: 'anonymous-public',
      existingCacheControl: value,
    })).toThrow(TypeError);
  });

  it('accepts quoted Cache-Control values with commas and escaped characters', () => {
    const headers = createPublicationCachePolicy({
      kind: 'anonymous-public',
      existingCacheControl: 'max-age="60,\\\"seconds\\\"", public',
    });
    expect(headers['Cache-Control']).toBe('max-age="60,\\\"seconds\\\"", public');
  });

  it('rejects repeated header fields once their combined value exceeds the limit', () => {
    expect(() => createPublicationCachePolicy({
      kind: 'anonymous-public',
      existingCacheControl: ['a'.repeat(16 * 1024), 'b'],
    })).toThrow(RangeError);
  });
});

describe(`Publication endpoint transport boundary ${evidence}`, () => {
  it.each([
    'https://user:password.example/collections/index.json',
    'ftp://catalog.example/collections/index.json',
    'http://catalog.example/collections/index.json',
  ])('rejects a request URL outside the permitted transport policy: %s', (value) => {
    expect(() => assertPublicationEndpointRequestUrl(new URL(value))).toThrow(TypeError);
  });

  it.each([
    ['duplicate variable', 'https://127.0.0.1/collections/{collectionId,collectionId}/index.json'],
    ['fragment', 'https://127.0.0.1/collections/index.json#fragment'],
    ['non-loopback HTTP', 'http://catalog.example/collections/index.json'],
  ])('rejects unsafe declared endpoint template (%s)', (_label, template) => {
    expect(() => getPublicationEndpointTemplateContract('directory', template)).toThrow();
  });
});

const representationHeadersInput = {
  representation: '{"protocolVersion":"0.1"}',
  revision: 'coverage-v1',
  projectionKey: 'public',
  queryContract: 'none' as const,
  query: {},
  negotiatedMediaType: 'application/json',
  protocolVersion: '0.1',
  lastModified: new Date('2026-07-18T00:00:00.000Z'),
};

describe(`Publication representation header input isolation ${evidence}`, () => {
  it.each([null, [], { ...representationHeadersInput, unsupported: true }])
    ('rejects an invalid outer input %j', (input) => {
      expect(() => createPublicationRepresentationHttpHeaders(input as never)).toThrow(TypeError);
    });

  it('rejects a non-byte representation before attempting an ETag', () => {
    expect(() => createPublicationRepresentationHttpHeaders({
      ...representationHeadersInput,
      representation: { secret: true } as never,
    })).toThrow(TypeError);
  });

  it.each([
    [['X-Trace'] as never],
    [[42, 'value'] as never],
    [['X-Trace', 42] as never],
  ])('rejects malformed header tuple %j', (entry) => {
    expect(() => createPublicationRepresentationHttpHeaders({
      ...representationHeadersInput,
      headers: [entry] as never,
    })).toThrow(TypeError);
  });

  it('rejects a valid Date outside the four-digit IMF-fixdate year range', () => {
    expect(() => createPublicationRepresentationHttpHeaders({
      ...representationHeadersInput,
      lastModified: new Date('+010000-01-01T00:00:00.000Z'),
    })).toThrow(RangeError);
  });
});

function metadata(): Record<string, unknown> {
  return JSON.parse(readFileSync(metadataFixturePath, 'utf8')) as Record<string, unknown>;
}

function directoryCandidate(overrides: Record<PropertyKey, unknown> = {}): Record<string, unknown> {
  return {
    id: 'coverage-boundary',
    canonicalUrl: 'https://catalog.example/collections/coverage-boundary',
    title: 'Coverage boundary',
    kind: 'knowledge_collection',
    nodeCount: 0,
    updatedAt: '2026-07-18T00:00:00.000Z',
    visibility: 'public',
    links: {
      self: 'https://api.example/collections/coverage-boundary',
      canonical: 'https://catalog.example/collections/coverage-boundary',
      snapshot: 'https://cdn.example/snapshots/coverage-boundary.json',
    },
    ...overrides,
  };
}

function authorizedPage() {
  const selected = selectPublicationAuthorizedDirectoryCandidates([directoryCandidate()], () => true);
  return {
    selected,
    page: createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    }),
  };
}

describe(`Publication metadata and authorized-directory boundaries ${evidence}`, () => {
  it('supports direct Link-header generation and adapter header merging', () => {
    const value = metadata();
    const generated = createPublicationCollectionMetadataLinkHeader(value);
    expect(generated).toContain('rel="self"');

    const headers = mergePublicationCollectionMetadataLinkHeaders(value, [
      ['X-Request-Id', 'coverage-boundary'],
    ]);
    expect(headers.get('X-Request-Id')).toBe('coverage-boundary');
    expect(headers.get('Link')).toBe(generated);
  });

  it('accepts a Headers instance and leaves an already complete generated Link set unchanged', () => {
    const value = metadata();
    const generated = createPublicationCollectionMetadataLinkHeader(value);
    const source = new Headers({ Link: generated, 'X-Trace': 'trace-headers-instance' });
    const merged = mergePublicationCollectionMetadataLinkHeaders(value, source);
    expect(merged.get('Link')).toBe(generated);
    expect(merged.get('X-Trace')).toBe('trace-headers-instance');
    expect(merged).not.toBe(source);
  });

  it.each([
    ['an inherited header record', Object.create({ Link: '<https://example.test>; rel="describedby"' })],
    ['too many header fields', Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`X-${index}`, 'v']))],
    ['a malformed tuple', [['X-Only']] as never],
    ['a non-string tuple value', [['X-Trace', 1]] as never],
  ])('rejects %s at the adapter header-copy boundary', (_label, headers) => {
    expect(() => mergePublicationCollectionMetadataLinkHeaders(metadata(), headers as never))
      .toThrow(TypeError);
  });

  it.each([
    ['an extra root member', { ...metadata(), extra: true }],
    ['a missing required self link', (() => {
      const value = metadata();
      delete (value.links as Record<string, unknown>).self;
      return value;
    })()],
    ['a non-object links member', { ...metadata(), links: [] }],
  ])('rejects malformed Collection Metadata shape: %s', (_label, value) => {
    expect(() => createPublicationCollectionMetadataLinkHeader(value)).toThrow(TypeError);
  });

  it.each([
    ['unknown response option', { method: 'GET', debug: true }],
    ['inherited response options', Object.assign(Object.create({ method: 'GET' }), {})],
  ])('rejects %s without consulting inherited adapter state', (_label, init) => {
    expect(() => createPublicationCollectionMetadataResponse(metadata(), init as never))
      .toThrow(TypeError);
  });

  it('returns a bodyless 304 while preserving caller headers', async () => {
    const response = createPublicationCollectionMetadataResponse(metadata(), {
      method: 'GET',
      status: 304,
      headers: { ETag: '"coverage-v1"' },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe('"coverage-v1"');
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('rejects an unsupported visibility before protected authorization can run', () => {
    const candidate = {
      ...directoryCandidate(),
      visibility: 'secret',
      links: metadata().links,
    };
    let calls = 0;
    expect(() => selectPublicationAuthorizedDirectoryCandidates([candidate], () => {
      calls += 1;
      return true;
    })).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it('builds the explicit public-projection response and applies private cache policy', () => {
    const candidate = {
      ...directoryCandidate(),
      visibility: 'public',
      links: metadata().links,
    };
    const selected = selectPublicationAuthorizedDirectoryCandidates([candidate], () => true);
    const page = createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    const response = createPublicationAuthorizedDirectoryPublicProjectionResponse(page, {
      existingVary: 'Origin',
    });
    expect(response.headers).toEqual({
      'Cache-Control': 'private, no-store',
      Vary: 'Origin, Authorization',
    });
    expect(response.body.collections).toHaveLength(1);
    expect(response.body.nextCursor).toBeNull();
  });

  it('rejects cache options with accessors instead of invoking them', () => {
    let reads = 0;
    const cache = Object.defineProperty({}, 'existingVary', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('cache-secret');
      },
    });
    const candidate = {
      ...directoryCandidate(),
      visibility: 'public',
      links: metadata().links,
    };
    const selected = selectPublicationAuthorizedDirectoryCandidates([candidate], () => true);
    const page = createPublicationAuthorizedDirectoryPage(selected, {
      collections: selected.collections,
      nextCursor: null,
    });
    expect(() => createPublicationAuthorizedDirectoryPublicProjectionResponse(page, cache as never))
      .toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it.each([
    null,
    [],
    new Proxy({}, {}),
    { existingVary: 'Origin', unknown: true },
  ])('rejects malformed authorized cache options %j', (cache) => {
    const { page } = authorizedPage();
    expect(() => createPublicationAuthorizedDirectoryPublicProjectionResponse(page, cache as never))
      .toThrow(TypeError);
  });

  it.each([
    null,
    [],
    { collections: [], nextCursor: null, extra: true },
    { collections: [] },
    { nextCursor: null },
    { collections: [], nextCursor: 1 },
    { collections: [], nextCursor: 'x'.repeat(8_193) },
    { collections: {}, nextCursor: null },
  ])('rejects a malformed authorized page shell %j', (page) => {
    const { selected } = authorizedPage();
    expect(() => createPublicationAuthorizedDirectoryPage(selected, page as never)).toThrow(TypeError);
  });

  it('rejects sparse, inherited, and proxied candidate arrays before authorization', () => {
    const sparse = new Array(1);
    class CandidateArray extends Array<unknown> {}
    const inherited = new CandidateArray(directoryCandidate());
    for (const candidates of [sparse, inherited, new Proxy([directoryCandidate()], {})]) {
      expect(() => selectPublicationAuthorizedDirectoryCandidates(candidates, () => true))
        .toThrow(TypeError);
    }
  });

  it.each([
    ['non-finite JSON', { extensions: { value: Number.POSITIVE_INFINITY } }],
    ['unsafe integer JSON', { extensions: { value: Number.MAX_SAFE_INTEGER + 1 } }],
    ['cyclic JSON', (() => {
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      return { extensions: cycle };
    })()],
  ])('rejects a candidate containing %s before it can enter an authorized page', (_label, overrides) => {
    expect(() => selectPublicationAuthorizedDirectoryCandidates(
      [directoryCandidate(overrides)],
      () => true,
    )).toThrow(TypeError);
  });

  it('rejects an oversized string before structuredClone can duplicate it', () => {
    const oversized = directoryCandidate({ title: 'x'.repeat(1_100_000) });
    expect(() => selectPublicationAuthorizedDirectoryCandidates([oversized], () => true))
      .toThrow(TypeError);
  });
});
