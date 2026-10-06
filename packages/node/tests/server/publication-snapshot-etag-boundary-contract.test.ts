import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createPublicationSnapshotNextLinkHeader,
  createPublicationSnapshotPageResponse,
  mergePublicationSnapshotNextLinkHeaders,
  createPublicationSnapshotPageSeries,
  createPublicationCollectionMetadataLinkHeader,
  mergePublicationCollectionMetadataLinkHeaders,
  createPublicationRepresentationEtag,
  mapNodeWriteDenialToProblem,
  createPublicationDeletedCollectionTombstone,
  createPublicationDeletedCollectionRecoveryTarget,
  createPublicationDeletedCollectionGoneResponseWithRecoveryTarget,
  snapshotPublicationStaticManifestProfiles,
  snapshotPublicationStaticEndpoints,
  selectAnonymousDirectoryCandidates,
  buildPublicationDiscoveryOutput,
  createPublicationDiscoveryPage,
  mergePublicationAntiDiscoveryHeaders,
  projectPublicationPublicWire,
  PublicationPublicProjectionError,
  releasePublicationSnapshotPage,
  resolvePublicationPublicProjectionOptions,
  selectPublicationDiscoveryCandidates,
} from '../../src/server/index.js';
import type { Snapshot } from '../../src/types/index.js';

const snapshotFixture = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'collection-snapshot.json');
const metadataFixture = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'collection-metadata.json');
const manifestFixture = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'public-manifest.json');
const evidence = '[evidence:publication.coverage-third-boundaries]';

function snapshot(hasMore = true): Snapshot {
  const value = JSON.parse(readFileSync(snapshotFixture, 'utf8')) as Snapshot;
  value.nodes = value.nodes.slice(0, 1);
  value.annotations = [];
  value.attachments = [];
  value.relations = [];
  value.tombstones = [];
  value.page = { sequence: 1, hasMore, nextCursor: hasMore ? 'cursor-next' : null };
  return value;
}

function scope(query: Record<string, unknown> = { limit: 10 }): { principal: string; query: Record<string, unknown> } {
  return { principal: 'principal:coverage', query };
}

describe(`Snapshot page-series input isolation ${evidence}`, () => {
  it('retains a canonical logical query while ignoring continuation cursor values', () => {
    const started = createPublicationSnapshotPageSeries(snapshot(), scope({ include: ['relations', 'annotations'], limit: 10 }));
    const continuation = snapshot();
    continuation.page.sequence = 2;
    const released = releasePublicationSnapshotPage(started.series, continuation, scope({
      include: ['annotations', 'relations'],
      limit: 10,
      pageCursor: 'opaque-cdn-cursor',
    }));
    expect(released.page.hasMore).toBe(true);
    expect(released.page.nextCursor).toBe('cursor-next');
  });

  it.each([
    ['unsupported query key', scope({ limit: 10, unknown: true })],
    ['negative depth', scope({ depth: -1 })],
    ['invalid include member', scope({ include: ['unknown'] })],
    ['oversized principal', { principal: 'p'.repeat(4_097), query: { limit: 10 } }],
    ['oversized root', scope({ root: 'r'.repeat(16_385) })],
  ] as const)('rejects %s without issuing a page-series capability', (_label, invalidScope) => {
    expect(() => createPublicationSnapshotPageSeries(snapshot(), invalidScope as never)).toThrow();
  });

  it('requires a continuation cursor only when releasing a later page', () => {
    const started = createPublicationSnapshotPageSeries(snapshot(), scope({ limit: 10 }));
    expect(() => releasePublicationSnapshotPage(started.series, snapshot(), scope({ limit: 10 })))
      .toThrow(TypeError);
  });

  it('rejects an unissued series and a proxied series without reflecting input', () => {
    expect(() => releasePublicationSnapshotPage({} as never, snapshot(), scope({ pageCursor: 'x' }))).toThrow(TypeError);
    expect(() => releasePublicationSnapshotPage(new Proxy({}, {}) as never, snapshot(), scope({ pageCursor: 'x' }))).toThrow(TypeError);
  });
});

