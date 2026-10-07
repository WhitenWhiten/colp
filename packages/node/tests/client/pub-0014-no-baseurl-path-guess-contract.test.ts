import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  createPublicationTransportBoundary,
  publicationTrustedOrigin,
  resolvePublicationEndpoint,
  type ClientCache,
  type ClientCacheEntry,
  type PublicationTransportBoundary,
} from '../../src/client/index.js';
import type { ManifestMount } from '../../src/types/index.js';
import { createProtocolJsonResponse } from '../helpers/http-responses.js';

const evidence = 'http.no-baseurl-path-guess';
const manifestUrl = 'https://manifest.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

type JsonObject = Record<string, any>;

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

async function fixtureObject(name: string): Promise<JsonObject> {
  return JSON.parse(await fixture(name)) as JsonObject;
}

async function manifest(baseUrl = 'https://base.example/root/'): Promise<JsonObject> {
  const value = await fixtureObject('public-manifest.json');
  value.mounts[0].id = 'selected-publication';
  value.mounts[0].baseUrl = baseUrl;
  return value;
}

function href(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

const protocolResponse = createProtocolJsonResponse('"pub-0014"');

function conventionalCandidates(baseUrl: string, endpoint: 'directory' | 'collection' | 'snapshot'): string[] {
  const base = new URL(baseUrl);
  const suffixes = endpoint === 'directory'
    ? ['directory', 'collections', 'directory.json', 'collections.json']
    : [endpoint, `${endpoint}s`, `${endpoint}/${collectionId}`, `${endpoint}s/${collectionId}`];
  return suffixes.map((suffix) => new URL(suffix, base).href);
}

function expectNoConventionalRequest(
  requested: readonly string[],
  baseUrl: string,
  endpoint: 'directory' | 'collection' | 'snapshot',
): void {
  for (const candidate of conventionalCandidates(baseUrl, endpoint)) {
    expect(requested, `baseUrl-derived candidate was requested: ${candidate}`).not.toContain(candidate);
  }
}

async function incompleteSnapshot(): Promise<JsonObject> {
  const snapshot = await fixtureObject('collection-snapshot.json');
  snapshot.complete = false;
  snapshot.page = { nextCursor: 'cursor-2', hasMore: true, sequence: 1 };
  return snapshot;
}

describe(`PUB-0014 baseUrl is never a Publication path source [evidence:${evidence}]`, () => {
  it.each([
    {
      name: 'directory ignores a deep base path with encoded conventional text',
      baseUrl: 'https://same.example/tenant/a/%2Fdirectory/deep-base/',
      endpointKey: 'directory' as const,
      declared: 'https://same.example/opaque/catalog-v7.json?limit=5',
      expected: 'https://same.example/opaque/catalog-v7.json?limit=5&q=term',
      responseFixture: 'collection-directory.json',
      invoke: (client: ColpClient) => client.getDirectory({ q: 'term' }),
    },
    {
      name: 'directory ignores a base path with a trailing slash',
      baseUrl: 'https://same.example/tenant/a/deep-base/',
      endpointKey: 'directory' as const,
      declared: 'https://same.example/static/data.json',
      expected: 'https://same.example/static/data.json',
      responseFixture: 'collection-directory.json',
      invoke: (client: ColpClient) => client.getDirectory(),
    },
    {
      name: 'collection keeps a same-Origin endpoint on a different path',
      baseUrl: 'https://same.example/application/publication/',
      endpointKey: 'collection' as const,
      declared: 'https://same.example/content/{collectionId}.metadata.json',
      expected: `https://same.example/content/${collectionId}.metadata.json`,
      responseFixture: 'collection-metadata.json',
      invoke: (client: ColpClient) => client.getCollection(collectionId),
    },
    {
      name: 'snapshot keeps a cross-Origin opaque endpoint',
      baseUrl: 'https://origin.example/mounts/team-blue/',
      endpointKey: 'snapshot' as const,
      declared: 'https://archive.example/blobs/{collectionId}.json?limit=5',
      expected: `https://archive.example/blobs/${collectionId}.json?limit=5`,
      responseFixture: 'collection-snapshot.json',
      invoke: (client: ColpClient) => client.getSnapshot(collectionId),
    },
    {
      name: 'collection keeps an endpoint with no conventional resource name',
      baseUrl: 'https://api.example/v9/collections/',
      endpointKey: 'collection' as const,
      declared: 'https://objects.example/x/{collectionId}.json',
      expected: `https://objects.example/x/${collectionId}.json`,
      responseFixture: 'collection-metadata.json',
      invoke: (client: ColpClient) => client.getCollection(collectionId),
    },
    {
      name: 'directory preserves an opaque static JSON query target',
      baseUrl: 'https://api.example/v9/%3Froute%3Ddirectory%252Fcollections/',
      endpointKey: 'directory' as const,
      declared: 'https://cdn.example/immutable/3f/asset.json?limit=4',
      expected: 'https://cdn.example/immutable/3f/asset.json?limit=4&tag=design',
      responseFixture: 'collection-directory.json',
      invoke: (client: ColpClient) => client.getDirectory({ tag: 'design' }),
    },
  ])('$name [evidence:http.no-baseurl-path-guess]', async (testCase) => {
    const value = await manifest(testCase.baseUrl);
    value.mounts[0].endpoints[testCase.endpointKey] = testCase.declared;
    const representationObject = JSON.parse(await fixture(testCase.responseFixture));
    if (testCase.responseFixture === 'collection-metadata.json') {
      representationObject.collection.id = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
    }
    const representation = JSON.stringify(representationObject);
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      if (url === testCase.expected) return new Response(representation, { headers: { ETag: '"exact"', 'Content-Type': 'application/json' } });
      throw new Error(`Undeclared Publication request: ${url}`);
    });

    await testCase.invoke(new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }));

    expect(requested).toEqual([manifestUrl, testCase.expected]);
    expectNoConventionalRequest(requested, testCase.baseUrl, testCase.endpointKey);
  });

  it.each([
    ['missing directory', (mount: JsonObject) => { delete mount.endpoints.directory; }],
    ['empty directory', (mount: JsonObject) => { mount.endpoints.directory = ''; }],
    ['invalid directory URL', (mount: JsonObject) => { mount.endpoints.directory = 'not an absolute endpoint'; }],
    ['schema-invalid endpoints shape', (mount: JsonObject) => { mount.endpoints = []; }],
    ['schema-invalid baseUrl', (mount: JsonObject) => { mount.baseUrl = 42; }],
  ])('fails %s before endpoint I/O or conventional fallback [evidence:http.no-baseurl-path-guess]', async (_name, mutate) => {
    const value = await manifest('https://trap.example/conventional/root/');
    mutate(value.mounts[0]);
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      throw new Error(`Endpoint I/O must not occur: ${url}`);
    });

    await expect(new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getDirectory()).rejects.toThrow();

    expect(requested).toEqual([manifestUrl]);
    expectNoConventionalRequest(requested, 'https://trap.example/conventional/root/', 'directory');
  });

  it.each([404, 503])(
    'does not fall back after the declared endpoint returns HTTP %i [evidence:http.no-baseurl-path-guess]',
    async (status) => {
      const baseUrl = 'https://trap.example/conventional/';
      const value = await manifest(baseUrl);
      const endpoint = 'https://errors.example/opaque/catalog.json';
      value.mounts[0].endpoints.directory = endpoint;
      const requested: string[] = [];
      const code = status === 404 ? 'resource_not_found' : 'service_unavailable';
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = href(input);
        requested.push(url);
        if (url === manifestUrl) return Response.json(value);
        return new Response(JSON.stringify({
          type: `https://know-n.com/colp/problems/${code.replaceAll('_', '-')}`,
          title: 'Declared endpoint failed',
          status,
          code,
        }), { status, headers: { 'Content-Type': 'application/problem+json' } });
      });

      await expect(new ColpClient({
        manifestUrl,
        fetch: fetch as typeof globalThis.fetch,
      }).getDirectory()).rejects.toThrow();

      expect(requested).toEqual([manifestUrl, endpoint]);
      expectNoConventionalRequest(requested, baseUrl, 'directory');
    },
  );
});

