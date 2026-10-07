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
} from '../../src/client/index.js';
import type { ManifestMount } from '../../src/types/index.js';

const evidence = 'http.baseurl-display-origin-only';
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

async function manifest(baseUrl = 'https://base.example/display/root/'): Promise<JsonObject> {
  const value = await fixtureObject('public-manifest.json');
  value.mounts[0].id = 'pub-0028';
  value.mounts[0].baseUrl = baseUrl;
  return value;
}

function href(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function protocolResponse(value: unknown, etag = '"pub-0028"', init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('ETag', etag);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(value), { ...init, headers });
}

async function incompleteSnapshot(): Promise<JsonObject> {
  const value = await fixtureObject('collection-snapshot.json');
  value.complete = false;
  value.page = { nextCursor: 'cursor-2', hasMore: true, sequence: 1 };
  return value;
}

describe(`PUB-0028 baseUrl is display and Origin metadata only [evidence:${evidence}]`, () => {
  it('preserves a valid trailing-slash baseUrl for display [evidence:http.baseurl-display-origin-only]', async () => {
    const baseUrl = 'https://display.example/tenants/blue/';
    const value = await manifest(baseUrl);
    const client = new ColpClient({
      manifestUrl,
      fetch: vi.fn(async () => Response.json(value)) as typeof globalThis.fetch,
    });

    const discovered = await client.discover();

    expect(discovered.mounts[0]?.baseUrl).toBe(baseUrl);
  });

  it('rejects a baseUrl without its required trailing slash before endpoint I/O [evidence:http.baseurl-display-origin-only]', async () => {
    const value = await manifest('https://display.example/tenants/blue');
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      throw new Error(`Unexpected endpoint request: ${url}`);
    });

    await expect(new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getDirectory()).rejects.toThrow();

    expect(requested).toEqual([manifestUrl]);
  });

  it.each([
    ['deep encoded path', 'https://origin.example/a/%2Fdirectory/%2e%2e/private/', 'https://origin.example'],
    ['query and fragment', 'https://origin.example/display/root/?route=collections%2Fsecret#snapshot', 'https://origin.example'],
    ['loopback HTTP display path', 'http://127.0.0.1:8787/deep/display/root/?route=directory#frag', 'http://127.0.0.1:8787'],
  ])('reduces %s to an opaque trusted Origin [evidence:http.baseurl-display-origin-only]', async (_name, baseUrl, origin) => {
    const value = await manifest();
    const mount = value.mounts[0] as ManifestMount;
    (mount as { baseUrl: string }).baseUrl = baseUrl;
    const boundary = createPublicationTransportBoundary(mount);

    expect(publicationTrustedOrigin(boundary)).toBe(origin);
    expect(Reflect.ownKeys(boundary)).toEqual([]);
    expect(JSON.stringify(boundary)).toBe('{}');
  });

  it.each([
    ['malformed URL', 'https://[secret.invalid/display/'],
    ['credentialed URL', 'https://user:private@base.example/display/'],
    ['non-loopback HTTP URL', 'http://base.example/private/display/'],
    ['unsupported URL scheme', 'file:///private/display/'],
  ])('rejects %s with a non-reflective error [evidence:http.baseurl-display-origin-only]', async (_name, baseUrl) => {
    const value = await manifest();
    const mount = value.mounts[0] as ManifestMount;
    (mount as { baseUrl: string }).baseUrl = baseUrl;
    let thrown: unknown;

    try {
      createPublicationTransportBoundary(mount);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new TypeError(
      'Publication Mount baseUrl must be HTTPS or loopback HTTP without user information.',
    ));
    expect(String(thrown)).not.toContain(baseUrl);
    expect(String(thrown)).not.toContain('private');
  });

  it('rejects accessor and Proxy baseUrl sources without executing user code [evidence:http.baseurl-display-origin-only]', async () => {
    const value = await manifest();
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

    expect(() => createPublicationTransportBoundary(accessor)).toThrow(TypeError);
    expect(() => createPublicationTransportBoundary(proxy)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
    expect(descriptorTrap).not.toHaveBeenCalled();
  });

  it('isolates captured Origin state from later baseUrl mutation [evidence:http.baseurl-display-origin-only]', async () => {
    const value = await manifest('https://original.example/display/root/');
    const mount = value.mounts[0] as ManifestMount;
    const boundary = createPublicationTransportBoundary(mount);

    (mount as { baseUrl: string }).baseUrl = 'http://localhost:9090/changed/private/';

    expect(publicationTrustedOrigin(boundary)).toBe('https://original.example');
  });
});