describe(`Representation ETag canonicalization chain ${evidence}`, () => {
  const base = {
    representation: new TextEncoder().encode('{"items":[1]}'),
    revision: 'revision-1',
    projectionKey: 'public',
    queryContract: 'snapshotQuery' as const,
    query: { include: ['relations', 'annotations'], limit: 10 },
    negotiatedMediaType: 'application/json;profile="https://example.test/a,b;c"',
    protocolVersion: '0.1',
    snapshotIdentity: { snapshotId: 'snapshot-1', sequence: 2 },
    pageIdentity: { pageNumber: 1, key: 'first-page' },
    principalScope: 'principal:coverage',
  };

  it('canonicalizes include order while binding media, page, snapshot, and principal identity', () => {
    const first = createPublicationRepresentationEtag(base);
    const reordered = createPublicationRepresentationEtag({
      ...base,
      query: { limit: 10, include: ['annotations', 'relations'] },
    });
    const otherPrincipal = createPublicationRepresentationEtag({ ...base, principalScope: 'principal:other' });
    expect(first).toMatch(/^"pub\.r1\.[A-Za-z0-9_-]+"$/u);
    expect(reordered).toBe(first);
    expect(otherPrincipal).not.toBe(first);
  });

  it.each([
    ['unterminated media parameter', { negotiatedMediaType: 'application/json;profile="unterminated' }],
    ['escaped media control', { negotiatedMediaType: 'application/json;profile="bad\\\u0001"' }],
    ['non-empty none query', { queryContract: 'none' as const, query: { limit: 1 } }],
    ['malformed include query', { query: { include: 42, limit: 10 } }],
    ['null representation', { representation: 'contains\u0000' }],
    ['lone surrogate representation', { representation: '\ud800' }],
  ])('rejects %s before producing an entity tag', (_label, change) => {
    expect(() => createPublicationRepresentationEtag({ ...base, ...change } as never)).toThrow();
  });

  it('rejects malformed quoted media escapes and oversized canonical query data', () => {
    expect(() => createPublicationRepresentationEtag({
      ...base,
      negotiatedMediaType: 'application/json;profile="bad\\',
    })).toThrow(TypeError);
    expect(() => createPublicationRepresentationEtag({
      ...base,
      query: { limit: 10, root: 'r'.repeat(1_100_000) },
    })).toThrow();
  });
});

describe(`Static Publication loopback transport ${evidence}`, () => {
  it('accepts exact static Publication paths over loopback HTTP for local deployments', () => {
    const manifest = JSON.parse(readFileSync(manifestFixture, 'utf8')) as Record<string, any>;
    const mount = manifest.mounts[0] as Record<string, any>;
    mount.profiles = ['core', 'publication'];
    delete mount.endpoints.instanceFeed;
    delete mount.endpoints.collectionFeed;
    delete mount.features.feed;
    mount.endpoints.directory = 'http://127.0.0.1:8080/collections/index.json';
    mount.endpoints.collection = 'http://127.0.0.1:8080/collections/items/{collectionId}/index.json';
    mount.endpoints.snapshot = 'http://127.0.0.1:8080/collections/items/{collectionId}/snapshot.json';

    const result = snapshotPublicationStaticEndpoints(mount);
    expect(result.declarations.map((entry) => entry.template)).toEqual([
      mount.endpoints.directory,
      mount.endpoints.collection,
      mount.endpoints.snapshot,
    ]);
  });
});

