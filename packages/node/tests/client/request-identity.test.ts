import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ColpClient, type ClientCacheEntry, type ClientRequestIdentity } from '../../src/client/index.js';
import type { CollectionMetadata, Manifest, Snapshot } from '../../src/types/index.js';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL('../../fixtures/protocol/examples/' + name + '.json', import.meta.url), 'utf8')) as T;
}
const manifest = fixture<Manifest>('public-manifest');
const metadata = fixture<CollectionMetadata>('collection-metadata');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const json = (value: unknown) => Response.json(value, { headers: { ETag: '"current"', 'Cache-Control': 'private, no-cache' } });
const partition = (principal: string) => 'principal=' + createHash('sha256').update(principal).digest('base64url');

describe('captured request identity [evidence:client.cache.partition-isolation]', () => {
  it.each(['cache', 'egress', 'credentials', 'manifest'] as const)('keeps partition and credentials together when identity changes at %s', async stage => {
    let principal = 'alice';
    const writes: Array<[string, ClientCacheEntry]> = [];
    const switchAccount = async () => { await Promise.resolve(); principal = 'bob'; };
    const identities = vi.fn(() => {
      const captured = principal;
      return {
        cachePartition: captured,
        async credentialProvider() {
          if (stage === 'credentials') await switchAccount();
          return { Authorization: 'Bearer ' + captured };
        },
      };
    });
    const client = new ColpClient({
      manifestUrl, requestIdentityProvider: identities,
      cache: {
        async get() { if (stage === 'cache') await switchAccount(); return undefined; },
        set(key, entry) { writes.push([key, entry]); }, delete() {},
      },
      egressPolicy: async () => { if (stage === 'egress') await switchAccount(); return true; },
      fetch: async (url, init) => {
        const identity = new Headers(init?.headers).get('Authorization')!.slice('Bearer '.length);
        if (String(url) === manifestUrl) {
          if (stage === 'manifest') await switchAccount();
          return json(manifest);
        }
        return json({ ...metadata, collection: { ...metadata.collection, title: identity } });
      },
    });
    expect((await client.getCollection(metadata.collection.id)).collection.title).toBe('alice');
    expect(identities).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(2);
    expect(writes.every(([key]) => key.includes(partition('alice')))).toBe(true);
    expect((await client.getCollection(metadata.collection.id)).collection.title).toBe('bob');
    expect(identities).toHaveBeenCalledTimes(2);
    expect(writes.slice(2).every(([key]) => key.includes(partition('bob')))).toBe(true);
  });

  it('captures identity once across a redirect and every Snapshot page, authorizing each destination', async () => {
    const snapshot = fixture<Snapshot>('collection-snapshot');
    const pages = [
      { ...snapshot, nodes: snapshot.nodes.slice(0, 1), annotations: [], page: { hasMore: true, nextCursor: 'second', sequence: 1 } },
      { ...snapshot, nodes: snapshot.nodes.slice(1), page: { hasMore: false, nextCursor: null, sequence: 2 } },
    ];
    let principal = 'alice';
    const credentialUrls: string[] = [];
    const credentials: string[] = [];
    const next = 'https://alice.example/next?pageCursor=second';
    const redirected = 'https://alice.example/redirected';
    const identities = vi.fn(() => {
      const captured = principal;
      return { credentialProvider: (url: URL) => { credentialUrls.push(url.href); return { Authorization: captured }; } };
    });
    const client = new ColpClient({ manifestUrl, requestIdentityProvider: identities, fetch: async (url, init) => {
      credentials.push(new Headers(init?.headers).get('Authorization')!);
      if (String(url) === manifestUrl) return json(manifest);
      principal = 'bob';
      if (String(url) === redirected) return Response.json(pages[0], { headers: { ETag: '"one"', Link: '<' + next + '>; rel="next"' } });
      if (String(url) === next) return json(pages[1]);
      return new Response(null, { status: 302, headers: { Location: redirected } });
    } });
    const result = await client.getSnapshot(snapshot.collection.id);
    expect(result.nodes).toEqual(snapshot.nodes);
    expect(result.annotations).toEqual(snapshot.annotations);
    expect(identities).toHaveBeenCalledTimes(1);
    expect(credentials).toEqual(['alice', 'alice', 'alice', 'alice']);
    expect(credentialUrls.slice(2)).toEqual([redirected, next]);
  });

  it('keeps concurrent discovery mounts attached to their own captured principal', async () => {
    let principal = 'alice';
    const requests: string[] = [];
    const client = new ColpClient({ manifestUrl,
      requestIdentityProvider: () => {
        const captured = principal;
        return { credentialProvider: () => ({ Authorization: captured }) };
      },
      fetch: async (url, init) => {
        const captured = new Headers(init?.headers).get('Authorization')!;
        if (String(url) === manifestUrl) return json(JSON.parse(JSON.stringify(manifest).replaceAll('alice.example', captured + '.example')));
        requests.push(new URL(String(url)).hostname + ':' + captured);
        return json(metadata);
      },
    });
    const alice = client.getCollection(metadata.collection.id);
    principal = 'bob';
    const bob = client.getCollection(metadata.collection.id);
    await Promise.all([alice, bob]);
    expect(requests.sort()).toEqual(['alice.example:alice', 'bob.example:bob']);
  });

  it('aborts a revoked identity before cache wait can reach credentials or publish state', async () => {
    const controller = new AbortController();
    const reason = new Error('identity revoked');
    const credentials = vi.fn(() => ({ Authorization: 'alice' }));
    const fetch = vi.fn();
    const set = vi.fn();
    const client = new ColpClient({ manifestUrl, fetch,
      requestIdentityProvider: () => ({ cachePartition: 'alice', credentialProvider: credentials, signal: controller.signal }),
      cache: { async get() { controller.abort(reason); return undefined; }, set, delete() {} },
    });
    await expect(client.refreshSnapshot(metadata.collection.id)).rejects.toBe(reason);
    expect(credentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(client.currentSnapshot).toBeUndefined();
  });

  it.each([null, {}, { cachePartition: 42, credentialProvider() {} }, { credentialProvider() {}, signal: {} }])(
    'rejects malformed captured identity %j before any transport', async identity => {
      const fetch = vi.fn();
      const client = new ColpClient({ manifestUrl, fetch, requestIdentityProvider: () => identity as ClientRequestIdentity });
      await expect(client.discover()).rejects.toThrow(TypeError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects ambiguous legacy authenticated caching and mixed identity configuration at construction', () => {
    const credentialProvider = () => ({ Authorization: 'secret' });
    expect(() => new ColpClient({ manifestUrl, credentialProvider, cachePartition: () => 'alice',
      cache: { get() { return undefined; }, set() {}, delete() {} },
    })).toThrow('Authenticated caching requires requestIdentityProvider');
    const requestIdentityProvider = () => ({ credentialProvider });
    expect(() => new ColpClient({ manifestUrl, requestIdentityProvider, credentialProvider })).toThrow('cannot be combined');
    expect(() => new ColpClient({ manifestUrl, requestIdentityProvider, cachePartition: 'alice' })).toThrow('cannot be combined');
    expect(() => new ColpClient({ manifestUrl, requestIdentityProvider: true as never })).toThrow('must be a function');
  });
});
