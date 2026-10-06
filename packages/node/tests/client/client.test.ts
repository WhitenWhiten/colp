import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  ColpProblemError,
  ColpWireValidationError,
  PublicationQueryError,
  type CachePartitionProvider,
  type ClientCache,
  type ClientCacheEntry,
} from '../../src/client/index.js';
import type { CollectionMetadata } from '../../src/types/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const fixtureCollectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

function protocolResponse(body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (typeof body === 'string' && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('etag')) headers.set('ETag', '"test-etag"');
  return new Response(body, { ...init, headers });
}

function protocolJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('etag')) headers.set('ETag', '"test-etag"');
  return Response.json(value, { ...init, headers });
}

function memoryCache(): ClientCache {
  const values = new Map<string, ClientCacheEntry>();
  return {
    delete(key) {
      values.delete(key);
    },
    get(key) {
      return values.get(key);
    },
    set(key, value) {
      values.set(key, value);
    },
  };
}

describe('publication client', () => {
  it('caches discovery and can force a refresh', async () => {
    const manifest = await fixture('public-manifest.json');
    const fetch = vi.fn(async () => new Response(manifest, { headers: { 'Content-Type': 'application/json' } }));
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await client.discover();
    await client.discover();
    await client.discover(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('follows manifest endpoints and reuses ETags', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    let directoryCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') {
        return protocolResponse(manifest, { status: 200, headers: { ETag: '"manifest-1"' } });
      }
      if (url.pathname === '/collections') {
        directoryCalls += 1;
        const headers = new Headers(init?.headers);
        expect(url.searchParams.getAll('tag')).toEqual(['design']);
        if (directoryCalls === 2) {
          expect(headers.get('if-none-match')).toBe('"directory-1"');
          return new Response(null, { status: 304, headers: { ETag: '"directory-1"' } });
        }
        return new Response(directory, { status: 200, headers: { ETag: '"directory-1"', 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache: memoryCache(),
    });

    const first = await client.getDirectory({ tag: 'design' });
    const second = await client.getDirectory({ tag: 'design' });
    expect(second).toEqual(first);
    expect(directoryCalls).toBe(2);
  });

  it('detaches public Manifest and cached response values from internal state', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    const cache = memoryCache();
    let directoryCalls = 0;
    const requestedUrls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url.href);
      if (url.pathname === '/.well-known/collection-protocol') {
        return protocolResponse(manifest, { headers: { ETag: '"manifest"' } });
      }
      directoryCalls += 1;
      return directoryCalls === 1
        ? new Response(directory, { headers: { ETag: '"directory"', 'Content-Type': 'application/json' } })
        : new Response(null, { status: 304, headers: { ETag: '"directory"' } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache,
    });

    const discovered = await client.discover();
    (discovered.mounts[0]!.endpoints as unknown as { directory: string }).directory =
      'https://evil.example/collections';
    const first = await client.getDirectory();
    first.collections[0]!.title = 'LOCAL-TAMPER';
    const second = await client.getDirectory();

    expect(requestedUrls[1]).toBe('https://alice.example/collections');
    expect(second.collections[0]!.title).toBe('Interface Systems');
    expect(second).not.toBe(first);
  });

  it('does not expose cache-owned representations to callers', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    let cachedEntry: ClientCacheEntry | undefined;
    const cache: ClientCache = {
      delete() {},
      get(key) {
        return key.includes('/.well-known/') ? undefined : cachedEntry;
      },
      set(key, value) {
        if (!key.includes('/.well-known/')) cachedEntry = value;
      },
    };
    let directoryCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      directoryCalls += 1;
      return directoryCalls === 1
        ? new Response(directory, { headers: { ETag: '"directory"', 'Content-Type': 'application/json' } })
        : new Response(null, { status: 304, headers: { ETag: '"directory"' } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache,
    });

    const first = await client.getDirectory();
    expect(Object.isFrozen(cachedEntry?.representation)).toBe(true);
    first.collections[0]!.title = 'CALLER-TAMPER';
    const second = await client.getDirectory();
    expect(second.collections[0]!.title).toBe('Interface Systems');
  });

  it('serializes repeated query values and ignores undefined options', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, unknown>;
    snapshot.complete = false;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      expect(url.searchParams.getAll('include')).toEqual(['annotations', 'attachments']);
      return protocolResponse(JSON.stringify(snapshot));
    });
    const client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch: fetch as typeof globalThis.fetch });
    await client.getSnapshot(fixtureCollectionId, { include: ['annotations', 'attachments'] });
  });

  it('validates Snapshot structure and semantics', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = await fixture('collection-snapshot.json');
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolResponse(snapshot, { headers: { ETag: '"snapshot-1"' } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    expect((await client.getSnapshot(fixtureCollectionId)).complete).toBe(true);
  });

  it('strictly rejects unresolved references in a complete one-page Snapshot', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    snapshot.nodes[1].parentId = 'missing-parent';
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolJson(snapshot);
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('semantic validation failed');
  });

  it('does not silently defer unresolved references in a cropped one-page Snapshot', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    snapshot.complete = false;
    snapshot.nodes = [snapshot.nodes[1]];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolJson(snapshot);
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('semantic validation failed');
  });

  it('does not silently defer unresolved references in a cropped paginated Snapshot', async () => {
    const manifest = await fixture('public-manifest.json');
    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const first = structuredClone(complete);
    first.complete = false;
    first.nodes = [complete.nodes[1]];
    first.annotations = [];
    first.attachments = [];
    first.relations = [];
    first.tombstones = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(first);
    second.nodes = [];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      if (url.searchParams.get('pageCursor') === 'page-2') return protocolJson(second);
      return protocolJson(first, {
        headers: { Link: `<https://alice.example/collections/c/${fixtureCollectionId}/snapshot?depth=1&pageCursor=page-2>; rel="next"` },
      });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getSnapshot(fixtureCollectionId, { depth: 1 })).rejects.toThrow(
      'Snapshot assembly failed',
    );
  });

  it.each(['deferred', 'collection'] as const)(
    'accepts cropped one-page references with an explicit %s resolution policy',
    async (mode) => {
      const manifest = await fixture('public-manifest.json');
      const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
      const root = snapshot.nodes[0];
      snapshot.complete = false;
      snapshot.nodes = [snapshot.nodes[1]];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return url.pathname === '/.well-known/collection-protocol'
          ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
          : protocolJson(snapshot);
      });
      const client = new ColpClient({
        manifestUrl: 'https://alice.example/.well-known/collection-protocol',
        fetch: fetch as typeof globalThis.fetch,
        snapshotReferenceResolution: mode === 'deferred'
          ? { mode }
          : { mode, resolveNode: (nodeId) => nodeId === root.id ? root : undefined },
      });

      await expect(client.getSnapshot(fixtureCollectionId, { depth: 1 })).resolves.toMatchObject({
        complete: false,
        nodes: [{ parentId: root.id }],
      });
    },
  );

  it('assembles paginated Snapshots by following rel=next', async () => {
    const manifest = await fixture('public-manifest.json');
    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      if (url.searchParams.get('pageCursor') === 'page-2') return protocolJson(second);
      return protocolJson(first, {
        headers: { Link: `<https://alice.example/collections/c/${fixtureCollectionId}/snapshot?pageCursor=page-2>; rel="next"` },
      });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    expect((await client.getSnapshot(fixtureCollectionId)).nodes).toHaveLength(complete.nodes.length);
  });

  it('defers individual pages but strictly rejects unresolved references after assembly', async () => {
    const manifest = await fixture('public-manifest.json');
    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.attachments = [];
    first.relations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.nodes[0].parentId = 'missing-after-assembly';
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      return url.searchParams.has('pageCursor')
        ? protocolJson(second)
        : protocolJson(first, {
            headers: { Link: '<https://alice.example/page?pageCursor=page-2>; rel="next"' },
          });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('Snapshot assembly failed');
  });

  it('rejects pagination without a next Link', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    snapshot.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolJson(snapshot);
    });
    const client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch: fetch as typeof globalThis.fetch });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('rel=next');
  });

  it('rejects semantic Snapshot and assembly failures', async () => {
    const manifest = await fixture('public-manifest.json');
    const invalid = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    invalid.collection.rootNodeId = 'missing';
    let fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol' ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } }) : protocolJson(invalid);
    });
    let client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch: fetch as typeof globalThis.fetch });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('semantic validation failed');

    const first = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const second = structuredClone(first);
    first.nodes = first.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = second.nodes.slice(1);
    second.snapshotId = 'wrong';
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      return url.searchParams.has('pageCursor')
        ? protocolJson(second)
        : protocolJson(first, { headers: { Link: '<https://alice.example/page?pageCursor=page-2>; rel="next"' } });
    });
    client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch: fetch as typeof globalThis.fetch });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('page changed');
  });

  it('rejects a semantically invalid Manifest', async () => {
    const manifest = JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
    manifest.mounts[0].endpoints.node = 'https://alice.example/{annotationId}';
    const fetch = vi.fn(async () => Response.json(manifest));
    const client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch: fetch as typeof globalThis.fetch });
    await expect(client.discover()).rejects.toThrow('semantic validation failed');
  });

  it('rejects invalid success and error documents', async () => {
    const manifest = await fixture('public-manifest.json');
    for (const status of [200, 500]) {
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return url.pathname === '/.well-known/collection-protocol'
          ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
          : Response.json({ invalid: true }, { status });
      });
      const client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch: fetch as typeof globalThis.fetch });
      const operation = client.getCollection('id');
      await expect(operation).rejects.toBeInstanceOf(ColpWireValidationError);
      await expect(operation).rejects.toMatchObject({
        name: 'ColpWireValidationError',
        definition: status === 200 ? 'collectionMetadata' : 'problem',
      });
    }
  });

  it('rejects a 304 response when no cache entry exists', async () => {
    const manifest = await fixture('public-manifest.json');
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 304, headers: { ETag: '"unsolicited"' } });
    });
    const client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch: fetch as typeof globalThis.fetch });
    await expect(client.getCollection('id')).rejects.toThrow('did not carry the cached If-None-Match');
  });

  it('rejects a Manifest without a publication Mount', async () => {
    const manifest = JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
    manifest.mounts[0].profiles = ['core'];
    manifest.mounts[0].endpoints = {};
    manifest.mounts[0].features = {};
    const fetch = vi.fn(async () => Response.json(manifest));
    const client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', fetch: fetch as typeof globalThis.fetch });
    await expect(client.discover()).rejects.toThrow('no Mount');
  });

  it('decodes valid Problem Details without parsing human text', async () => {
    const manifest = await fixture('public-manifest.json');
    const problem = await fixture('problem.json');
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : new Response(problem, { status: 412, headers: { 'Content-Type': 'application/problem+json' } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getCollection('collection-1')).rejects.toMatchObject({
      problem: expect.objectContaining({ code: 'precondition_failed' }),
    } satisfies Partial<ColpProblemError>);
  });

  it('does not forward static headers to a cross-Origin Snapshot next page', async () => {
    const manifest = await fixture('public-manifest.json');
    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe('manual');
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      if (url.origin === 'https://pages.example') {
        expect(headers.get('authorization')).toBeNull();
        expect(headers.get('cookie')).toBeNull();
        expect(headers.get('x-static-secret')).toBeNull();
        expect(init?.credentials).toBe('omit');
        return protocolJson(second);
      }
      expect(headers.get('authorization')).toBe('Bearer fixed');
      expect(headers.get('cookie')).toBe('session=fixed');
      return protocolJson(first, {
        headers: { Link: '<https://pages.example/snapshot?pageCursor=page-2>; rel="next"' },
      });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      headers: {
        Authorization: 'Bearer fixed',
        Cookie: 'session=fixed',
        'X-Static-Secret': 'fixed',
      },
    });

    expect((await client.getSnapshot(fixtureCollectionId)).nodes).toHaveLength(complete.nodes.length);
  });

  it('uses credentialProvider as the only cross-Origin redirect authorization', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = await fixture('collection-snapshot.json');
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe('manual');
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      if (url.origin === 'https://cdn.example') {
        expect(headers.get('authorization')).toBe('Bearer delegated');
        expect(headers.get('x-static-secret')).toBeNull();
        return protocolResponse(snapshot);
      }
      expect(headers.get('authorization')).toBe('Bearer fixed');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://cdn.example/final-snapshot' },
      });
    });
    const provider = vi.fn(async (url: URL) =>
      url.origin === 'https://cdn.example' ? { Authorization: 'Bearer delegated' } : undefined);
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      headers: { Authorization: 'Bearer fixed', 'X-Static-Secret': 'fixed' },
      credentialProvider: provider,
    });

    await client.getSnapshot(fixtureCollectionId);
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ origin: 'https://cdn.example' }), expect.any(Object));
  });

  it('rejects HTTPS to HTTP redirects before issuing the downgraded request', async () => {
    const manifest = await fixture('public-manifest.json');
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      return new Response(null, {
        status: 307,
        headers: { Location: 'http://alice.example/insecure-snapshot' },
      });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('HTTPS to HTTP');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects redirect loops using normalized request URLs', async () => {
    const manifest = await fixture('public-manifest.json');
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      return new Response(null, { status: 302, headers: { Location: `${url.href}#ignored` } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('repeated');
  });

  it('enforces Snapshot page, byte, object, and timeout limits', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshotSource = await fixture('collection-snapshot.json');
    const snapshot = JSON.parse(snapshotSource) as Record<string, any>;
    const first = structuredClone(snapshot);
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const firstFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolJson(first, {
            headers: { Link: '<https://alice.example/page?pageCursor=page-2>; rel="next"' },
          });
    });
    let client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: firstFetch as typeof globalThis.fetch,
      snapshotLimits: { maxPages: 1 },
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('page limit');

    const regularFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolResponse(snapshotSource);
    });
    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: regularFetch as typeof globalThis.fetch,
      snapshotLimits: { maxBytes: 16 },
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('byte limit');

    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: regularFetch as typeof globalThis.fetch,
      snapshotLimits: { maxObjects: 1 },
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('object limit');

    const stalledFetch = vi.fn((input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? Promise.resolve(new Response(manifest, { headers: { 'Content-Type': 'application/json' } }))
        : new Promise<Response>(() => undefined);
    });
    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: stalledFetch as typeof globalThis.fetch,
      snapshotLimits: { timeoutMs: 10 },
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('timeout');
  });

  it('detects a repeated rel=next URL before fetching it again', async () => {
    const manifest = await fixture('public-manifest.json');
    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.page = { nextCursor: 'page-2', hasMore: true, sequence: 2 };
    const nextLink = '<https://alice.example/page?pageCursor=page-2>; rel="next"';
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      return url.searchParams.has('pageCursor')
        ? protocolJson(second, { headers: { Link: nextLink } })
        : protocolJson(first, { headers: { Link: nextLink } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('repeated');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects changed query scope, collection context, and page sequence', async () => {
    const manifest = await fixture('public-manifest.json');
    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const first = structuredClone(complete);
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };

    let fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolJson(first, {
            headers: { Link: '<https://alice.example/page?limit=11&pageCursor=page-2>; rel="next"' },
          });
    });
    let client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getSnapshot(fixtureCollectionId, { limit: 10 })).rejects.toThrow('query context');

    const wrongCollection = structuredClone(complete);
    wrongCollection.collection.id = 'another-collection';
    fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolJson(wrongCollection);
    });
    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('semantic validation failed');

    const wrongSequence = structuredClone(complete);
    wrongSequence.page.sequence = 2;
    fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolJson(wrongSequence);
    });
    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('expected sequence 1');
  });

  it('requires explicit selection when a Manifest has multiple publication Mounts', async () => {
    const manifest = JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
    const directory = await fixture('collection-directory.json');
    const secondary = structuredClone(manifest.mounts[0]);
    secondary.id = 'secondary';
    secondary.baseUrl = secondary.baseUrl.replace('alice.example', 'secondary.example');
    for (const [key, value] of Object.entries(secondary.endpoints as Record<string, string>)) {
      secondary.endpoints[key] = value.replace('alice.example', 'secondary.example');
    }
    manifest.mounts.push(secondary);

    let fetch = vi.fn(async (_input: string | URL | Request) => Response.json(manifest));
    let client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.discover()).rejects.toThrow('multiple publication Mounts');

    const requestedOrigins: string[] = [];
    fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedOrigins.push(url.origin);
      return url.pathname === '/.well-known/collection-protocol'
        ? Response.json(manifest)
        : protocolResponse(directory);
    });
    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      mountId: 'secondary',
    });
    await client.getDirectory();
    expect(requestedOrigins).toContain('https://secondary.example');

    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      mountSelector: (mounts) => mounts.find((mount) => mount.id === 'secondary'),
    });
    await client.getDirectory();
  });

  it('accepts only the implemented protocol version and verifies Manifest support', async () => {
    expect(() => new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      protocolVersion: '0.2' as never,
    })).toThrow('Unsupported Collection Protocol version');

    const manifest = JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
    manifest.protocolVersions = ['0.2'];
    const fetch = vi.fn(async () => Response.json(manifest));
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.discover()).rejects.toThrow('does not satisfy manifest');
  });

  it('uses endpoint registry query and success-status contracts', async () => {
    const manifest = await fixture('public-manifest.json');
    const metadata = await fixture('collection-metadata.json');
    let fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolResponse(metadata, { status: 201 });
    });
    let client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getCollection(fixtureCollectionId)).rejects.toThrow('allowed success status');

    fetch = vi.fn(async () => new Response(manifest, { headers: { 'Content-Type': 'application/json' } }));
    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getSnapshot(fixtureCollectionId, {
      include: ['annotations', 'annotations'],
    })).rejects.toSatisfy((error: unknown) => (
      error instanceof PublicationQueryError
      && error.message === 'invalid_query: Publication query is invalid.'
      && error.code === 'invalid_query'
    ));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects rel=next URLs that delete any original Snapshot query parameter', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    snapshot.complete = false;
    snapshot.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolJson(snapshot, {
            headers: { Link: '<https://alice.example/page?pageCursor=page-2>; rel="next"' },
          });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getSnapshot(fixtureCollectionId, {
      limit: 10,
      root: snapshot.collection.rootNodeId,
      include: ['annotations'],
    })).rejects.toThrow('query context');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect target 304 when only the pre-redirect request was conditional', async () => {
    const manifest = await fixture('public-manifest.json');
    const metadata = await fixture('collection-metadata.json');
    const metadataCollectionId = (JSON.parse(metadata) as CollectionMetadata).collection.id;
    const cache = memoryCache();
    let endpointCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      endpointCalls += 1;
      if (endpointCalls === 1) {
        return protocolResponse(metadata, { headers: { ETag: '"collection-v1"' } });
      }
      if (url.pathname === '/redirected-collection') {
        expect(new Headers(init?.headers).has('if-none-match')).toBe(false);
        return new Response(null, { status: 304, headers: { ETag: '"collection-v1"' } });
      }
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"collection-v1"');
      return new Response(null, { status: 302, headers: { Location: '/redirected-collection' } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache,
    });

    await client.getCollection(metadataCollectionId);
    await expect(client.getCollection(metadataCollectionId)).rejects.toThrow('did not carry');
  });

  it('partitions cache keys by protocol, static headers, and explicit principal identity', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    const values = new Map<string, ClientCacheEntry>();
    const readKeys: string[] = [];
    const writeKeys: string[] = [];
    const cache: ClientCache = {
      get(key) {
        readKeys.push(key);
        return values.get(key);
      },
      set(key, value) {
        writeKeys.push(key);
        values.set(key, value);
      },
      delete(key) {
        values.delete(key);
      },
    };
    const conditionalHeaders: Array<string | null> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      conditionalHeaders.push(new Headers(init?.headers).get('if-none-match'));
      return protocolResponse(directory, { headers: { ETag: '"directory-principal"' } });
    });
    const createClient = (principal: string, view: string, partition: string | undefined): ColpClient =>
      new ColpClient({
        manifestUrl: 'https://alice.example/.well-known/collection-protocol',
        fetch: fetch as typeof globalThis.fetch,
        cache,
        headers: { 'X-View': view },
        requestIdentityProvider: () => ({
          credentialProvider: async () => ({ Authorization: 'Bearer ' + principal }),
          ...(partition === undefined ? {} : { cachePartition: partition }),
        }),
      });

    await createClient('alice', 'full', 'alice').getDirectory();
    await createClient('bob', 'full', 'bob').getDirectory();
    await createClient('alice', 'compact', 'alice').getDirectory();
    expect(conditionalHeaders).toEqual([null, null, null]);
    expect(new Set(writeKeys).size).toBe(3);
    expect(writeKeys.every((key) => key.includes('protocol=0.1'))).toBe(true);
    expect(writeKeys.join('\n')).not.toContain('Bearer');
    expect(writeKeys.join('\n')).not.toContain('principal=alice');

    const disabledCache: ClientCache = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    };
    await new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache: disabledCache,
      credentialProvider: async () => ({ Authorization: 'Bearer unpartitioned' }),
    }).getDirectory();
    expect(disabledCache.get).not.toHaveBeenCalled();
    expect(disabledCache.set).not.toHaveBeenCalled();
    expect(readKeys.length).toBeGreaterThanOrEqual(3);
  });

  it('validates fixed Manifest endpoint query parameters after merging caller query', async () => {
    const manifest = JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
    manifest.mounts[0].endpoints.snapshot += '?unknown=fixed';
    const fetch = vi.fn(async () => Response.json(manifest));
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toSatisfy((error: unknown) => (
      error instanceof PublicationQueryError
      && error.message === 'invalid_query: Publication query is invalid.'
      && error.code === 'invalid_query'
      && error.issues[0] === 'Unknown query parameter.'
    ));

    manifest.mounts[0].endpoints.snapshot = manifest.mounts[0].endpoints.snapshot
      .replace('?unknown=fixed', '?limit=10');
    const duplicateClient = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(duplicateClient.getSnapshot(fixtureCollectionId, { limit: 20 })).rejects.toSatisfy((error: unknown) => (
      error instanceof PublicationQueryError
      && error.message === 'invalid_query: Publication query is invalid.'
      && error.code === 'invalid_query'
      && error.issues[0] === 'Query parameter must appear once.'
    ));
  });

  it('enforces required response headers for successful Registry operations', async () => {
    const manifest = await fixture('public-manifest.json');
    const metadata = await fixture('collection-metadata.json');
    const metadataCollectionId = (JSON.parse(metadata) as CollectionMetadata).collection.id;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : new Response(metadata, { headers: { 'Content-Type': 'application/json' } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getCollection(metadataCollectionId)).rejects.toThrow('required ETag');

    const cache = memoryCache();
    let collectionCalls = 0;
    const conditionalFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      collectionCalls += 1;
      return collectionCalls === 1
        ? protocolResponse(metadata, { headers: { ETag: '"metadata-v1"' } })
        : new Response(null, { status: 304 });
    });
    const conditionalClient = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: conditionalFetch as typeof globalThis.fetch,
      cache,
    });
    await conditionalClient.getCollection(metadataCollectionId);
    await expect(conditionalClient.getCollection(metadataCollectionId)).rejects.toThrow('required ETag');
  });

  it('starts the Snapshot timeout before discovery', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      snapshotLimits: { timeoutMs: 10 },
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('timeout');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats differently ordered Collection JSON objects as the same page context', async () => {
    const manifest = await fixture('public-manifest.json');
    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    second.collection = Object.fromEntries(Object.entries(second.collection).reverse());
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      return url.searchParams.has('pageCursor')
        ? protocolJson(second)
        : protocolJson(first, {
            headers: { Link: '<https://alice.example/page?pageCursor=page-2>; rel="next"' },
          });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    expect((await client.getSnapshot(fixtureCollectionId)).nodes).toHaveLength(complete.nodes.length);
  });

  it('cancels bodies on Content-Length rejection, redirects, and stalled-reader timeout', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = await fixture('collection-snapshot.json');

    let lengthCanceled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(snapshot));
      },
      cancel() {
        lengthCanceled = true;
      },
    });
    let fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : new Response(oversized, {
            headers: {
              'Content-Type': 'application/json',
              ETag: '"oversized"',
              'Content-Length': '1000000',
            },
          });
    });
    let client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      snapshotLimits: { maxBytes: 16 },
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('byte limit');
    await vi.waitFor(() => expect(lengthCanceled).toBe(true));

    let redirectCanceled = false;
    const redirectBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        redirectCanceled = true;
      },
    });
    fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      return url.pathname === '/redirect-final'
        ? protocolResponse(snapshot)
        : new Response(redirectBody, { status: 302, headers: { Location: '/redirect-final' } });
    });
    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await client.getSnapshot(fixtureCollectionId);
    await vi.waitFor(() => expect(redirectCanceled).toBe(true));

    let stalledCanceled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        stalledCanceled = true;
        throw new Error('Stalled stream cancellation failed.');
      },
    });
    fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : new Response(stalled, {
            headers: { 'Content-Type': 'application/json', ETag: '"stalled"' },
          });
    });
    client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      snapshotLimits: { timeoutMs: 10 },
    });
    await expect(client.getSnapshot(fixtureCollectionId)).rejects.toThrow('timeout');
    await vi.waitFor(() => expect(stalledCanceled).toBe(true));
  });
});