describe(`PUB-0014 failed Link and redirect navigation has no guessed continuation [evidence:${evidence}]`, () => {
  it.each([
    ['missing Link', undefined],
    ['duplicate rel=next', '<https://pages.example/a?pageCursor=cursor-2>; rel="next", <https://pages.example/b?pageCursor=cursor-2>; rel="next"'],
    ['malformed Link target', '<https://pages.example/[broken?pageCursor=cursor-2>; rel="next"'],
    ['missing cursor', '<https://pages.example/two>; rel="next"'],
    ['duplicate cursor', '<https://pages.example/two?pageCursor=cursor-2&pageCursor=cursor-2>; rel="next"'],
    ['mismatched cursor scope', '<https://pages.example/two?limit=9&pageCursor=cursor-2>; rel="next"'],
  ])('rejects Snapshot %s without synthesizing a cursor URL [evidence:http.no-baseurl-path-guess]', async (_name, link) => {
    const baseUrl = 'https://trap.example/snapshots/';
    const value = await manifest(baseUrl);
    const endpoint = `https://pages.example/opaque/${collectionId}.json?limit=5`;
    value.mounts[0].endpoints.snapshot = 'https://pages.example/opaque/{collectionId}.json?limit=5';
    const page = await incompleteSnapshot();
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      return protocolResponse(page, link === undefined ? {} : { headers: { Link: link } });
    });

    await expect(new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getSnapshot(collectionId)).rejects.toThrow();

    expect(requested).toEqual([manifestUrl, endpoint]);
    expect(requested).not.toContain(`${endpoint}&pageCursor=cursor-2`);
    expectNoConventionalRequest(requested, baseUrl, 'snapshot');
  });

  it.each([
    ['missing Location', undefined],
    ['invalid Location URL', 'https://[invalid'],
    ['credentialed Location', 'https://user:secret@redirect.example/final.json'],
    ['downgrade Location', 'http://redirect.example/final.json'],
  ])('rejects redirect %s without falling back to baseUrl [evidence:http.no-baseurl-path-guess]', async (_name, location) => {
    const baseUrl = 'https://trap.example/conventional/';
    const value = await manifest(baseUrl);
    const endpoint = 'https://redirect.example/opaque/start.json';
    value.mounts[0].endpoints.directory = endpoint;
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      return new Response(null, location === undefined
        ? { status: 302 }
        : { status: 302, headers: { Location: location } });
    });

    await expect(new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getDirectory()).rejects.toThrow();

    expect(requested).toEqual([manifestUrl, endpoint]);
    expectNoConventionalRequest(requested, baseUrl, 'directory');
  });
});

