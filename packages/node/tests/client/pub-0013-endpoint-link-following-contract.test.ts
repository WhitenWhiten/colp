import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  createPublicationEndpointNavigationTarget,
  createPublicationSnapshotNextNavigationTarget,
  publicationNavigationSource,
  publicationNavigationUrl,
  type ClientCache,
  type ClientCacheEntry,
  type ClientEgressPolicyContext,
  type PublicationNavigationTarget,
} from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import type { ManifestMount } from '../../src/types/index.js';
import { createProtocolJsonResponse } from '../helpers/http-responses.js';

const evidence = 'http.endpoint-link-following';
const manifestUrl = 'https://manifest.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

type JsonObject = Record<string, any>;

interface NavigationObservation {
  readonly url: string;
  readonly context: ClientEgressPolicyContext;
}

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

async function fixtureObject(name: string): Promise<JsonObject> {
  return JSON.parse(await fixture(name)) as JsonObject;
}

async function publicationManifest(): Promise<JsonObject> {
  const manifest = await fixtureObject('public-manifest.json');
  manifest.mounts[0].id = 'selected-publication';
  return manifest;
}

function href(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

const protocolResponse = createProtocolJsonResponse('"pub-0013"');

function observeNavigation(observations: NavigationObservation[]) {
  return (url: URL, context: ClientEgressPolicyContext): true => {
    observations.push({ url: url.href, context });
    return true;
  };
}

function publicationObservations(observations: readonly NavigationObservation[]): readonly NavigationObservation[] {
  return observations.filter(({ context }) => context.purpose === 'publication-read');
}

async function snapshotPages(count: 2 | 3 = 2): Promise<JsonObject[]> {
  const complete = await fixtureObject('collection-snapshot.json');
  const pages = Array.from({ length: count }, () => structuredClone(complete));
  for (const page of pages) {
    page.nodes = [];
    page.annotations = [];
  }
  pages[0]!.nodes = complete.nodes.slice(0, 1);
  pages[1]!.nodes = complete.nodes.slice(1);
  if (count === 2) pages[1]!.annotations = complete.annotations;
  else pages[2]!.annotations = complete.annotations;
  pages.forEach((page, index) => {
    const final = index === pages.length - 1;
    page.page = {
      nextCursor: final ? null : `cursor-${index + 2}`,
      hasMore: !final,
      sequence: index + 1,
    };
  });
  return pages;
}

function navigationInput(
  mount: ManifestMount,
  endpoint: 'directory' | 'collection' | 'snapshot' = 'directory',
  query: object = {},
) {
  return {
    mount,
    endpoint,
    variables: endpoint === 'directory' ? {} : { collectionId },
    query,
    validators: createValidatorRegistry(),
  } as const;
}

describe(`PUB-0013 client follows Endpoint and Link sources [evidence:${evidence}]`, () => {
  it.each([
    {
      name: 'directory opaque static JSON with encoded query',
      endpoint: 'directory' as const,
      declared: 'https://static.example/opaque/catalog-v19.json?tag=fixed',
      expected: 'https://static.example/opaque/catalog-v19.json?tag=fixed&q=caf%C3%A9+%2B%25',
      responseFixture: 'collection-directory.json',
      invoke: (client: ColpClient) => client.getDirectory({ q: 'café +%' }),
    },
    {
      name: 'collection absolute template',
      endpoint: 'collection' as const,
      declared: 'https://objects.example/arbitrary/{collectionId}.metadata.json',
      expected: `https://objects.example/arbitrary/${collectionId}.metadata.json`,
      responseFixture: 'collection-metadata.json',
      invoke: (client: ColpClient) => client.getCollection(collectionId),
    },
    {
      name: 'snapshot cross-Origin template with repeated query encoding',
      endpoint: 'snapshot' as const,
      declared: 'https://exports.example/v3/{collectionId}.json?limit=7',
      expected: `https://exports.example/v3/${collectionId}.json?limit=7&include=relations&include=annotations`,
      responseFixture: 'collection-snapshot.json',
      invoke: (client: ColpClient) => client.getSnapshot(collectionId, {
        include: ['relations', 'annotations'],
      }),
    },
  ])(
    'attributes the initial $name request to the selected Manifest endpoint [evidence:http.endpoint-link-following]',
    async (testCase) => {
      const manifest = await publicationManifest();
      const selected = structuredClone(manifest.mounts[0]);
      selected.id = 'selected-mount';
      selected.endpoints[testCase.endpoint] = testCase.declared;
      const unselected = structuredClone(selected);
      unselected.id = 'unselected-mount';
      unselected.endpoints[testCase.endpoint] = testCase.endpoint === 'directory'
        ? 'https://unselected.example/directory.json'
        : `https://unselected.example/${testCase.endpoint}/{collectionId}.json`;
      manifest.mounts = [unselected, selected];
      const representationObject = await fixtureObject(testCase.responseFixture);
      if (testCase.endpoint === 'snapshot') representationObject.complete = false;
      if (testCase.endpoint === 'collection') representationObject.collection.id = collectionId;
      const representation = JSON.stringify(representationObject);
      const observations: NavigationObservation[] = [];
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = href(input);
        requested.push(url);
        if (url === manifestUrl) return Response.json(manifest);
        if (url === testCase.expected) {
          return new Response(representation, { headers: { ETag: '"initial-source"', 'Content-Type': 'application/json' } });
        }
        throw new Error(`Request was not the selected Manifest endpoint: ${url}`);
      });
      const client = new ColpClient({
        manifestUrl,
        mountId: selected.id,
        fetch: fetch as typeof globalThis.fetch,
        egressPolicy: observeNavigation(observations),
      });

      await testCase.invoke(client);

      expect(requested).toEqual([manifestUrl, testCase.expected]);
      expect(observations[0]?.context.publicationNavigation).toBeUndefined();
      expect(publicationObservations(observations)).toEqual([
        expect.objectContaining({
          url: testCase.expected,
          context: expect.objectContaining({
            mountId: selected.id,
            publicationNavigation: {
              source: { kind: 'manifest-endpoint', mountId: selected.id, endpoint: testCase.endpoint },
              hop: 'target',
            },
          }),
        }),
      ]);
    },
  );

  it('attributes every relative, absolute, and cross-Origin continuation to the current response [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    const pages = await snapshotPages(3);
    const declared = `https://origin.example/exports/${collectionId}.json?limit=2`;
    const redirected = `https://edge.example/batches/start.json?limit=2`;
    const relativeSecond = 'https://edge.example/pages/two.json?limit=2&pageCursor=cursor-2';
    const absoluteThird = 'https://other.example/opaque/final.json?limit=2&pageCursor=cursor-3';
    manifest.mounts[0].endpoints.snapshot = `https://origin.example/exports/{collectionId}.json?limit=2`;
    const requested: string[] = [];
    const observations: NavigationObservation[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(manifest);
      if (url === declared) return new Response(null, { status: 302, headers: { Location: redirected } });
      if (url === redirected) {
        return protocolResponse(pages[0], {
          headers: { Link: '<../pages/two.json?limit=2&pageCursor=cursor-2>; rel="next"' },
        });
      }
      if (url === relativeSecond) {
        return protocolResponse(pages[1], { headers: { Link: `<${absoluteThird}>; rel="next"` } });
      }
      if (url === absoluteThird) return protocolResponse(pages[2]);
      throw new Error(`Unestablished navigation target: ${url}`);
    });

    await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy: observeNavigation(observations),
    }).getSnapshot(collectionId);

    expect(requested).toEqual([manifestUrl, declared, redirected, relativeSecond, absoluteThird]);
    expect(publicationObservations(observations).map(({ url, context }) => ({
      url,
      previousUrl: context.previousUrl?.href ?? null,
      redirectCount: context.redirectCount,
      navigation: context.publicationNavigation,
    }))).toEqual([
      {
        url: declared,
        previousUrl: null,
        redirectCount: 0,
        navigation: {
          source: { kind: 'manifest-endpoint', mountId: 'selected-publication', endpoint: 'snapshot' },
          hop: 'target',
        },
      },
      {
        url: redirected,
        previousUrl: declared,
        redirectCount: 1,
        navigation: {
          source: { kind: 'manifest-endpoint', mountId: 'selected-publication', endpoint: 'snapshot' },
          hop: 'redirect',
        },
      },
      {
        url: relativeSecond,
        previousUrl: null,
        redirectCount: 0,
        navigation: {
          source: { kind: 'response-link', rel: 'next', responseUrl: redirected },
          hop: 'target',
        },
      },
      {
        url: absoluteThird,
        previousUrl: null,
        redirectCount: 0,
        navigation: {
          source: { kind: 'response-link', rel: 'next', responseUrl: relativeSecond },
          hop: 'target',
        },
      },
    ]);
  });

  it('accepts unrelated Link relations while following the sole rel=next target [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    const pages = await snapshotPages();
    const first = `https://pages.example/start/${collectionId}.json?limit=4`;
    const next = 'https://pages.example/opaque/two.json?limit=4&pageCursor=cursor-2';
    manifest.mounts[0].endpoints.snapshot = `https://pages.example/start/{collectionId}.json?limit=4`;
    const observations: NavigationObservation[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      if (url === manifestUrl) return Response.json(manifest);
      if (url === first) {
        return protocolResponse(pages[0], {
          headers: { Link: `<https://docs.example/help>; rel="help", <${next}>; rel="next"` },
        });
      }
      if (url === next) return protocolResponse(pages[1]);
      throw new Error(`Unexpected request: ${url}`);
    });

    await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy: observeNavigation(observations),
    }).getSnapshot(collectionId);

    expect(publicationObservations(observations).at(-1)).toMatchObject({
      url: next,
      context: {
        publicationNavigation: {
          source: { kind: 'response-link', rel: 'next', responseUrl: first },
          hop: 'target',
        },
      },
    });
  });

  it.each([
    ['missing Link', undefined, /exactly one rel=next/u],
    ['wrong relation', '<https://pages.example/two?pageCursor=cursor-2>; rel="previous"', /exactly one rel=next/u],
    ['two rel=next values', '<https://pages.example/a?pageCursor=cursor-2>; rel="next", <https://pages.example/b?pageCursor=cursor-2>; rel="next"', /exactly one rel=next/u],
    ['fragment', '<https://pages.example/two?pageCursor=cursor-2#private>; rel="next"', /fragment/u],
    ['missing cursor', '<https://pages.example/two>; rel="next"', /pageCursor/u],
    ['duplicate cursor', '<https://pages.example/two?pageCursor=cursor-2&pageCursor=cursor-2>; rel="next"', /pageCursor/u],
    ['mismatched cursor', '<https://pages.example/two?pageCursor=other>; rel="next"', /does not match/u],
    ['unknown query', '<https://pages.example/two?pageCursor=cursor-2&unknown=true>; rel="next"', /query is invalid/u],
    ['changed limit scope', '<https://pages.example/two?limit=6&pageCursor=cursor-2>; rel="next"', /query context/u],
  ])(
    'rejects $s without issuing an unestablished continuation [evidence:http.endpoint-link-following]',
    async (_name, link, message) => {
      const manifest = await publicationManifest();
      const pages = await snapshotPages();
      manifest.mounts[0].endpoints.snapshot = `https://pages.example/start/{collectionId}.json?limit=5`;
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = href(input);
        requested.push(url);
        if (url === manifestUrl) return Response.json(manifest);
        return protocolResponse(pages[0], link === undefined ? {} : { headers: { Link: link } });
      });
      const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

      await expect(client.getSnapshot(collectionId)).rejects.toThrow(message);
      expect(requested).toHaveLength(2);
    },
  );

  it.each([
    ['malformed UTF-16 Link', '<https://pages.example/two?pageCursor=cursor-2&q=\ud800>; rel="next"'],
    ['malformed percent encoding', '<https://pages.example/two?pageCursor=cursor-2&root=%>; rel="next"'],
    ['control character', '<https://pages.example/two?pageCursor=cursor-2&root=line\nfeed>; rel="next"'],
    ['oversized query resource', `<https://pages.example/two?pageCursor=cursor-2&root=${'a'.repeat(16_385)}>; rel="next"`],
  ])('rejects unsafe raw %s before producing a target [evidence:http.endpoint-link-following]', (_name, linkHeader) => {
    expect(() => createPublicationSnapshotNextNavigationTarget({
      currentUrl: new URL('https://pages.example/one?root=root-1'),
      initialUrl: new URL('https://pages.example/one?root=root-1'),
      linkHeader,
      hasMore: true,
      nextCursor: 'cursor-2',
      validators: createValidatorRegistry(),
    })).toThrow();
  });

  it.each([404, 503])(
    'does not establish another source after the Manifest endpoint returns HTTP %i [evidence:http.endpoint-link-following]',
    async (status) => {
      const manifest = await publicationManifest();
      const endpoint = 'https://errors.example/opaque-directory.json';
      manifest.mounts[0].endpoints.directory = endpoint;
      const requested: string[] = [];
      const problemCode = status === 404 ? 'resource_not_found' : 'service_unavailable';
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = href(input);
        requested.push(url);
        if (url === manifestUrl) return Response.json(manifest);
        return new Response(JSON.stringify({
          type: `https://know-n.com/colp/problems/${problemCode.replaceAll('_', '-')}`,
          title: 'Endpoint failed',
          status,
          code: problemCode,
        }), { status, headers: { 'Content-Type': 'application/problem+json' } });
      });

      await expect(new ColpClient({
        manifestUrl,
        fetch: fetch as typeof globalThis.fetch,
      }).getDirectory()).rejects.toThrow(problemCode);
      expect(requested).toEqual([manifestUrl, endpoint]);
    },
  );

  it('does not leak trusted-Origin credentials across Endpoint, Link, or redirect hops [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    const pages = await snapshotPages();
    const endpoint = `https://first.example/${collectionId}.json`;
    const redirected = `https://redirected.example/${collectionId}.json`;
    const next = 'https://next.example/static/page.json?pageCursor=cursor-2';
    manifest.mounts[0].endpoints.snapshot = `https://first.example/{collectionId}.json`;
    const publicationRequests: Array<{
      url: string;
      headers: Headers;
      credentials: RequestInit['credentials'];
    }> = [];
    const credentialProvider = vi.fn(async (url: URL) =>
      url.origin === 'https://alice.example' ? { 'X-Principal-Secret': 'private' } : undefined);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = href(input);
      if (url === manifestUrl) return Response.json(manifest);
      publicationRequests.push({
        url,
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
      });
      if (url === endpoint) return new Response(null, { status: 307, headers: { Location: redirected } });
      if (url === redirected) {
        return protocolResponse(pages[0], { headers: { Link: `<${next}>; rel="next"` } });
      }
      if (url === next) return protocolResponse(pages[1]);
      throw new Error(`Unexpected request: ${url}`);
    });

    await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      headers: { Authorization: 'Bearer static-secret', 'X-Static-Secret': 'private' },
      credentialProvider,
      // F-19: credentialProvider requires a CachePartitionProvider function, not a static string.
      cachePartition: () => 'principal-a',
    }).getSnapshot(collectionId);

    expect(publicationRequests.map(({ url }) => url)).toEqual([endpoint, redirected, next]);
    for (const request of publicationRequests) {
      expect(request.credentials).toBe('omit');
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('x-static-secret')).toBeNull();
      expect(request.headers.get('x-principal-secret')).toBeNull();
    }
  });

  it('preserves Endpoint provenance through a cache hit and matching 304 [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    const directory = await fixtureObject('collection-directory.json');
    const endpoint = 'https://cache.example/static/directory.json';
    manifest.mounts[0].endpoints.directory = endpoint;
    const values = new Map<string, ClientCacheEntry>();
    const cacheEvents: string[] = [];
    const cache: ClientCache = {
      get(key) { cacheEvents.push(`get:${key}`); return values.get(key); },
      set(key, value) { cacheEvents.push(`set:${key}`); values.set(key, value); },
      delete(key) { cacheEvents.push(`delete:${key}`); values.delete(key); },
    };
    const observations: NavigationObservation[] = [];
    let endpointCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = href(input);
      if (url === manifestUrl) return Response.json(manifest);
      endpointCalls += 1;
      if (endpointCalls === 1) return protocolResponse(directory, { headers: { ETag: '"directory-v1"' } });
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"directory-v1"');
      return new Response(null, { status: 304, headers: { ETag: '"directory-v1"' } });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache,
      cachePartition: 'principal-a',
      egressPolicy: observeNavigation(observations),
    });

    await client.getDirectory();
    await client.getDirectory();

    expect(endpointCalls).toBe(2);
    expect(cacheEvents.filter((event) => event.startsWith('get:') && event.includes('cache.example'))).toHaveLength(2);
    expect(publicationObservations(observations).map(({ context }) => context.publicationNavigation)).toEqual([
      {
        source: { kind: 'manifest-endpoint', mountId: 'selected-publication', endpoint: 'directory' },
        hop: 'target',
      },
      {
        source: { kind: 'manifest-endpoint', mountId: 'selected-publication', endpoint: 'directory' },
        hop: 'target',
      },
    ]);
  });

  it('partitions cache entries without allowing cached data to forge navigation provenance [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    const directory = await fixtureObject('collection-directory.json');
    const endpoint = 'https://partition.example/static/directory.json';
    manifest.mounts[0].endpoints.directory = endpoint;
    const values = new Map<string, ClientCacheEntry>();
    const endpointKeys: string[] = [];
    const cache: ClientCache = {
      get(key) { return values.get(key); },
      set(key, value) {
        if (key.includes('partition.example')) endpointKeys.push(key);
        values.set(key, {
          ...value,
          publicationNavigation: { source: { kind: 'response-link', responseUrl: 'https://forged.invalid/' } },
        } as ClientCacheEntry);
      },
      delete(key) { values.delete(key); },
    };
    const sources: unknown[] = [];
    const makeClient = (partition: string) => new ColpClient({
      manifestUrl,
      cache,
      cachePartition: partition,
      fetch: vi.fn(async (input: string | URL | Request) =>
        href(input) === manifestUrl ? Response.json(manifest) : protocolResponse(directory)) as typeof globalThis.fetch,
      egressPolicy: (_url, context) => {
        if (context.publicationNavigation !== undefined) sources.push(context.publicationNavigation.source);
        return true;
      },
    });

    await makeClient('principal-a').getDirectory();
    await makeClient('principal-b').getDirectory();

    expect(endpointKeys).toHaveLength(2);
    expect(endpointKeys[0]).not.toBe(endpointKeys[1]);
    expect(sources).toEqual([
      { kind: 'manifest-endpoint', mountId: 'selected-publication', endpoint: 'directory' },
      { kind: 'manifest-endpoint', mountId: 'selected-publication', endpoint: 'directory' },
    ]);
  });
});