describe(`Snapshot continuation response boundary ${evidence}`, () => {
  it('returns a bodyless 304 and removes stale continuation links', async () => {
    const response = createPublicationSnapshotPageResponse(snapshot(false), {
      method: 'GET',
      status: 304,
      headers: {
        Link: '<https://schema.example>; rel="describedby"',
        ETag: '"coverage-v1"',
      },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe('"coverage-v1"');
    expect(response.headers.get('Link')).toBe('<https://schema.example>; rel="describedby"');
    expect(await response.text()).toBe('');
  });

  it.each([
    'https://pages.example/next/%zz?pageCursor=cursor-next',
    'https://pages.example/next?pageCursor=cursor-next\u0000',
    'https://user:pass@pages.example/next?pageCursor=cursor-next',
    'https://pages.example/next?pageCursor=wrong',
  ])('rejects unsafe or mismatched server next URL %j', (nextUrl) => {
    expect(() => createPublicationSnapshotNextLinkHeader(snapshot(), nextUrl)).toThrow(TypeError);
  });

  it.each(['\ud800', '\udc00', ''])('rejects malformed UTF-16 next URL %j', (nextUrl) => {
    expect(() => createPublicationSnapshotNextLinkHeader(snapshot(), nextUrl)).toThrow(TypeError);
  });

  it.each([
    Object.create({ Link: '<https://evil.example>; rel="next"' }),
    [['Link'] as never],
    [['Link', 42] as never],
  ])('rejects inherited or malformed next-link header sources', (headers) => {
    expect(() => mergePublicationSnapshotNextLinkHeaders(snapshot(), 'https://pages.example/next?pageCursor=cursor-next', headers as never))
      .toThrow(TypeError);
  });
});

describe(`Public projection policy and limits ${evidence}`, () => {
  it('fails closed for omitted namespaces and preserves an explicitly allowlisted namespace', () => {
    const input = {
      extensions: {
        'https://safe.example/ext': { visible: true },
        'https://private.example/ext': { secret: true },
      },
    };
    expect(projectPublicationPublicWire(input)).toEqual({});
    expect(projectPublicationPublicWire(input, {
      publicExtensionNamespaces: ['https://safe.example/ext'],
    })).toEqual({ extensions: { 'https://safe.example/ext': { visible: true } } });
  });

  it('removes security-context keys and crawled bodies while retaining safe sibling metadata', () => {
    expect(projectPublicationPublicWire({
      security: { key: 'secret-key', label: 'public label' },
      crawlResult: { body: 'private body', status: 200 },
    })).toEqual({
      security: { label: 'public label' },
      crawlResult: { status: 200 },
    });
  });

  it.each([
    ['invalid annotation visibility', { annotations: [{ visibility: 'secret', type: 'note', value: 'x' }] }],
    ['non-object attachment', { attachments: ['not-an-attachment'] }],
    ['non-object extensions', { extensions: [] }],
    ['symbol-bearing credential container', { credentials: { [Symbol('secret')]: true } }],
    ['symbol-bearing extensions', { extensions: { [Symbol('secret')]: true } }],
  ])('rejects malformed projection carrier: %s', (_label, input) => {
    expect(() => projectPublicationPublicWire(input)).toThrow(PublicationPublicProjectionError);
  });

  it('rejects accessors in annotation, credential, and extension security boundaries without invoking them', () => {
    let reads = 0;
    const accessor = () => {
      reads += 1;
      throw new Error('projection-secret');
    };
    const annotation = Object.defineProperty({ type: 'note', value: 'x' }, 'visibility', {
      enumerable: true,
      get: accessor,
    });
    const credentials = Object.defineProperty({}, 'keyHint', { enumerable: true, get: accessor });
    const extensions = Object.defineProperty({}, 'https://safe.example/ext', { enumerable: true, get: accessor });
    for (const input of [
      { annotations: [annotation] },
      { credentials },
      { extensions },
    ]) {
      expect(() => projectPublicationPublicWire(input, {
        publicExtensionNamespaces: ['https://safe.example/ext'],
      })).toThrow(PublicationPublicProjectionError);
    }
    expect(reads).toBe(0);
  });

  it.each([
    null,
    [],
    { publicExtensionNamespaces: ['http://insecure.example/ext'] },
    { publicExtensionNamespaces: [42] },
    { unknown: true },
    { limits: { maxDepth: 0 } },
    { limits: { maxNodes: 0 } },
  ])('rejects invalid public projection policy %j', (options) => {
    const action = options && typeof options === 'object' && 'unknown' in options
      ? () => resolvePublicationPublicProjectionOptions(options as never)
      : () => projectPublicationPublicWire({ safe: true }, options as never);
    expect(action).toThrow(PublicationPublicProjectionError);
  });

  it('reports projection limits as stable errors instead of leaking the input graph', () => {
    const deeplyNested: Record<string, unknown> = {};
    let cursor = deeplyNested;
    for (let index = 0; index < 8; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(() => projectPublicationPublicWire(deeplyNested, { publicExtensionNamespaces: [], limits: { maxDepth: 3 } }))
      .toThrow(PublicationPublicProjectionError);
    try {
      projectPublicationPublicWire({ value: true }, { publicExtensionNamespaces: [], limits: { maxNodes: 1 } });
    } catch (error) {
      expect(error).toBeInstanceOf(PublicationPublicProjectionError);
      expect((error as PublicationPublicProjectionError).code).toBe('projection_limit_exceeded');
      expect((error as Error).message).not.toContain('value');
    }
  });
});

describe(`Discovery capability and anti-discovery header boundary ${evidence}`, () => {
  const item = { id: 'public-item', visibility: 'public', url: 'https://catalog.example/public-item' };
  const validator = (value: unknown): value is typeof item => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).visibility === 'public'
    && typeof (value as Record<string, unknown>).id === 'string'
  );

  it('emits fail-closed anti-discovery headers while preserving unrelated fields', () => {
    const headers = mergePublicationAntiDiscoveryHeaders({
      Vary: 'Origin',
      'X-Request-Id': 'discovery-coverage',
    });
    expect(headers.get('X-Request-Id')).toBe('discovery-coverage');
    expect(headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Vary')).toContain('Origin');
  });

  it.each([
    Object.create({ Vary: 'Origin' }),
    [['X-Trace'] as never],
    [['X-Trace', 1] as never],
  ])('rejects malformed anti-discovery header sources', (headers) => {
    expect(() => mergePublicationAntiDiscoveryHeaders(headers as never)).toThrow(TypeError);
  });

  it.each([null, [], 'unknown-channel'])('rejects malformed discovery capability input %j', (channel) => {
    expect(() => selectPublicationDiscoveryCandidates(channel as never, [item], validator)).toThrow(TypeError);
  });

  it('requires an issued page and selected item identity at the final discovery guard', () => {
    const selected = selectPublicationDiscoveryCandidates('search', [item], validator);
    expect(() => createPublicationDiscoveryPage(selected, {
      items: [structuredClone(item)],
      nextCursor: null,
    })).toThrow(TypeError);
    const page = createPublicationDiscoveryPage(selected, { items: selected.items, nextCursor: null });
    expect(buildPublicationDiscoveryOutput(page).items[0]).toMatchObject({ id: 'public-item' });
    expect(() => buildPublicationDiscoveryOutput({} as never)).toThrow(TypeError);
  });
});

describe(`Collection Metadata Link parser boundary ${evidence}`, () => {
  it('rejects empty, malformed, and relation-less existing Link fields', () => {
    const metadata = JSON.parse(readFileSync(metadataFixture, 'utf8')) as Record<string, unknown>;
    for (const value of ['', 'not-a-link', '<https://safe.example>; rel=""']) {
      expect(() => mergePublicationCollectionMetadataLinkHeaders(metadata, { Link: value }))
        .toThrow(TypeError);
    }
    expect(createPublicationCollectionMetadataLinkHeader(metadata)).toContain('rel="self"');
  });

  it('rejects symbol-bearing metadata links without reading a hostile value', () => {
    const metadata = JSON.parse(readFileSync(metadataFixture, 'utf8')) as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(metadata.links as object, Symbol('forbidden'), {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('metadata-link-secret');
      },
    });
    expect(() => createPublicationCollectionMetadataLinkHeader(metadata)).toThrow(TypeError);
    expect(reads).toBe(0);
  });
});

describe(`Node-write Problem mapping boundary ${evidence}`, () => {
  it.each([
    ['invalid_node_mutation', 'invalid_document'],
    ['node_read_only', 'node_read_only'],
    ['node_policy_denied', 'insufficient_scope'],
    ['authorization_denied', 'resource_not_found'],
  ] as const)('maps %s to the registered wire definition', (denial, code) => {
    const result = mapNodeWriteDenialToProblem({ code: denial } as never, {
      authorizationFailure: 'resource_not_found',
    });
    expect(result).toMatchObject({ code, status: expect.any(Number), retryable: expect.any(Boolean) });
  });

  it('uses the caller concealment decision for authorization denial', () => {
    expect(mapNodeWriteDenialToProblem({ code: 'authorization_denied' } as never, {
      authorizationFailure: 'insufficient_scope',
    }).code).toBe('insufficient_scope');
    expect(() => mapNodeWriteDenialToProblem({ code: 'unknown-denial' } as never, {
      authorizationFailure: 'resource_not_found',
    })).toThrow(TypeError);
  });
});

describe(`Deleted Collection retention and recovery boundary ${evidence}`, () => {
  it('emits a cache-safe 410 with one validated recovery relation before expiry', async () => {
    const deletedAt = new Date('2026-07-01T00:00:00.000Z');
    const tombstone = createPublicationDeletedCollectionTombstone({
      canonicalUrl: 'https://catalog.example/collections/removed',
      deletedAt,
    });
    const target = createPublicationDeletedCollectionRecoveryTarget({
      kind: 'archive',
      url: 'https://archive.example/collections/removed',
    });
    const response = createPublicationDeletedCollectionGoneResponseWithRecoveryTarget(
      new Request('https://catalog.example/collections/removed'),
      tombstone,
      target,
      { now: () => new Date('2026-07-15T00:00:00.000Z') },
    );
    expect(response?.status).toBe(410);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(response?.headers.get('Link')).toContain('rel="https://collectionprotocol.org/rels/archive"');
    expect(await response?.json()).toMatchObject({ status: 410, links: expect.any(Object) });
  });

  it.each([
    ['too-short retention', { retentionMilliseconds: 1 }],
    ['non-HTTP canonical URL', { canonicalUrl: 'file:///collections/removed' }],
    ['invalid deleted date', { deletedAt: new Date(Number.NaN) }],
  ])('rejects %s tombstone input', (_label, change) => {
    expect(() => createPublicationDeletedCollectionTombstone({
      canonicalUrl: 'https://catalog.example/collections/removed',
      deletedAt: new Date('2026-07-01T00:00:00.000Z'),
      ...change,
    } as never)).toThrow();
  });
});

describe(`Static Publication declaration selection boundaries ${evidence}`, () => {
  it('snapshots only the selected fixture Mount and rejects unknown IDs', () => {
    const manifest = JSON.parse(readFileSync(manifestFixture, 'utf8')) as Record<string, any>;
    const mountId = manifest.mounts[0].id as string;
    manifest.mounts[0].profiles = ['core', 'publication', 'feed'];
    manifest.mounts[0].endpoints.instanceFeed = 'https://alice.example/collections/-/feed';
    manifest.mounts[0].endpoints.collectionFeed = 'https://alice.example/collections/c/{collectionId}/feed';
    manifest.mounts[0].features.feed = { modes: ['live', 'release'] };
    const selected = snapshotPublicationStaticManifestProfiles(manifest, [mountId]);
    expect(selected.declarations.map((value) => value.mountId)).toEqual([mountId]);
    expect(() => snapshotPublicationStaticManifestProfiles(manifest, ['missing-mount']))
      .toThrow(TypeError);
  });

  it('rejects static endpoint declarations with unsafe URL layouts', () => {
    const manifest = JSON.parse(readFileSync(manifestFixture, 'utf8')) as Record<string, any>;
    const mount = manifest.mounts[0] as Record<string, any>;
    mount.profiles = ['core', 'publication'];
    delete mount.endpoints.instanceFeed;
    delete mount.endpoints.collectionFeed;
    delete mount.features.feed;
    mount.endpoints.directory = 'https://static.example/collections/index.json?private=1';
    expect(() => snapshotPublicationStaticEndpoints(mount)).toThrow(TypeError);
  });
});

describe(`Anonymous Directory candidate container boundary ${evidence}`, () => {
  it('rejects sparse and over-limit candidate arrays before reading records', () => {
    expect(() => selectAnonymousDirectoryCandidates(new Array(1))).toThrow(TypeError);
    expect(() => selectAnonymousDirectoryCandidates(Array.from({ length: 10_001 }, () => ({}))))
      .toThrow(RangeError);
  });
});