describe(`PUB-0014 query and cache paths cannot create fallback targets [evidence:${evidence}]`, () => {
  it.each([
    ['duplicate fixed directory query', 'directory', 'https://declared.example/catalog.json?limit=5', { limit: 6 }],
    ['duplicate fixed Snapshot cursor', 'snapshot', 'https://declared.example/{collectionId}.json?pageCursor=fixed', {}],
    ['caller starts Snapshot with cursor', 'snapshot', 'https://declared.example/{collectionId}.json', { pageCursor: 'caller' }],
  ] as const)('rejects %s before endpoint I/O [evidence:http.no-baseurl-path-guess]', async (_name, endpointKey, endpoint, query) => {
    const baseUrl = 'https://trap.example/query-root/';
    const value = await manifest(baseUrl);
    value.mounts[0].endpoints[endpointKey] = endpoint;
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      throw new Error(`Endpoint I/O must not occur: ${url}`);
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

    await expect(endpointKey === 'directory'
      ? client.getDirectory(query)
      : client.getSnapshot(collectionId, query)).rejects.toThrow();

    expect(requested).toEqual([manifestUrl]);
    expectNoConventionalRequest(requested, baseUrl, endpointKey);
  });

  it('keeps cache hit and matching 304 requests on the exact declared target [evidence:http.no-baseurl-path-guess]', async () => {
    const baseUrl = 'https://trap.example/cache-root/';
    const value = await manifest(baseUrl);
    const endpoint = 'https://cache.example/static/catalog.json';
    value.mounts[0].endpoints.directory = endpoint;
    const directory = await fixtureObject('collection-directory.json');
    const entries = new Map<string, ClientCacheEntry>();
    const cache: ClientCache = {
      get(key) { return entries.get(key); },
      set(key, entry) { entries.set(key, entry); },
      delete(key) { entries.delete(key); },
    };
    const requested: string[] = [];
    let endpointCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
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
    });

    await client.getDirectory();
    await client.getDirectory();

    expect(requested).toEqual([manifestUrl, endpoint, endpoint]);
    expectNoConventionalRequest(requested, baseUrl, 'directory');
  });

  it('partitions cache state without changing the declared request target [evidence:http.no-baseurl-path-guess]', async () => {
    const baseUrl = 'https://trap.example/cache-partition/';
    const value = await manifest(baseUrl);
    const endpoint = 'https://partition.example/opaque/catalog.json';
    value.mounts[0].endpoints.directory = endpoint;
    const directory = await fixtureObject('collection-directory.json');
    const entries = new Map<string, ClientCacheEntry>();
    const endpointKeys: string[] = [];
    const cache: ClientCache = {
      get(key) { return entries.get(key); },
      set(key, entry) { endpointKeys.push(key); entries.set(key, entry); },
      delete(key) { entries.delete(key); },
    };
    const requested: string[] = [];
    const makeClient = (partition: string) => new ColpClient({
      manifestUrl,
      cache,
      cachePartition: partition,
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = href(input);
        requested.push(url);
        return url === manifestUrl ? Response.json(value) : protocolResponse(directory);
      }) as typeof globalThis.fetch,
    });

    await makeClient('principal-a').getDirectory();
    await makeClient('principal-b').getDirectory();

    expect(requested).toEqual([manifestUrl, endpoint, manifestUrl, endpoint]);
    expect(endpointKeys).toHaveLength(2);
    expect(endpointKeys[0]).not.toBe(endpointKeys[1]);
    expectNoConventionalRequest(requested, baseUrl, 'directory');
  });
});

