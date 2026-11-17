import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { ColpClient, type ClientCacheEntry } from '../../src/client/index.js';

const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const fixture = (name: string) => readFile(new URL(`../../fixtures/protocol/examples/${name}.json`, import.meta.url), 'utf8');

function cache() {
  const entries = new Map<string, ClientCacheEntry>();
  return {
    entries,
    get: (key: string) => entries.get(key),
    set: vi.fn((key: string, entry: ClientCacheEntry) => { entries.set(key, entry); }),
    delete: vi.fn((key: string) => { entries.delete(key); }),
  };
}

function json(body: string, policy: string, etag = '"current"') {
  return new Response(body, { headers: { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': policy } });
}

describe('publication response storage policy', () => {
  it.each([false, true])('honors no-store at manifest, directory and snapshot boundaries (credentials=%s)', async (credentials) => {
    const [manifest, directory, snapshot] = await Promise.all([
      fixture('public-manifest'), fixture('collection-directory'), fixture('collection-snapshot'),
    ]);
    const store = cache();
    const validators: (string | null)[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      validators.push(new Headers(init?.headers).get('If-None-Match'));
      if (path.includes('.well-known')) return json(manifest, 'private, No-StOrE');
      if (path.endsWith('/snapshot')) return json(snapshot, 'max-age=0, no-store');
      return json(directory, 'private, no-store');
    });
    const client = new ColpClient({
      manifestUrl, fetch, cache: store,
      ...(credentials ? { requestIdentityProvider: () => ({ credentialProvider: () => ({ Authorization: 'Bearer test' }), cachePartition: 'principal-1' }) } : {}),
    });
    await client.discover();
    await client.discover(true);
    await client.getDirectory();
    await client.getDirectory();
    await client.getSnapshot(collectionId);
    await client.getSnapshot(collectionId);
    expect(store.set).not.toHaveBeenCalled();
    expect(validators.length).toBeGreaterThanOrEqual(6);
    expect(validators.every((value) => value === null)).toBe(true);
  });

  it.each([200, 304])('evicts a previous cached entry when HTTP %s changes to no-store', async (status) => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest'), fixture('collection-directory')]);
    const store = cache();
    const validators: (string | null)[] = [];
    let calls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.includes('.well-known')) return json(manifest, 'no-store');
      validators.push(new Headers(init?.headers).get('If-None-Match'));
      calls += 1;
      if (calls === 1) return json(directory, 'private, no-cache');
      return status === 304 && calls === 2
        ? new Response(null, { status: 304, headers: { ETag: '"current"', 'Cache-Control': 'private, no-store' } })
        : json(directory, 'no-store');
    });
    const client = new ColpClient({ manifestUrl, fetch, cache: store });
    await client.getDirectory();
    await client.getDirectory();
    await client.getDirectory();
    expect(validators).toEqual([null, '"current"', null]);
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it('does not confuse quoted extension values with no-store directives', async () => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest'), fixture('collection-directory')]);
    const store = cache();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      return json(path.includes('.well-known') ? manifest : directory, 'private, extension="a, no-store", no-cache');
    });
    await new ColpClient({ manifestUrl, fetch, cache: store }).getDirectory();
    expect(store.set).toHaveBeenCalledTimes(2);
  });
});

describe('client cache validator robustness', () => {
  it('accepts an RFC-legal weak response ETag when no cache is configured', async () => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest'), fixture('collection-directory')]);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      return json(path.includes('.well-known') ? manifest : directory, 'private, no-cache', 'W/"x"');
    });
    const client = new ColpClient({ manifestUrl, fetch });
    await expect(client.getDirectory()).resolves.toMatchObject({ collections: expect.any(Array) });
  });

  it('still rejects an RFC-legal weak response ETag when the response would be cached', async () => {
    const [manifest, directory] = await Promise.all([fixture('public-manifest'), fixture('collection-directory')]);
    const store = cache();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      return json(path.includes('.well-known') ? manifest : directory, 'private, no-cache', 'W/"x"');
    });
    await expect(new ColpClient({ manifestUrl, fetch, cache: store }).getDirectory())
      .rejects.toThrow('strictly quoted entity-tag');
    expect(store.set).not.toHaveBeenCalled();
  });

  it.each(['W/"stale"', '"unterminated'])(
    'treats a corrupt cached validator %j as a cache miss and replaces the entry',
    async (corruptEtag) => {
      const [manifest, directory] = await Promise.all([fixture('public-manifest'), fixture('collection-directory')]);
      const store = cache();
      const validators: (string | null)[] = [];
      let directoryCalls = 0;
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path.includes('.well-known')) return json(manifest, 'private, no-cache', '"manifest-v1"');
        directoryCalls += 1;
        validators.push(new Headers(init?.headers).get('If-None-Match'));
        if (directoryCalls === 1) return json(directory, 'private, no-cache', '"directory-v1"');
        const refreshed = JSON.parse(directory) as { collections: Array<{ title: string }> };
        refreshed.collections[0]!.title = 'refetched';
        return json(JSON.stringify(refreshed), 'private, no-cache', '"directory-v2"');
      });
      const client = new ColpClient({ manifestUrl, fetch, cache: store });
      await client.getDirectory();
      const directoryKey = [...store.entries.keys()].find((key) => key.includes('/collections'));
      expect(directoryKey).toBeDefined();
      store.entries.set(directoryKey!, {
        etag: corruptEtag,
        representation: store.entries.get(directoryKey!)!.representation,
      });

      const refreshed = await client.getDirectory();

      expect(validators).toEqual([null, null]);
      expect(refreshed.collections[0]!.title).toBe('refetched');
      expect(store.delete).toHaveBeenCalledWith(directoryKey);
      expect(store.entries.get(directoryKey!)?.etag).toBe('"directory-v2"');
    },
  );
});