describe('publication client defensive boundaries', () => {
  it('rejects invalid options and unsafe request URLs before I/O', async () => {
    const base = { manifestUrl: 'https://alice.example/.well-known/collection-protocol' } as const;
    expect(() => new ColpClient({ ...base, snapshotLimits: { maxPages: 0 } })).toThrow('safe integer');
    expect(() => new ColpClient({ ...base, maxRedirects: -1 })).toThrow('safe integer');
    expect(() => new ColpClient({ manifestUrl: 'https://user:secret@alice.example/manifest' })).toThrow('user information');
    expect(() => new ColpClient({ manifestUrl: 'ftp://alice.example/manifest' })).toThrow('Unsupported');
    expect(() => new ColpClient({ manifestUrl: 'http://alice.example/manifest' })).toThrow('loopback');
    expect(() => new ColpClient({
      ...base,
      mountId: 'default',
      mountSelector: () => undefined,
    })).toThrow('either mountId or mountSelector');
    expect(() => new ColpClient({ ...base, cachePartition: '' })).toThrow('must not be empty');
    expect(() => new ColpClient({ manifestUrl: 'http://localhost/manifest' })).not.toThrow();

    const manifest = await fixture('public-manifest.json');
    const fetch = vi.fn(async () => new Response(manifest, { headers: { 'Content-Type': 'application/json' } }));
    await new ColpClient({
      manifestUrl: 'https://alice.example/%aa/manifest',
      fetch: fetch as typeof globalThis.fetch,
    }).discover();
  });

  it('rejects missing, ineligible, and invalid Mount selections and accepts string selection', async () => {
    const manifest = JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
    const secondary = structuredClone(manifest.mounts[0]);
    secondary.id = 'secondary';
    const coreOnly = structuredClone(manifest.mounts[0]);
    coreOnly.id = 'core-only';
    coreOnly.profiles = ['core'];
    manifest.mounts.push(secondary, coreOnly);
    const fetch = vi.fn(async () => Response.json(manifest));
    const options = {
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    };

    await expect(new ColpClient({ ...options, mountId: 'missing' }).discover()).rejects.toThrow('no Mount with id');
    await expect(new ColpClient({ ...options, mountId: 'core-only' }).discover()).rejects.toThrow('does not support');
    await expect(new ColpClient({ ...options, mountSelector: () => undefined }).discover()).rejects.toThrow('did not select');
    await expect(new ColpClient({ ...options, mountSelector: () => 'secondary' }).discover()).resolves.toMatchObject({
      mounts: expect.arrayContaining([expect.objectContaining({ id: 'secondary' })]),
    });
  });

  it('rejects inconsistent Snapshot page metadata and incomplete assembly inputs', async () => {
    const manifest = await fixture('public-manifest.json');
    const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const clientFor = (
      snapshot: Record<string, any>,
      headers?: ConstructorParameters<typeof Headers>[0],
    ): ColpClient => {
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return url.pathname === '/.well-known/collection-protocol'
          ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
          : protocolJson(snapshot, headers === undefined ? {} : { headers });
      });
      return new ColpClient({
        manifestUrl: 'https://alice.example/.well-known/collection-protocol',
        fetch: fetch as typeof globalThis.fetch,
      });
    };

    const syncMode = structuredClone(complete);
    syncMode.mode = 'sync';
    syncMode.syncCursor = 'sync-cursor';
    await expect(clientFor(syncMode).getSnapshot(fixtureCollectionId)).rejects.toThrow('Snapshot mode sync');

    await expect(clientFor(complete, {
      Link: '<https://alice.example/unexpected?pageCursor=unused>; rel="next"',
    }).getSnapshot(fixtureCollectionId)).rejects.toThrow('unexpectedly supplies rel=next');

    const paginated = structuredClone(complete);
    paginated.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    await expect(clientFor(paginated, {
      Link: '<https://alice.example/page?pageCursor=page-2#fragment>; rel="next"',
    }).getSnapshot(fixtureCollectionId)).rejects.toThrow('must not contain a fragment');
    await expect(clientFor(paginated, {
      Link: '<https://alice.example/page?pageCursor=wrong>; rel="next"',
    }).getSnapshot(fixtureCollectionId)).rejects.toThrow('does not match page.nextCursor');
    await expect(clientFor(paginated, {
      Link: '<https://alice.example/page?pageCursor=page-2&unknown=value>; rel="next"',
    }).getSnapshot(fixtureCollectionId)).rejects.toThrow('rel=next query is invalid');
    await expect(clientFor(complete).getSnapshot(fixtureCollectionId, {
      pageCursor: 'page-2',
    })).rejects.toThrow('must start without pageCursor');

    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      return url.searchParams.has('pageCursor')
        ? protocolJson(second)
        : protocolJson(first, {
            headers: { Link: '<https://alice.example/page?pageCursor=page-2>; rel="next"' },
          });
    });
    const duplicateClient = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(duplicateClient.getSnapshot(fixtureCollectionId)).rejects.toThrow('assembly failed');
  });

  it('guards against broken redirect implementations and redirect limits', async () => {
    const manifest = await fixture('public-manifest.json');
    const metadata = await fixture('collection-metadata.json');
    const clientFor = (response: () => Response, maxRedirects = 5): ColpClient => {
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return url.pathname === '/.well-known/collection-protocol' ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } }) : response();
      });
      return new ColpClient({
        manifestUrl: 'https://alice.example/.well-known/collection-protocol',
        fetch: fetch as typeof globalThis.fetch,
        maxRedirects,
      });
    };

    const rejectingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(metadata));
      },
      cancel() {
        throw new Error('Response cancellation failed.');
      },
    });
    const followed = new Response(rejectingBody, { headers: { ETag: '"metadata"' } });
    Object.defineProperty(followed, 'redirected', { value: true });
    await expect(clientFor(() => followed).getCollection(fixtureCollectionId)).rejects.toThrow('redirect: manual');

    const wrongUrl = protocolResponse(metadata);
    Object.defineProperty(wrongUrl, 'url', { value: 'https://other.example/collection' });
    await expect(clientFor(() => wrongUrl).getCollection(fixtureCollectionId)).rejects.toThrow('redirect: manual');
    await expect(clientFor(() => new Response(null, { status: 302 })).getCollection(fixtureCollectionId)).rejects.toThrow('missing Location');
    await expect(clientFor(
      () => new Response(null, { status: 302, headers: { Location: '/next' } }),
      0,
    ).getCollection(fixtureCollectionId)).rejects.toThrow('redirect limit');
  });

  it('handles cache partition providers and provider failures fail-closed', async () => {
    const manifest = await fixture('public-manifest.json');
    const directory = await fixture('collection-directory.json');
    const cache: ClientCache = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : protocolResponse(directory);
    });
    const partitionProvider = vi.fn<CachePartitionProvider>(async () => 'principal-a');
    await new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache,
      cachePartition: partitionProvider,
    }).getDirectory();
    expect(partitionProvider).toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalled();

    const disabledCache: ClientCache = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    await new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache: disabledCache,
      cachePartition: async () => undefined,
    }).getDirectory();
    expect(disabledCache.get).not.toHaveBeenCalled();

    await expect(new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      credentialProvider: async () => Promise.reject(new Error('Credential lookup failed.')),
    }).discover()).rejects.toThrow('Credential lookup failed');

    const stalledPartition = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache,
      cachePartition: () => new Promise<string>(() => undefined),
      snapshotLimits: { timeoutMs: 10 },
    });
    await expect(stalledPartition.getSnapshot(fixtureCollectionId)).rejects.toThrow('timeout');
  });

  it('propagates network-level fetch rejection without writing cache entries', async () => {
    const cache = memoryCache();
    const networkError = new TypeError('fetch failed');
    const fetch = vi.fn(async () => {
      throw networkError;
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache,
    });

    await expect(client.discover()).rejects.toBe(networkError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.get('https://alice.example/.well-known/collection-protocol')).toBeUndefined();
  });

  it('propagates AbortError from fetch without committing cache state', async () => {
    const cache = memoryCache();
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const fetch = vi.fn(async () => {
      throw abortError;
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache,
    });

    await expect(client.discover()).rejects.toBe(abortError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.get('https://alice.example/.well-known/collection-protocol')).toBeUndefined();
  });

  it('rejects malformed, mismatched, unserializable, and oversized cache entries', async () => {
    const manifest = await fixture('public-manifest.json');
    const metadata = JSON.parse(await fixture('collection-metadata.json')) as Record<string, any>;
    const snapshot = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
    const directory = await fixture('collection-directory.json');
    const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
    const isManifestKey = (key: string): boolean => key.includes('/.well-known/collection-protocol');

    const malformedCache: ClientCache = {
      get(key) {
        return isManifestKey(key) ? undefined : { etag: '"malformed"', representation: { page: null } };
      },
      set() {},
      delete() {},
    };
    const malformedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
      expect(new Headers(init?.headers).has('if-none-match')).toBe(true);
      return protocolResponse(directory);
    });
    await new ColpClient({
      manifestUrl,
      fetch: malformedFetch as typeof globalThis.fetch,
      cache: malformedCache,
    }).getDirectory();

    const deleteInvalid = vi.fn();
    const invalidCache: ClientCache = {
      get(key) {
        return isManifestKey(key) ? undefined : { etag: '"invalid"', representation: { invalid: true } };
      },
      set() {},
      delete: deleteInvalid,
    };
    const invalidFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 304, headers: { ETag: '"invalid"' } });
    });
    await expect(new ColpClient({
      manifestUrl,
      fetch: invalidFetch as typeof globalThis.fetch,
      cache: invalidCache,
    }).getCollection(fixtureCollectionId)).rejects.toThrow('Cached response does not satisfy');
    expect(deleteInvalid).toHaveBeenCalled();

    const validCache = (representation: unknown, etag: string): ClientCache => ({
      get(key) {
        return isManifestKey(key) ? undefined : { etag, representation };
      },
      set() {},
      delete() {},
    });
    const mismatchFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 304, headers: { ETag: '"different"' } });
    });
    await expect(new ColpClient({
      manifestUrl,
      fetch: mismatchFetch as typeof globalThis.fetch,
      cache: validCache(metadata, '"metadata"'),
    }).getCollection(fixtureCollectionId)).rejects.toThrow('does not match');

    Object.defineProperty(metadata, 'toJSON', { value: () => undefined, enumerable: false });
    const cached304 = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? new Response(manifest, { headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 304, headers: { ETag: '"metadata"' } });
    });
    await expect(new ColpClient({
      manifestUrl,
      fetch: cached304 as typeof globalThis.fetch,
      cache: validCache(metadata, '"metadata"'),
    }).getCollection(fixtureCollectionId)).rejects.toThrow('not JSON serializable');

    await expect(new ColpClient({
      manifestUrl,
      fetch: cached304 as typeof globalThis.fetch,
      cache: validCache(snapshot, '"metadata"'),
      snapshotLimits: { maxBytes: 16 },
    }).getSnapshot(fixtureCollectionId)).rejects.toThrow('Cached response exceeds');
  });

  it('rejects fixed query parameters on endpoints that do not define a query contract', async () => {
    const manifest = JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
    manifest.mounts[0].endpoints.collection += '?view=fixed';
    const fetch = vi.fn(async () => Response.json(manifest));
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getCollection(fixtureCollectionId)).rejects.toSatisfy((error: unknown) => (
      error instanceof PublicationQueryError
      && error.message === 'invalid_query: Publication query is invalid.'
      && error.code === 'invalid_query'
      && error.issues[0] === 'This Publication endpoint does not accept a query.'
    ));
  });
});