describe(`PUB-0013 opaque Publication navigation targets [evidence:${evidence}]`, () => {
  it('freezes and isolates URL and source projections [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    manifest.mounts[0].endpoints.directory = 'https://projection.example/catalog.json?tag=fixed';
    const mount = manifest.mounts[0] as ManifestMount;
    const target = createPublicationEndpointNavigationTarget(navigationInput(mount, 'directory', { q: 'value' }));
    const url = publicationNavigationUrl(target);
    const source = publicationNavigationSource(target);

    url.pathname = '/mutated';
    expect(publicationNavigationUrl(target).href).toBe('https://projection.example/catalog.json?tag=fixed&q=value');
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(source)).toBe(true);
    expect(source).toEqual({
      kind: 'manifest-endpoint',
      mountId: 'selected-publication',
      endpoint: 'directory',
    });
    expect(Reflect.set(source, 'mountId', 'forged')).toBe(false);
    expect(publicationNavigationSource(target)).toEqual(source);
  });

  it('does not expose a transferable brand or accept copied target state [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    const target = createPublicationEndpointNavigationTarget(navigationInput(manifest.mounts[0] as ManifestMount));
    const forged = Object.create(null) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(target)) {
      Object.defineProperty(forged, key, Object.getOwnPropertyDescriptor(target, key)!);
    }

    expect(Reflect.ownKeys(target)).toEqual([]);
    expect(() => publicationNavigationUrl(forged as unknown as PublicationNavigationTarget)).toThrow(
      /established navigation target/u,
    );
    expect(() => publicationNavigationSource({} as PublicationNavigationTarget)).toThrow(
      /established navigation target/u,
    );
  });

  it('rejects malicious accessor and Proxy forgeries without evaluating traps [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    const target = createPublicationEndpointNavigationTarget(navigationInput(manifest.mounts[0] as ManifestMount));
    const hiddenKey = Reflect.ownKeys(target)[0] ?? Symbol('guessed-brand');
    const getter = vi.fn(() => true);
    const accessor = Object.defineProperty({}, hiddenKey, { get: getter });
    const getTrap = vi.fn(() => true);
    const proxy = new Proxy({}, { get: getTrap });

    expect(() => publicationNavigationUrl(accessor as PublicationNavigationTarget)).toThrow(
      /established navigation target/u,
    );
    expect(() => publicationNavigationSource(proxy as PublicationNavigationTarget)).toThrow(
      /established navigation target/u,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
  });

  it('rejects accessor and oversized query input at the target-construction resource boundary [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    const getter = vi.fn(() => 'secret');
    const query = Object.defineProperty({}, 'q', { enumerable: true, get: getter });

    expect(() => createPublicationEndpointNavigationTarget(
      navigationInput(manifest.mounts[0] as ManifestMount, 'directory', query),
    )).toThrow('invalid_query');
    expect(getter).not.toHaveBeenCalled();
    expect(() => createPublicationEndpointNavigationTarget(
      navigationInput(manifest.mounts[0] as ManifestMount, 'directory', { q: 'a'.repeat(16_385) }),
    )).toThrow('invalid_query');
  });
});

