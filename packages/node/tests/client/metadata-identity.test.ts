import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ColpClient, type ClientCache, type ClientCacheEntry } from '../../src/client/index.js';
import type { CollectionMetadata } from '../../src/types/index.js';

const fixture = (name: string): string => readFileSync(new URL('../../fixtures/protocol/examples/' + name, import.meta.url), 'utf8');

describe('Metadata resource identity', () => {
  it.each([200, 304])('rejects another Collection from HTTP %s before cache or caller observes it', async status => {
    const metadata = JSON.parse(fixture('collection-metadata.json')) as CollectionMetadata;
    const writes: string[] = [];
    const deleted: string[] = [];
    const cache: ClientCache = {
      get: key => status === 304 && !key.includes('.well-known') ? { etag: '"r1"', representation: metadata } : undefined,
      set: key => { writes.push(key); },
      delete: key => { deleted.push(key); },
    };
    const client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', cache,
      fetch: async input => String(input).includes('.well-known')
        ? new Response(fixture('public-manifest.json'), { headers: { 'content-type': 'application/json' } })
        : new Response(status === 304 ? null : JSON.stringify(metadata), { status, headers: { 'content-type': 'application/json', etag: '"r1"' } }),
    });
    await expect(client.getCollection('collection-other')).rejects.toMatchObject({ stage: 'semantic', details: [expect.objectContaining({ code: 'collection_identity_mismatch' })] });
    expect(writes.filter(key => !key.includes('.well-known'))).toEqual([]);
    expect(deleted).toHaveLength(status === 304 ? 1 : 0);
  });

  it('accepts and revalidates correctly bound cached metadata', async () => {
    const metadata = JSON.parse(fixture('collection-metadata.json')) as CollectionMetadata;
    let stored: ClientCacheEntry | undefined;
    const cache: ClientCache = { get: () => stored, set: (_key, value) => { stored = value; }, delete: () => { stored = undefined; } };
    const client = new ColpClient({ manifestUrl: 'https://alice.example/.well-known/collection-protocol', cache,
      fetch: async input => String(input).includes('.well-known')
        ? new Response(fixture('public-manifest.json'), { headers: { 'content-type': 'application/json' } })
        : new Response(stored === undefined ? JSON.stringify(metadata) : null, { status: stored === undefined ? 200 : 304, headers: { 'content-type': 'application/json', etag: '"r1"' } }),
    });
    expect(await client.getCollection(metadata.collection.id)).toEqual(metadata);
    expect(await client.getCollection(metadata.collection.id)).toEqual(metadata);
  });
});
