import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  type ClientCache,
  type ClientCacheEntry,
} from '../../src/client/index.js';

/**
 * F-19: credential-bearing clients must not share a static string cache partition.
 * Evidence reuses the authorization-cache family and a client-side isolation tag.
 */
const evidence = 'http.cache.authorization';
const clientEvidence = 'client.cache.partition-isolation';
const evidenceTag = `[evidence:${evidence}][evidence:${clientEvidence}]`;

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const partitionErrorMessage =
  'cachePartition must be a CachePartitionProvider function when credentialProvider is configured.';

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

function protocolResponse(body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (typeof body === 'string' && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('etag')) headers.set('ETag', '"test-etag"');
  return new Response(body, { ...init, headers });
}

function trackingCache(): {
  readonly cache: ClientCache;
  readonly readKeys: string[];
  readonly writeKeys: string[];
} {
  const values = new Map<string, ClientCacheEntry>();
  const readKeys: string[] = [];
  const writeKeys: string[] = [];
  return {
    readKeys,
    writeKeys,
    cache: {
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
    },
  };
}

function publicationFetch(manifest: string, directory: string): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/.well-known/collection-protocol') {
      return new Response(manifest, { headers: { 'Content-Type': 'application/json' } });
    }
    return protocolResponse(directory, { headers: { ETag: '"directory-partition"' } });
  }) as typeof globalThis.fetch;
}

function isDirectoryCacheKey(key: string): boolean {
  return key.includes('url=https://alice.example/collections') && !key.includes('well-known');
}

describe(`F-19 client cache partition isolation ${evidenceTag}`, () => {
  it(`rejects credentialProvider with a static string cachePartition at construction ${evidenceTag}`, () => {
    const base = {
      manifestUrl,
      fetch: vi.fn() as typeof globalThis.fetch,
      credentialProvider: () => ({ Authorization: 'Bearer alice-token' }),
    } as const;

    let error: unknown;
    try {
      new ColpClient({
        ...base,
        cachePartition: 'static-principal-partition',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).name).toBe('TypeError');
    expect((error as TypeError).message).toBe(partitionErrorMessage);
    // Fail-closed construction must not reflect secrets or the partition value.
    expect((error as TypeError).message).not.toContain('Bearer');
    expect((error as TypeError).message).not.toContain('alice-token');
    expect((error as TypeError).message).not.toContain('static-principal-partition');

    // Empty string remains the dedicated RangeError path (still incompatible with credentials).
    expect(() => new ColpClient({
      ...base,
      cachePartition: '',
    })).toThrow(RangeError);
    expect(() => new ColpClient({
      ...base,
      cachePartition: '',
    })).toThrow('must not be empty');

    // credentialProvider alone (no partition) remains constructible; caching stays disabled.
    expect(() => new ColpClient({ ...base })).not.toThrow();
  });

  it(`captures request identities and isolates alice/bob keys ${evidenceTag}`, async () => {
    const [manifest, directory] = await Promise.all([
      fixture('public-manifest.json'),
      fixture('collection-directory.json'),
    ]);
    const { cache, writeKeys } = trackingCache();
    const fetch = publicationFetch(manifest, directory);
    const partitionCalls: Array<{ principal: string; url: string; mountId?: string }> = [];

    const createClient = (principal: string): ColpClient => {
      const credentialProvider = (url: URL, mount: { id: string } | undefined) => {
        partitionCalls.push({
          principal,
          url: url.href,
          ...(mount === undefined ? {} : { mountId: mount.id }),
        });
        return { Authorization: 'Bearer ' + principal + '-secret' };
      };
      return new ColpClient({
        manifestUrl,
        fetch,
        cache,
        requestIdentityProvider: () => ({ credentialProvider, cachePartition: principal }),
      });
    };

    expect(() => createClient('alice')).not.toThrow();
    expect(() => createClient('bob')).not.toThrow();

    await createClient('alice').getDirectory();
    const afterAlice = writeKeys.filter(isDirectoryCacheKey);
    expect(afterAlice).toHaveLength(1);
    const aliceKey = afterAlice[0]!;

    await createClient('bob').getDirectory();
    const afterBob = writeKeys.filter(isDirectoryCacheKey);
    expect(afterBob).toHaveLength(2);
    const bobKey = afterBob.find((key) => key !== aliceKey);
    expect(bobKey).toBeDefined();
    expect(bobKey).not.toBe(aliceKey);

    // Same principal reuses the same partition input and therefore the same key material.
    await createClient('alice').getDirectory();
    const afterAliceAgain = writeKeys.filter(isDirectoryCacheKey);
    expect(afterAliceAgain.filter((key) => key === aliceKey).length).toBeGreaterThanOrEqual(1);
    expect(new Set(afterAliceAgain)).toEqual(new Set([aliceKey, bobKey!]));

    // Keys are digests: raw principal tokens and Authorization material must not appear.
    const material = writeKeys.join('\n');
    expect(material).not.toContain('alice-secret');
    expect(material).not.toContain('bob-secret');
    expect(material).not.toContain('Bearer');
    expect(material).not.toContain('principal=alice');
    expect(material).not.toContain('principal=bob');
    expect(writeKeys.every((key) => key.includes('colp-cache-v1') && key.includes('protocol=0.1'))).toBe(true);

    expect(partitionCalls.some((call) => call.principal === 'alice')).toBe(true);
    expect(partitionCalls.some((call) => call.principal === 'bob')).toBe(true);
    expect(partitionCalls.every((call) => typeof call.url === 'string' && call.url.length > 0)).toBe(true);
  });

  it(`still allows a static string cachePartition without credentialProvider ${evidenceTag}`, async () => {
    const [manifest, directory] = await Promise.all([
      fixture('public-manifest.json'),
      fixture('collection-directory.json'),
    ]);
    const { cache, writeKeys } = trackingCache();
    const fetch = publicationFetch(manifest, directory);

    expect(() => new ColpClient({
      manifestUrl,
      fetch,
      cache,
      cachePartition: 'anonymous-public',
    })).not.toThrow();

    await new ColpClient({
      manifestUrl,
      fetch,
      cache,
      cachePartition: 'anonymous-public',
    }).getDirectory();

    expect(writeKeys.length).toBeGreaterThan(0);
    expect(writeKeys.every((key) => key.includes('colp-cache-v1'))).toBe(true);
    expect(writeKeys.every((key) => key.includes('protocol=0.1'))).toBe(true);
    expect(writeKeys.join('\n')).not.toContain('anonymous-public');
    expect(writeKeys.join('\n')).not.toContain('Bearer');

    // Distinct static strings still isolate (no credentials required).
    const shared = trackingCache();
    const sharedFetch = publicationFetch(manifest, directory);
    await new ColpClient({
      manifestUrl,
      fetch: sharedFetch,
      cache: shared.cache,
      cachePartition: 'tenant-a',
    }).getDirectory();
    await new ColpClient({
      manifestUrl,
      fetch: sharedFetch,
      cache: shared.cache,
      cachePartition: 'tenant-b',
    }).getDirectory();
    const directoryKeys = shared.writeKeys.filter(isDirectoryCacheKey);
    expect(directoryKeys).toHaveLength(2);
    expect(directoryKeys[0]).not.toBe(directoryKeys[1]);
  });
});