describe(`PUB-0013 PUB-0002/0004/0010 regression [evidence:${evidence}]`, () => {
  it('keeps selected Endpoint, exact query codec, and Snapshot cursor scope in one source chain [evidence:http.endpoint-link-following]', async () => {
    const manifest = await publicationManifest();
    const pages = await snapshotPages();
    const endpoint = `https://regression.example/opaque/${collectionId}.json?limit=7&include=relations&include=annotations&depth=2&root=root-1`;
    const next = 'https://next.example/batch.json?include=annotations&include=relations&depth=2&root=root-1&limit=7&pageCursor=cursor-2';
    manifest.mounts[0].endpoints.snapshot = 'https://regression.example/opaque/{collectionId}.json';
    pages[0]!.complete = false;
    pages[1]!.complete = false;
    const observations: NavigationObservation[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      if (url === manifestUrl) return Response.json(manifest);
      if (url === endpoint) return protocolResponse(pages[0], { headers: { Link: `<${next}>; rel="next"` } });
      if (url === next) return protocolResponse(pages[1]);
      throw new Error(`Unexpected regression request: ${url}`);
    });

    await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy: observeNavigation(observations),
    }).getSnapshot(collectionId, {
      include: ['relations', 'annotations'],
      depth: 2,
      root: 'root-1',
      limit: 7,
    });

    expect(publicationObservations(observations).map(({ url, context }) => ({
      url,
      source: context.publicationNavigation?.source,
    }))).toEqual([
      {
        url: endpoint,
        source: { kind: 'manifest-endpoint', mountId: 'selected-publication', endpoint: 'snapshot' },
      },
      {
        url: next,
        source: { kind: 'response-link', rel: 'next', responseUrl: endpoint },
      },
    ]);
  });
});