describe(`PUB-0028 routing uses exact declared Endpoint and Link targets [evidence:${evidence}]`, () => {
  it.each([
    {
      name: 'same-Origin directory endpoint',
      baseUrl: 'https://same.example/deep/%2Fcollections/display/',
      endpointKey: 'directory' as const,
      declared: 'https://same.example/opaque/catalog.json?limit=4',
      expected: 'https://same.example/opaque/catalog.json?limit=4&tag=design',
      responseFixture: 'collection-directory.json',
      invoke: (client: ColpClient) => client.getDirectory({ tag: 'design' }),
    },
    {
      name: 'cross-Origin collection endpoint',
      baseUrl: 'https://display.example/a/b/c/',
      endpointKey: 'collection' as const,
      declared: 'https://objects.example/by-id/{collectionId}.metadata.json',
      expected: `https://objects.example/by-id/${collectionId}.metadata.json`,
      responseFixture: 'collection-metadata.json',
      invoke: (client: ColpClient) => client.getCollection(collectionId),
    },
    {
      name: 'cross-Origin Snapshot endpoint with fixed query',
      baseUrl: 'https://display.example/snapshots/private/',
      endpointKey: 'snapshot' as const,
      declared: 'https://archive.example/immutable/{collectionId}.json?limit=5',
      expected: `https://archive.example/immutable/${collectionId}.json?limit=5`,
      responseFixture: 'collection-snapshot.json',
      invoke: (client: ColpClient) => client.getSnapshot(collectionId),
    },
  ])('requests the exact $name [evidence:http.baseurl-display-origin-only]', async (testCase) => {
    const value = await manifest(testCase.baseUrl);
    value.mounts[0].endpoints[testCase.endpointKey] = testCase.declared;
    const representation = await fixtureObject(testCase.responseFixture);
    if (testCase.endpointKey === 'collection') representation.collection.id = collectionId;
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      if (url === testCase.expected) return protocolResponse(representation);
      throw new Error(`Undeclared request: ${url}`);
    });

    await testCase.invoke(new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }));

    expect(requested).toEqual([manifestUrl, testCase.expected]);
    expect(requested.some((url) => url.startsWith(testCase.baseUrl))).toBe(false);
  });

  it('follows the exact cross-Origin rel=next Link instead of deriving a page path [evidence:http.baseurl-display-origin-only]', async () => {
    const baseUrl = 'https://display.example/deep/snapshot/root/';
    const value = await manifest(baseUrl);
    const firstUrl = `https://archive.example/opaque/${collectionId}.json?limit=2`;
    const nextUrl = 'https://pages.example/batches/seven.json?limit=2&pageCursor=cursor-2';
    value.mounts[0].endpoints.snapshot = 'https://archive.example/opaque/{collectionId}.json?limit=2';
    const complete = await fixtureObject('collection-snapshot.json');
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'cursor-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      if (url === firstUrl) return protocolResponse(first, '"page-1"', {
        headers: { Link: `<${nextUrl}>; rel="next"` },
      });
      if (url === nextUrl) return protocolResponse(second, '"page-2"');
      throw new Error(`Guessed page request: ${url}`);
    });

    await new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }).getSnapshot(collectionId);

    expect(requested).toEqual([manifestUrl, firstUrl, nextUrl]);
    expect(requested).not.toContain(`${firstUrl}&pageCursor=cursor-2`);
    expect(requested.some((url) => url.startsWith(baseUrl))).toBe(false);
  });

  it.each([
    ['missing endpoint', (mount: JsonObject) => { delete mount.endpoints.directory; }],
    ['relative endpoint', (mount: JsonObject) => { mount.endpoints.directory = '../directory.json'; }],
    ['invalid endpoint URL', (mount: JsonObject) => { mount.endpoints.directory = 'https://[broken'; }],
  ])('does not fall back for an %s [evidence:http.baseurl-display-origin-only]', async (_name, mutate) => {
    const baseUrl = 'https://fallback-trap.example/display/directory/';
    const value = await manifest(baseUrl);
    mutate(value.mounts[0]);
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      throw new Error(`Fallback endpoint I/O: ${url}`);
    });

    await expect(new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getDirectory()).rejects.toThrow();

    expect(requested).toEqual([manifestUrl]);
  });

  it.each([404, 503])('does not fall back after declared endpoint HTTP %i [evidence:http.baseurl-display-origin-only]', async (status) => {
    const baseUrl = 'https://fallback-trap.example/display/root/';
    const endpoint = 'https://errors.example/opaque/catalog.json';
    const value = await manifest(baseUrl);
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
    expect(requested.some((url) => url.startsWith(baseUrl))).toBe(false);
  });

  it.each([
    ['missing Link', undefined],
    ['malformed Link', '<https://pages.example/[broken?pageCursor=cursor-2>; rel="next"'],
  ])('does not guess pagination after %s failure [evidence:http.baseurl-display-origin-only]', async (_name, link) => {
    const baseUrl = 'https://fallback-trap.example/display/snapshots/';
    const firstUrl = `https://pages.example/opaque/${collectionId}.json?limit=5`;
    const value = await manifest(baseUrl);
    value.mounts[0].endpoints.snapshot = 'https://pages.example/opaque/{collectionId}.json?limit=5';
    const page = await incompleteSnapshot();
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(value);
      return protocolResponse(page, '"page-1"', link === undefined ? {} : { headers: { Link: link } });
    });

    await expect(new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getSnapshot(collectionId)).rejects.toThrow();

    expect(requested).toEqual([manifestUrl, firstUrl]);
    expect(requested).not.toContain(`${firstUrl}&pageCursor=cursor-2`);
    expect(requested.some((url) => url.startsWith(baseUrl))).toBe(false);
  });

  it.each([
    ['missing Location', undefined],
    ['invalid Location', 'https://[broken'],
  ])('does not guess a route after redirect %s failure [evidence:http.baseurl-display-origin-only]', async (_name, location) => {
    const baseUrl = 'https://fallback-trap.example/display/redirects/';
    const endpoint = 'https://redirect.example/opaque/start.json';
    const value = await manifest(baseUrl);
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
    expect(requested.some((url) => url.startsWith(baseUrl))).toBe(false);
  });

  it('does not let a mutated discovery result alter the selected route [evidence:http.baseurl-display-origin-only]', async () => {
    const baseUrl = 'https://display.example/original/root/';
    const endpoint = 'https://declared.example/immutable/catalog.json';
    const value = await manifest(baseUrl);
    value.mounts[0].endpoints.directory = endpoint;
    const directory = await fixtureObject('collection-directory.json');
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      return url === manifestUrl ? Response.json(value) : protocolResponse(directory);
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });
    const discovered = await client.discover() as unknown as JsonObject;

    discovered.mounts[0].baseUrl = 'https://mutated.example/private/';
    discovered.mounts[0].endpoints.directory = 'https://mutated.example/guessed.json';
    await client.getDirectory();

    expect(requested).toEqual([manifestUrl, endpoint]);
  });
});

