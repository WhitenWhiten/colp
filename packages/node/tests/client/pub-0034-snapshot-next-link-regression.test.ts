import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  publicationSnapshotNextUrl,
  type ClientCache,
  type ClientCacheEntry,
} from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:http.snapshot.next-link]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const manifestUrl = 'https://manifest.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';

function fixture<Value>(name: string): Value {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Value;
}

function href(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function publicationManifest(snapshotEndpoint?: string): Record<string, any> {
  const manifest = fixture<Record<string, any>>('public-manifest.json');
  if (snapshotEndpoint !== undefined) {
    manifest.mounts[0].endpoints.snapshot = snapshotEndpoint;
  }
  return manifest;
}

function pagePair(): {
  readonly complete: Snapshot;
  readonly first: Snapshot;
  readonly second: Snapshot;
} {
  const complete = fixture<Snapshot>('collection-snapshot.json');
  const first = structuredClone(complete);
  const second = structuredClone(complete);
  first.nodes = complete.nodes.slice(0, 1);
  first.annotations = [];
  first.attachments = [];
  first.relations = [];
  first.tombstones = [];
  first.page = { sequence: 1, hasMore: true, nextCursor: 'c-2' };
  second.nodes = complete.nodes.slice(1);
  second.page = { sequence: 2, hasMore: false, nextCursor: null };
  return { complete, first, second };
}

function memoryCache(): { readonly cache: ClientCache; readonly entries: Map<string, ClientCacheEntry> } {
  const entries = new Map<string, ClientCacheEntry>();
  return {
    entries,
    cache: {
      get(key) { return entries.get(key); },
      set(key, value) { entries.set(key, value); },
      delete(key) { entries.delete(key); },
    },
  };
}

describe(`PUB-0034 opaque server-provided Snapshot continuation regression ${evidence}`, () => {
  it(`rejects unsafe transport schemes at the exported continuation parser boundary ${evidence}`, () => {
    const base = new URL('https://pages.example/one?limit=2');
    const unsafeTargets = [
      'ftp://pages.example/two?limit=2&pageCursor=c-2',
      'https://user:secret@pages.example/two?limit=2&pageCursor=c-2',
      'http://pages.example/two?limit=2&pageCursor=c-2',
    ];

    for (const target of unsafeTargets) {
      expect(() => publicationSnapshotNextUrl({
        currentUrl: base,
        initialUrl: base,
        linkHeader: `<${target}>; rel="next"`,
        hasMore: true,
        nextCursor: 'c-2',
        validators: createValidatorRegistry(),
      })).toThrow(TypeError);
    }
  });

  it(`follows the exact cross-Origin URL without guessing or reusing the first-page cache validator ${evidence}`, async () => {
    const initial = `https://archive.example/custom/${collectionId}.json?include=annotations&include=attachments&include=relations`;
    const next = 'https://edge.other.example:9443/opaque/batch%2Fseven.json?include=relations&include=annotations&include=attachments&pageCursor=c%2D2';
    const manifest = publicationManifest(
      'https://archive.example/custom/{collectionId}.json?include=annotations&include=attachments&include=relations',
    );
    const { complete, first, second } = pagePair();
    const { cache, entries } = memoryCache();
    const requests: Array<{ readonly url: string; readonly ifNoneMatch: string | null }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = href(input);
      if (url === manifestUrl) return Response.json(manifest);
      requests.push({ url, ifNoneMatch: new Headers(init?.headers).get('If-None-Match') });
      if (url === initial) {
        return Response.json(first, {
          headers: { ETag: '"first-page-only"', Link: `<${next}>; rel="next"` },
        });
      }
      if (url === next) return Response.json(second, { headers: { ETag: '"second-page-only"' } });
      throw new Error(`Client guessed a continuation request: ${url}`);
    });

    const result = await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      cache,
      cachePartition: 'principal-publication',
    }).getSnapshot(collectionId);

    expect(result.nodes).toHaveLength(complete.nodes.length);
    expect(requests).toEqual([
      { url: initial, ifNoneMatch: null },
      { url: next, ifNoneMatch: null },
    ]);
    expect(requests.map(({ url }) => url)).not.toContain(`${initial}&pageCursor=c%2D2`);
    expect([...entries.keys()].filter((key) => key.includes('archive.example'))).toHaveLength(1);
    expect([...entries.keys()].filter((key) => key.includes('edge.other.example'))).toHaveLength(1);
  });

  it(`does not invent a pageCursor continuation from body nextCursor alone ${evidence}`, async () => {
    const initial = `https://archive.example/opaque/${collectionId}.json?limit=3`;
    const manifest = publicationManifest('https://archive.example/opaque/{collectionId}.json?limit=3');
    const { first } = pagePair();
    first.page = { sequence: 1, hasMore: true, nextCursor: 'c-2' };
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(manifest);
      if (url === initial) return Response.json(first, { headers: { ETag: '"page-1"' } });
      throw new Error(`Client synthesized a cursor URL: ${url}`);
    });

    await expect(new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getSnapshot(collectionId)).rejects.toThrow(/exactly one rel=next/u);

    expect(requested).toEqual([manifestUrl, initial]);
    expect(requested).not.toContain(`${initial}&pageCursor=c-2`);
    expect(requested).not.toContain(`${initial}?pageCursor=c-2`);
    expect(requested.some((url) => url.includes('pageCursor='))).toBe(false);
  });

  it(`follows the sole server-provided rel=next target including a relative reference ${evidence}`, async () => {
    const initial = `https://pages.example/start/${collectionId}.json?limit=2&include=annotations&include=attachments&include=relations`;
    const relativeNext = '../opaque/batch%2Fseven.json?limit=2&include=annotations&include=attachments&include=relations&pageCursor=c%2D2';
    const absoluteNext = 'https://pages.example/opaque/batch%2Fseven.json?limit=2&include=annotations&include=attachments&include=relations&pageCursor=c%2D2';
    const manifest = publicationManifest(
      'https://pages.example/start/{collectionId}.json?limit=2&include=annotations&include=attachments&include=relations',
    );
    const { complete, first, second } = pagePair();
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(manifest);
      if (url === initial) {
        return Response.json(first, {
          headers: { ETag: '"page-1"', Link: `<${relativeNext}>; rel="next"` },
        });
      }
      if (url === absoluteNext) return Response.json(second, { headers: { ETag: '"page-2"' } });
      throw new Error(`Client did not follow the server Link: ${url}`);
    });

    const result = await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getSnapshot(collectionId);

    expect(result.nodes).toHaveLength(complete.nodes.length);
    expect(requested).toEqual([manifestUrl, initial, absoluteNext]);
    expect(requested).not.toContain(`${initial}&pageCursor=c%2D2`);
  });

  it(`strips static headers and browser credentials on a cross-Origin rel=next hop ${evidence}`, async () => {
    const initial = `https://alice.example/collections/c/${collectionId}/snapshot?include=annotations&include=attachments&include=relations`;
    const next = 'https://edge.other.example:9443/opaque/batch%2Fseven.json?include=relations&include=annotations&include=attachments&pageCursor=c%2D2';
    const manifest = publicationManifest();
    const { complete, first, second } = pagePair();
    const observed: Array<{
      readonly url: string;
      readonly headers: Headers;
      readonly credentials: RequestInit['credentials'];
    }> = [];
    const credentialProvider = vi.fn(async (url: URL) =>
      url.origin === 'https://alice.example' ? { 'X-Principal-Secret': 'private' } : undefined);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = href(input);
      if (url === manifestUrl) return Response.json(manifest);
      observed.push({
        url,
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
      });
      if (url === initial) {
        return Response.json(first, {
          headers: { ETag: '"page-1"', Link: `<${next}>; rel="next"` },
        });
      }
      if (url === next) return Response.json(second, { headers: { ETag: '"page-2"' } });
      throw new Error(`Client guessed a continuation request: ${url}`);
    });

    const result = await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      headers: {
        Authorization: 'Bearer static-secret',
        Cookie: 'session=fixed',
        'X-Static-Secret': 'private',
      },
      credentialProvider,
    }).getSnapshot(collectionId, {
      include: ['annotations', 'attachments', 'relations'],
    });

    expect(result.nodes).toHaveLength(complete.nodes.length);
    expect(observed.map(({ url }) => url)).toEqual([initial, next]);

    const firstPage = observed[0]!;
    expect(firstPage.credentials).toBe('same-origin');
    expect(firstPage.headers.get('authorization')).toBe('Bearer static-secret');
    expect(firstPage.headers.get('cookie')).toBe('session=fixed');
    expect(firstPage.headers.get('x-static-secret')).toBe('private');
    expect(firstPage.headers.get('x-principal-secret')).toBe('private');

    const continuation = observed[1]!;
    expect(continuation.credentials).toBe('omit');
    expect(continuation.headers.get('authorization')).toBeNull();
    expect(continuation.headers.get('cookie')).toBeNull();
    expect(continuation.headers.get('x-static-secret')).toBeNull();
    expect(continuation.headers.get('x-principal-secret')).toBeNull();
    expect(credentialProvider).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'https://edge.other.example:9443' }),
      expect.any(Object),
    );
  });

  it.each([
    ['missing Link', undefined, /exactly one rel=next/u],
    ['wrong relation only', '<https://edge.example/two?pageCursor=c-2>; rel="previous"', /exactly one rel=next/u],
    [
      'multiple rel=next targets',
      '<https://edge.example/a?pageCursor=c-2>; rel="next", <https://edge.example/b?pageCursor=c-2>; rel="next"',
      /exactly one rel=next/u,
    ],
    ['malformed Link target', '<https://edge.example/[broken?pageCursor=c-2>; rel="next"', /./u],
    ['fragment on rel=next', '<https://edge.example/two?pageCursor=c-2#private>; rel="next"', /fragment/u],
  ] as const)(
    `rejects a malformed or incomplete Link (%s) without issuing a continuation ${evidence}`,
    async (_name, link, message) => {
      const initial = `https://archive.example/opaque/${collectionId}.json?limit=4`;
      const manifest = publicationManifest('https://archive.example/opaque/{collectionId}.json?limit=4');
      const { first } = pagePair();
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = href(input);
        requested.push(url);
        if (url === manifestUrl) return Response.json(manifest);
        if (url === initial) {
          return Response.json(first, link === undefined
            ? { headers: { ETag: '"page-1"' } }
            : { headers: { ETag: '"page-1"', Link: link } });
        }
        throw new Error(`Client issued an unestablished continuation: ${url}`);
      });

      await expect(new ColpClient({
        manifestUrl,
        fetch: fetch as typeof globalThis.fetch,
      }).getSnapshot(collectionId)).rejects.toThrow(message);

      expect(requested).toEqual([manifestUrl, initial]);
      expect(requested.some((url) => url.includes('pageCursor='))).toBe(false);
    },
  );

  it.each([
    ['missing pageCursor', 'https://edge.example/two?limit=4', /pageCursor/u],
    ['duplicate pageCursor', 'https://edge.example/two?limit=4&pageCursor=c-2&pageCursor=c-2', /pageCursor/u],
    ['mismatched pageCursor', 'https://edge.example/two?limit=4&pageCursor=other-cursor', /does not match/u],
    [
      'encoded pageCursor that does not decode to body nextCursor',
      'https://edge.example/two?limit=4&pageCursor=c%252D2',
      /does not match/u,
    ],
  ] as const)(
    `fails closed on an erroneous Link pageCursor (%s) instead of assembling a partial Snapshot ${evidence}`,
    async (_name, next, message) => {
      const initial = `https://archive.example/opaque/${collectionId}.json?limit=4`;
      const manifest = publicationManifest('https://archive.example/opaque/{collectionId}.json?limit=4');
      const { first } = pagePair();
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = href(input);
        requested.push(url);
        if (url === manifestUrl) return Response.json(manifest);
        if (url === initial) {
          return Response.json(first, {
            headers: { ETag: '"page-1"', Link: `<${next}>; rel="next"` },
          });
        }
        throw new Error(`Client followed an invalid pageCursor Link: ${url}`);
      });

      await expect(new ColpClient({
        manifestUrl,
        fetch: fetch as typeof globalThis.fetch,
      }).getSnapshot(collectionId)).rejects.toThrow(message);

      expect(requested).toEqual([manifestUrl, initial]);
      expect(requested).not.toContain(next);
      expect(requested).not.toContain(`${initial}&pageCursor=c-2`);
    },
  );

  it(`does not treat body nextCursor as a license to rewrite an opaque Link path ${evidence}`, async () => {
    const initial = `https://archive.example/custom/${collectionId}.json?limit=2`;
    // Server-provided opaque target deliberately does not look like initial + pageCursor.
    // Only protocol snapshotQuery keys are allowed; path/host opacity carries the signed shape.
    const opaqueNext = 'https://edge.other.example/signed/token-batch.json?limit=2&pageCursor=c-2';
    const guessed = `${initial}&pageCursor=c-2`;
    const conventional = `https://alice.example/collections/c/${collectionId}/snapshot?limit=2&pageCursor=c-2`;
    const manifest = publicationManifest('https://archive.example/custom/{collectionId}.json?limit=2');
    const { complete, first, second } = pagePair();
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = href(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(manifest);
      if (url === initial) {
        return Response.json(first, {
          headers: { ETag: '"page-1"', Link: `<${opaqueNext}>; rel="next"` },
        });
      }
      if (url === opaqueNext) return Response.json(second, { headers: { ETag: '"page-2"' } });
      throw new Error(`Client rewrote the opaque next Link into ${url}`);
    });

    const result = await new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    }).getSnapshot(collectionId);

    expect(result.nodes).toHaveLength(complete.nodes.length);
    expect(requested).toEqual([manifestUrl, initial, opaqueNext]);
    expect(requested).not.toContain(guessed);
    expect(requested).not.toContain(conventional);
  });
});