describe(`PUB-0014 transport boundary contains no routable baseUrl path [evidence:${evidence}]`, () => {
  it.each([
    ['deep path and query', 'https://boundary.example/a/b/c/?route=directory%2Fsecret#fragment', 'https://boundary.example'],
    ['percent-encoded path', 'https://boundary.example/%2e%2e/%2Fcollections/', 'https://boundary.example'],
    ['raw percent path and query', 'https://boundary.example/%zz/root/?route=%zz', 'https://boundary.example'],
    ['loopback HTTP', 'http://localhost:8787/private/root/', 'http://localhost:8787'],
  ])('freezes and reduces %s to its trusted Origin [evidence:http.no-baseurl-path-guess]', async (_name, baseUrl, origin) => {
    const value = await manifest(baseUrl);
    const mount = value.mounts[0] as ManifestMount;
    const boundary = createPublicationTransportBoundary(mount);

    expect(Object.isFrozen(boundary)).toBe(true);
    expect(Reflect.ownKeys(boundary)).toEqual([]);
    expect(publicationTrustedOrigin(boundary)).toBe(origin);
    expect(publicationTrustedOrigin(boundary)).not.toContain(new URL(baseUrl).pathname);
    expect(JSON.stringify(boundary)).toBe('{}');
  });

  it('isolates captured transport state from later Mount mutation [evidence:http.no-baseurl-path-guess]', async () => {
    const value = await manifest('https://original.example/private/root/?secret=one');
    const mount = value.mounts[0] as ManifestMount;
    const boundary = createPublicationTransportBoundary(mount);

    (mount as { baseUrl: string }).baseUrl = 'http://localhost:9090/changed/path/?secret=two';

    expect(publicationTrustedOrigin(boundary)).toBe('https://original.example');
    expect(Reflect.ownKeys(boundary)).toEqual([]);
  });

  it('rejects inherited, accessor, and Proxy baseUrl sources without executing them [evidence:http.no-baseurl-path-guess]', async () => {
    const value = await manifest();
    const inherited = Object.create(value.mounts[0]) as ManifestMount;
    const getter = vi.fn(() => 'https://secret.example/private/');
    const accessor = Object.defineProperty(
      { ...value.mounts[0] },
      'baseUrl',
      { enumerable: true, get: getter },
    ) as ManifestMount;
    const getTrap = vi.fn(() => 'https://secret.example/private/');
    const descriptorTrap = vi.fn(() => undefined);
    const proxy = new Proxy(value.mounts[0] as ManifestMount, {
      get: getTrap,
      getOwnPropertyDescriptor: descriptorTrap,
    });
    const invalid = new TypeError(
      'Publication Mount baseUrl must be HTTPS or loopback HTTP without user information.',
    );

    expect(() => createPublicationTransportBoundary(inherited)).toThrow(invalid);
    expect(() => createPublicationTransportBoundary(accessor)).toThrow(invalid);
    expect(() => createPublicationTransportBoundary(proxy)).toThrow(invalid);
    expect(getter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
    expect(descriptorTrap).not.toHaveBeenCalled();
  });

  it('rejects copied, accessor, and Proxy boundary forgeries without executing them [evidence:http.no-baseurl-path-guess]', async () => {
    const value = await manifest();
    const boundary = createPublicationTransportBoundary(value.mounts[0] as ManifestMount);
    const copied = Object.create(null) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(boundary)) {
      Object.defineProperty(copied, key, Object.getOwnPropertyDescriptor(boundary, key)!);
    }
    const guessedKey = Symbol('PublicationTransportBoundary');
    const getter = vi.fn(() => true);
    const accessor = Object.defineProperty({}, guessedKey, { get: getter });
    const getTrap = vi.fn(() => true);
    const proxy = new Proxy({}, { get: getTrap });

    const invalidBoundary = new TypeError('Publication transport boundary is invalid.');
    expect(() => publicationTrustedOrigin(copied as unknown as PublicationTransportBoundary)).toThrow(invalidBoundary);
    expect(() => publicationTrustedOrigin(accessor as PublicationTransportBoundary)).toThrow(invalidBoundary);
    expect(() => publicationTrustedOrigin(proxy as PublicationTransportBoundary)).toThrow(invalidBoundary);
    expect(getter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
  });

  it('rejects a boundary created for another Mount before URL production [evidence:http.no-baseurl-path-guess]', async () => {
    const firstValue = await manifest('https://secure.example/one/private/');
    const first = firstValue.mounts[0] as ManifestMount;
    (first.endpoints as Record<string, string>).directory = 'https://secure.example/declared/catalog.json';
    const secondValue = await manifest('http://localhost:8787/two/private/');
    const second = secondValue.mounts[0] as ManifestMount;
    second.id = 'other-publication';
    const foreignBoundary = createPublicationTransportBoundary(second);
    const getter = vi.fn(() => 'sensitive-route-state');
    const accessorMount = Object.defineProperties({}, {
      id: { get: getter },
      baseUrl: { get: getter },
      profiles: { get: getter },
      endpoints: { get: getter },
    });
    const getTrap = vi.fn(() => 'sensitive-route-state');
    const proxyMount = new Proxy({}, { get: getTrap });
    const ownershipError = new TypeError(
      'Publication transport boundary does not belong to the selected Mount.',
    );

    expect(() => resolvePublicationEndpoint(first, 'directory', {}, foreignBoundary)).toThrow(
      ownershipError,
    );
    expect(() => resolvePublicationEndpoint(
      accessorMount as unknown as ManifestMount,
      'directory',
      {},
      foreignBoundary,
    )).toThrow(ownershipError);
    expect(() => resolvePublicationEndpoint(
      proxyMount as unknown as ManifestMount,
      'directory',
      {},
      foreignBoundary,
    )).toThrow(ownershipError);
    expect(publicationTrustedOrigin(foreignBoundary)).toBe('http://localhost:8787');
    expect(getter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
  });

  it('rejects accessor and Proxy boundary arguments without executing traps [evidence:http.no-baseurl-path-guess]', async () => {
    const value = await manifest('https://secure.example/private/');
    const mount = value.mounts[0] as ManifestMount;
    (mount.endpoints as Record<string, string>).directory = 'https://secure.example/declared/catalog.json';
    const guessedKey = Symbol('boundary-state');
    const getter = vi.fn(() => true);
    const accessor = Object.defineProperty({}, guessedKey, { get: getter });
    const getTrap = vi.fn(() => true);
    const proxy = new Proxy({}, { get: getTrap });

    const invalidBoundary = new TypeError('Publication transport boundary is invalid.');
    expect(() => resolvePublicationEndpoint(
      mount,
      'directory',
      {},
      accessor as PublicationTransportBoundary,
    )).toThrow(invalidBoundary);
    expect(() => resolvePublicationEndpoint(
      mount,
      'directory',
      {},
      proxy as PublicationTransportBoundary,
    )).toThrow(invalidBoundary);
    expect(getter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
  });

  it.each([
    ['credentialed baseUrl', 'https://user:private@base.example/root/'],
    ['non-HTTP baseUrl', 'file:///private/root/'],
    ['non-loopback HTTP baseUrl', 'http://base.example/private/root/'],
  ])('rejects malicious %s without reflecting sensitive baseUrl text [evidence:http.no-baseurl-path-guess]', async (_name, baseUrl) => {
    const value = await manifest();
    const mount = value.mounts[0] as ManifestMount;
    (mount as unknown as { baseUrl: string }).baseUrl = baseUrl;
    let thrown: unknown;

    try {
      createPublicationTransportBoundary(mount);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new TypeError(
      'Publication Mount baseUrl must be HTTPS or loopback HTTP without user information.',
    ));
    expect(String(thrown)).not.toContain('private');
  });

  it('enforces the captured scheme boundary without resolving against its path [evidence:http.no-baseurl-path-guess]', async () => {
    const value = await manifest('https://secure.example/private/base/path/');
    const mount = value.mounts[0] as ManifestMount;
    (mount.endpoints as Record<string, string>).directory = 'http://localhost:8787/explicit/catalog.json';
    const boundary = createPublicationTransportBoundary(mount);

    expect(() => resolvePublicationEndpoint(mount, 'directory', {}, boundary)).toThrow();
    expect(publicationTrustedOrigin(boundary)).toBe('https://secure.example');
  });
});

describe(`PUB-0014 PUB-0002 PUB-0010 PUB-0013 no-guess regression [evidence:${evidence}]`, () => {
  it('keeps selected endpoint query and cursor failure on declared sources only [evidence:http.no-baseurl-path-guess]', async () => {
    const baseUrl = 'https://regression.example/conventional/root/';
    const value = await manifest(baseUrl);
    const initial = `https://objects.example/opaque/${collectionId}.json?limit=7&include=relations`;
    value.mounts[0].endpoints.snapshot = 'https://objects.example/opaque/{collectionId}.json';
    const page = await incompleteSnapshot();
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      return protocolResponse(page);
    });

    await expect(new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getSnapshot(collectionId, { limit: 7, include: ['relations'] })).rejects.toThrow();

    expect(requested).toEqual([manifestUrl, initial]);
    expect(requested).not.toContain(`${initial}&pageCursor=cursor-2`);
    expectNoConventionalRequest(requested, baseUrl, 'snapshot');
  });
});