describe(`PUB-0028 cache variants stay bound to exact declared URLs [evidence:${evidence}]`, () => {
  it('keeps variant cache keys and If-None-Match validators on their exact targets [evidence:http.baseurl-display-origin-only]', async () => {
    const baseUrl = 'https://display.example/cache/private/';
    const endpoint = 'https://cache.example/opaque/catalog.json';
    const designUrl = `${endpoint}?tag=design`;
    const scienceUrl = `${endpoint}?tag=science`;
    const value = await manifest(baseUrl);
    value.mounts[0].endpoints.directory = endpoint;
    const directory = await fixtureObject('collection-directory.json');
    const entries = new Map<string, ClientCacheEntry>();
    const setKeys: string[] = [];
    const cache: ClientCache = {
      get(key) { return entries.get(key); },
      set(key, entry) { setKeys.push(key); entries.set(key, entry); },
      delete(key) { entries.delete(key); },
    };
    const observed: Array<{ url: string; ifNoneMatch: string | null }> = [];
    const calls = new Map<string, number>();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = href(input);
      if (url === manifestUrl) return Response.json(value);
      const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
      observed.push({ url, ifNoneMatch });
      const count = (calls.get(url) ?? 0) + 1;
      calls.set(url, count);
      const etag = url === designUrl ? '"design-v1"' : '"science-v1"';
      return count === 1
        ? protocolResponse(directory, etag)
        : new Response(null, { status: 304, headers: { ETag: etag } });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache,
      cachePartition: 'principal-a',
    });

    await client.getDirectory({ tag: 'design' });
    await client.getDirectory({ tag: 'science' });
    await client.getDirectory({ tag: 'design' });
    await client.getDirectory({ tag: 'science' });

    expect(observed).toEqual([
      { url: designUrl, ifNoneMatch: null },
      { url: scienceUrl, ifNoneMatch: null },
      { url: designUrl, ifNoneMatch: '"design-v1"' },
      { url: scienceUrl, ifNoneMatch: '"science-v1"' },
    ]);
    expect(setKeys).toHaveLength(2);
    expect(setKeys).toEqual(expect.arrayContaining([
      expect.stringContaining(`url=${designUrl}`),
      expect.stringContaining(`url=${scienceUrl}`),
    ]));
    expect(observed.some(({ url }) => url.startsWith(baseUrl))).toBe(false);
  });
});

describe(`PUB-0028 direct endpoint resolution never uses baseUrl path text [evidence:${evidence}]`, () => {
  it('resolves only the exact declaration while baseUrl contributes Origin policy [evidence:http.baseurl-display-origin-only]', async () => {
    const value = await manifest('https://same.example/display/%2Fdirectory/deep/?route=secret#fragment');
    const mount = value.mounts[0] as ManifestMount;
    (mount.endpoints as Record<string, string>).directory = 'https://same.example/exact/catalog.json';
    const boundary = createPublicationTransportBoundary(mount);

    const endpoint = resolvePublicationEndpoint(mount, 'directory', {}, boundary);

    expect(endpoint.href).toBe('https://same.example/exact/catalog.json');
    expect(publicationTrustedOrigin(boundary)).toBe('https://same.example');
  });
});
