import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  type ClientCache,
  type ClientCacheEntry,
} from '../../src/client/index.js';

const evidence = '[evidence:http.protocol-version-request]';
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function requestHeaders(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

function protocolResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(body, { ...init, headers });
}

function memoryCache(): ClientCache {
  const entries = new Map<string, ClientCacheEntry>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, value); },
    delete: (key) => { entries.delete(key); },
  };
}

function expectExactProtocolHeader(headers: Headers, version = '0.1'): void {
  expect(headers.get('Collection-Protocol-Version')).toBe(version);
  expect([...headers.keys()].filter((name) => name.toLowerCase() === 'collection-protocol-version')).toHaveLength(1);
}

describe(`PUB-0026 Collection-Protocol-Version request contract ${evidence}`, () => {
  it(`sends one exact default protocol header on Manifest discovery ${evidence}`, async () => {
    const manifest = await fixture('public-manifest.json');
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expectExactProtocolHeader(requestHeaders(init));
      return protocolResponse(manifest);
    });

    await new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }).discover();

    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['directory', 'collection-directory.json', (client: ColpClient) => client.getDirectory()],
    ['collection', 'collection-metadata.json', (client: ColpClient) => client.getCollection(collectionId)],
    ['snapshot', 'collection-snapshot.json', (client: ColpClient) => client.getSnapshot(collectionId)],
  ] as const)(`sends the header on the declared %s endpoint ${evidence}`, async (_name, responseFixture, invoke) => {
    const [manifest, representation] = await Promise.all([
      fixture('public-manifest.json'),
      fixture(responseFixture),
    ]);
    const response = JSON.parse(representation);
    if (responseFixture === 'collection-metadata.json') response.collection.id = collectionId;
    const observed: Headers[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      observed.push(requestHeaders(init));
      return requestUrl(input).pathname === '/.well-known/collection-protocol'
        ? protocolResponse(manifest)
        : protocolResponse(JSON.stringify(response), { headers: { ETag: '"pub-0026"' } });
    });

    await invoke(new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }));

    expect(observed).toHaveLength(2);
    observed.forEach((headers) => expectExactProtocolHeader(headers));
  });

  it(`uses the configured supported version without whitespace or list syntax ${evidence}`, async () => {
    const manifest = await fixture('public-manifest.json');
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expectExactProtocolHeader(requestHeaders(init), '0.1');
      expect(requestHeaders(init).get('Collection-Protocol-Version')).not.toMatch(/[\s,]/u);
      return protocolResponse(manifest);
    });

    await new ColpClient({
      manifestUrl,
      protocolVersion: '0.1',
      fetch: fetch as typeof globalThis.fetch,
    }).discover();
  });

  it(`replaces static and provider attempts to override or duplicate the protocol header ${evidence}`, async () => {
    const manifest = await fixture('public-manifest.json');
    const staticHeaders = new Headers();
    staticHeaders.append('Collection-Protocol-Version', 'static-secret-a');
    staticHeaders.append('collection-protocol-version', 'static-secret-b');
    const providerHeaders = new Headers();
    providerHeaders.append('Collection-Protocol-Version', 'provider-secret-a');
    providerHeaders.append('COLLECTION-PROTOCOL-VERSION', 'provider-secret-b');
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = requestHeaders(init);
      expectExactProtocolHeader(headers);
      expect([...headers.values()].join('\n')).not.toContain('secret');
      return protocolResponse(manifest);
    });

    await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      headers: staticHeaders as never,
      credentialProvider: () => providerHeaders as never,
    }).discover();
  });

  it(`keeps operation headers while preventing caller-controlled protocol overrides ${evidence}`, async () => {
    const [manifest, snapshotText] = await Promise.all([
      fixture('public-manifest.json'),
      fixture('collection-snapshot.json'),
    ]);
    const snapshot = JSON.parse(snapshotText) as {
      collection: { rootNodeId: string };
      nodes: unknown[];
    };
    const created = snapshot.nodes[1];
    const operationRequests: Headers[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const headers = requestHeaders(init);
      expectExactProtocolHeader(headers);
      if (url.pathname === '/.well-known/collection-protocol') return protocolResponse(manifest);
      operationRequests.push(headers);
      return protocolResponse(JSON.stringify(created), {
        status: 201,
        headers: { ETag: '"created"', Location: `${url.href}/created` },
      });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      headers: { 'Collection-Protocol-Version': 'static-secret' },
      credentialProvider: () => ({ 'Collection-Protocol-Version': 'provider-secret' }),
    });

    await client.createNode(collectionId, {
      parentId: snapshot.collection.rootNodeId,
      node: { kind: 'bookmark', title: 'Created', url: 'https://example.test/created' },
    }, { idempotencyKey: 'pub-0026-operation' });

    expect(operationRequests).toHaveLength(1);
    expect(operationRequests[0]!.get('Idempotency-Key')).toBe('pub-0026-operation');
    expectExactProtocolHeader(operationRequests[0]!);
  });

  it(`preserves the protocol header and trusted secrets across same-Origin redirects ${evidence}`, async () => {
    const manifest = await fixture('public-manifest.json');
    const observed: Array<{ url: string; headers: Headers; credentials: RequestInit['credentials'] }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      observed.push({ url: url.href, headers: requestHeaders(init), credentials: init?.credentials });
      return url.pathname === '/start'
        ? new Response(null, { status: 307, headers: { Location: '/.well-known/collection-protocol' } })
        : protocolResponse(manifest);
    });

    await new ColpClient({
      manifestUrl: 'https://alice.example/start',
      fetch: fetch as typeof globalThis.fetch,
      headers: { 'X-Static-Secret': 'trusted-static' },
      credentialProvider: () => ({ Authorization: 'Bearer trusted-provider' }),
    }).discover();

    expect(observed).toHaveLength(2);
    observed.forEach(({ headers, credentials }) => {
      expectExactProtocolHeader(headers);
      expect(headers.get('X-Static-Secret')).toBe('trusted-static');
      expect(headers.get('Authorization')).toBe('Bearer trusted-provider');
      expect(credentials).toBe('same-origin');
    });
  });

  it(`preserves only the protocol header on an allowed cross-Origin redirect ${evidence}`, async () => {
    const manifest = await fixture('public-manifest.json');
    const observed: Array<{ url: string; headers: Headers; credentials: RequestInit['credentials'] }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      observed.push({ url: url.href, headers: requestHeaders(init), credentials: init?.credentials });
      return url.origin === 'https://alice.example'
        ? new Response(null, { status: 302, headers: { Location: 'https://cdn.example/manifest' } })
        : protocolResponse(manifest);
    });

    await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      headers: { Authorization: 'Bearer static-secret', 'X-Custom-Secret': 'trusted-only' },
      credentialProvider: (url) => url.origin === 'https://alice.example'
        ? { 'X-Provider-Secret': 'trusted-provider' }
        : undefined,
      egressPolicy: () => true,
    }).discover();

    const crossOrigin = observed[1]!;
    expectExactProtocolHeader(crossOrigin.headers);
    expect(crossOrigin.headers.get('Authorization')).toBeNull();
    expect(crossOrigin.headers.get('X-Custom-Secret')).toBeNull();
    expect(crossOrigin.headers.get('X-Provider-Secret')).toBeNull();
    expect(crossOrigin.credentials).toBe('omit');
  });

  it(`preserves the protocol header across same-Origin and allowed cross-Origin pagination Links ${evidence}`, async () => {
    const [manifestText, completeText] = await Promise.all([
      fixture('public-manifest.json'),
      fixture('collection-snapshot.json'),
    ]);
    const manifest = JSON.parse(manifestText) as Record<string, any>;
    const complete = JSON.parse(completeText) as Record<string, any>;
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    const third = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.annotations = [];
    second.page = { nextCursor: 'page-3', hasMore: true, sequence: 2 };
    third.nodes = [];
    third.annotations = complete.annotations;
    third.page = { nextCursor: null, hasMore: false, sequence: 3 };
    const observed: Array<{ url: string; headers: Headers; credentials: RequestInit['credentials'] }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      observed.push({ url: url.href, headers: requestHeaders(init), credentials: init?.credentials });
      if (url.pathname === '/.well-known/collection-protocol') return protocolResponse(JSON.stringify(manifest));
      if (url.searchParams.get('pageCursor') === 'page-2') {
        return protocolResponse(JSON.stringify(second), {
          headers: { ETag: '"page-2"', Link: '<https://pages.example/opaque?pageCursor=page-3>; rel="next"' },
        });
      }
      if (url.origin === 'https://pages.example') {
        return protocolResponse(JSON.stringify(third), { headers: { ETag: '"page-3"' } });
      }
      return protocolResponse(JSON.stringify(first), {
        headers: { ETag: '"page-1"', Link: `<${url.href}?pageCursor=page-2>; rel="next"` },
      });
    });

    await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      headers: { 'X-Custom-Secret': 'trusted-only' },
      credentialProvider: (url) => url.origin === 'https://alice.example'
        ? { Authorization: 'Bearer trusted-provider' }
        : undefined,
      egressPolicy: () => true,
    }).getSnapshot(collectionId);

    const pages = observed.filter(({ url }) => url.includes('/snapshot') || url.includes('/opaque'));
    expect(pages).toHaveLength(3);
    pages.forEach(({ headers }) => expectExactProtocolHeader(headers));
    expect(pages[1]!.headers.get('X-Custom-Secret')).toBe('trusted-only');
    expect(pages[1]!.headers.get('Authorization')).toBe('Bearer trusted-provider');
    expect(pages[2]!.headers.get('X-Custom-Secret')).toBeNull();
    expect(pages[2]!.headers.get('Authorization')).toBeNull();
    expect(pages[2]!.credentials).toBe('omit');
  });

  it(`sends the protocol header together with an exact conditional validator ${evidence}`, async () => {
    const [manifest, directory] = await Promise.all([
      fixture('public-manifest.json'),
      fixture('collection-directory.json'),
    ]);
    let directoryCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const headers = requestHeaders(init);
      expectExactProtocolHeader(headers);
      if (url.pathname === '/.well-known/collection-protocol') {
        return protocolResponse(manifest, { headers: { ETag: '"manifest"' } });
      }
      directoryCalls += 1;
      if (directoryCalls === 1) return protocolResponse(directory, { headers: { ETag: '"directory-v1"' } });
      expect(headers.get('If-None-Match')).toBe('"directory-v1"');
      return new Response(null, { status: 304, headers: { ETag: '"directory-v1"' } });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache: memoryCache(),
      headers: { 'Collection-Protocol-Version': 'static-secret' },
      requestIdentityProvider: () => ({
        credentialProvider: () => ({ 'Collection-Protocol-Version': 'provider-secret' }),
        cachePartition: 'pub-0026-principal',
      }),
    });

    await client.getDirectory();
    await client.getDirectory();

    expect(directoryCalls).toBe(2);
  });

  it.each([
    '0.1, 0.2',
    ' 0.1',
    'protocol-version-secret',
  ])(`rejects unsupported or malformed configured version %j before I/O without reflection ${evidence}`, async (attempt) => {
    const fetch = vi.fn();
    let error: unknown;
    try {
      new ColpClient({ manifestUrl, protocolVersion: attempt as never, fetch: fetch as typeof globalThis.fetch });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).not.toContain(attempt.trim());
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['static', 'static-crlf-secret', (secret: string) => ({
      headers: { 'Collection-Protocol-Version': `0.1\r\nX-Leak: ${secret}` },
    })],
    ['provider', 'provider-crlf-secret', (secret: string) => ({
      credentialProvider: () => ({ 'Collection-Protocol-Version': `0.1\r\nX-Leak: ${secret}` }),
    })],
  ] as const)(`fails closed for malformed %s header input without reflecting its secret ${evidence}`, async (_source, secret, options) => {
    const fetch = vi.fn();
    let error: unknown;
    try {
      const client = new ColpClient({
        manifestUrl,
        fetch: fetch as typeof globalThis.fetch,
        ...options(secret),
      });
      await client.discover();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(secret);
    expect(fetch).not.toHaveBeenCalled();
  });
});
