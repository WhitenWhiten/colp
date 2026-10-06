import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ColpClient,
  ColpProblemError,
  type ClientCache,
  type ClientCacheEntry,
} from '../../src/client/index.js';

const evidence = 'http.snapshot.cursor-scope';
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixturesRoot, name), 'utf8');
}

function urlOf(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function protocolJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('etag')) headers.set('ETag', '"pub-0004"');
  return Response.json(value, { ...init, headers });
}

async function paginatedFixture(): Promise<{
  manifest: string;
  complete: Record<string, any>;
  first: Record<string, any>;
  second: Record<string, any>;
}> {
  const manifest = await fixture('public-manifest.json');
  const complete = JSON.parse(await fixture('collection-snapshot.json')) as Record<string, any>;
  const first = structuredClone(complete);
  const second = structuredClone(complete);
  first.nodes = complete.nodes.slice(0, 1);
  first.annotations = [];
  first.page = { nextCursor: 'cursor-page-2', hasMore: true, sequence: 1 };
  second.nodes = complete.nodes.slice(1);
  second.page = { nextCursor: null, hasMore: false, sequence: 2 };
  return { manifest, complete, first, second };
}

function clientForLink(
  manifest: string,
  first: Record<string, any>,
  second: Record<string, any>,
  link: string | undefined,
  requested: string[] = [],
): ColpClient {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = urlOf(input);
    requested.push(url.href);
    if (url.href === manifestUrl) return Response.json(JSON.parse(manifest));
    return url.searchParams.has('pageCursor')
      ? protocolJson(second)
      : protocolJson(first, link === undefined ? {} : { headers: { Link: link } });
  });
  return new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });
}

describe(`PUB-0004 Snapshot cursor scope client [evidence:${evidence}]`, () => {
  it(`follows an opaque cross-Origin Link with the same query, page size, and reordered include set [evidence:${evidence}]`, async () => {
    const { manifest, complete, first, second } = await paginatedFixture();
    first.complete = false;
    second.complete = false;
    const requested: string[] = [];
    const next = 'https://pages.example/opaque/batch-7?include=relations&include=annotations&include=attachments&depth=2&root=node-root&limit=17&pageCursor=cursor-page-2';
    const client = clientForLink(
      manifest,
      first,
      second,
      `<${next}>; rel="next"`,
      requested,
    );

    const snapshot = await client.getSnapshot(collectionId, {
      include: ['annotations', 'attachments', 'relations'],
      depth: 2,
      root: 'node-root',
      limit: 17,
    });

    expect(snapshot.nodes).toHaveLength(complete.nodes.length);
    expect(requested).toEqual([
      manifestUrl,
      `https://alice.example/collections/c/${collectionId}/snapshot?limit=17&include=annotations&include=attachments&include=relations&depth=2&root=node-root`,
      next,
    ]);
    expect(requested[2]).not.toContain(`/collections/c/${collectionId}/snapshot`);
  });

  it.each([
    ['missing pageCursor', 'https://pages.example/page?limit=11', /pageCursor/u],
    ['duplicate pageCursor', 'https://pages.example/page?limit=11&pageCursor=cursor-page-2&pageCursor=cursor-page-2', /pageCursor/u],
    ['mismatched pageCursor', 'https://pages.example/page?limit=11&pageCursor=other-cursor', /does not match/u],
  ])(`rejects a rel=next Link with %s [evidence:${evidence}]`, async (_name, next, message) => {
    const { manifest, first, second } = await paginatedFixture();
    const client = clientForLink(manifest, first, second, `<${next}>; rel="next"`);
    await expect(client.getSnapshot(collectionId, { limit: 11 })).rejects.toThrow(message);
  });

  it.each([
    ['root', { root: 'node-a', depth: 2, limit: 11 }, 'root=node-b&depth=2&limit=11'],
    ['depth', { root: 'node-a', depth: 2, limit: 11 }, 'root=node-a&depth=3&limit=11'],
    ['limit/page size', { root: 'node-a', depth: 2, limit: 11 }, 'root=node-a&depth=2&limit=12'],
    ['removed limit/page size', { root: 'node-a', depth: 2, limit: 11 }, 'root=node-a&depth=2'],
    ['introduced root', { depth: 2, limit: 11 }, 'root=node-a&depth=2&limit=11'],
  ])(`rejects a rel=next Link that changes %s [evidence:${evidence}]`, async (_name, query, nextQuery) => {
    const { manifest, first, second } = await paginatedFixture();
    first.complete = false;
    second.complete = false;
    const link = `<https://pages.example/page?${nextQuery}&pageCursor=cursor-page-2>; rel="next"`;
    const client = clientForLink(manifest, first, second, link);
    await expect(client.getSnapshot(collectionId, query)).rejects.toThrow(/query context/u);
  });

  it.each([
    ['a changed include set', 'include=annotations&include=relations'],
    ['a duplicated include member', 'include=annotations&include=attachments&include=relations&include=relations'],
  ])(`rejects %s in the rel=next scope [evidence:${evidence}]`, async (_name, includeQuery) => {
    const { manifest, first, second } = await paginatedFixture();
    const link = `<https://pages.example/page?${includeQuery}&limit=7&pageCursor=cursor-page-2>; rel="next"`;
    const client = clientForLink(manifest, first, second, link);
    await expect(client.getSnapshot(collectionId, {
      include: ['annotations', 'attachments', 'relations'],
      limit: 7,
    })).rejects.toThrow(/query|include/u);
  });

  it(`rejects an unknown rel=next query parameter [evidence:${evidence}]`, async () => {
    const { manifest, first, second } = await paginatedFixture();
    const link = '<https://pages.example/page?limit=7&pageCursor=cursor-page-2&future=true>; rel="next"';
    const client = clientForLink(manifest, first, second, link);
    await expect(client.getSnapshot(collectionId, { limit: 7 })).rejects.toThrow(/query is invalid/u);
  });

  it.each([
    ['root', { root: 'node-a' }, 'root=node-a&root=node-a'],
    ['depth', { depth: 2 }, 'depth=2&depth=2'],
    ['limit', { limit: 7 }, 'limit=7&limit=7'],
  ])(`rejects a repeated %s scalar in rel=next [evidence:${evidence}]`, async (_name, query, nextQuery) => {
    const { manifest, first, second } = await paginatedFixture();
    if (_name !== 'limit') {
      first.complete = false;
      second.complete = false;
    }
    const link = `<https://pages.example/page?${nextQuery}&pageCursor=cursor-page-2>; rel="next"`;
    const client = clientForLink(manifest, first, second, link);
    await expect(client.getSnapshot(collectionId, query)).rejects.toThrow(/query is invalid/u);
  });

  it(`discards assembled pages when a later page returns valid snapshot_expired Problem Details [evidence:${evidence}]`, async () => {
    const { manifest, first } = await paginatedFixture();
    const problem = {
      type: 'https://collectionprotocol.org/problems/snapshot-expired',
      title: 'Snapshot revision expired',
      status: 409,
      code: 'snapshot_expired',
      retryable: true,
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.href === manifestUrl) return Response.json(JSON.parse(manifest));
      if (url.searchParams.has('pageCursor')) {
        return new Response(JSON.stringify(problem), {
          status: 409,
          headers: { 'Content-Type': 'application/problem+json' },
        });
      }
      return protocolJson(first, {
        headers: { Link: '<https://pages.example/page?pageCursor=cursor-page-2>; rel="next"' },
      });
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

    const result = client.getSnapshot(collectionId);
    await expect(result).rejects.toBeInstanceOf(ColpProblemError);
    await expect(result).rejects.toMatchObject({
      problem: expect.objectContaining({ status: 409, code: 'snapshot_expired', retryable: true }),
    });
  });

  it(`partitions cached page URLs by principal and never reuses another cursor URL [evidence:${evidence}]`, async () => {
    const { manifest, first, second } = await paginatedFixture();
    const cacheKeys: string[] = [];
    const values = new Map<string, ClientCacheEntry>();
    const cache: ClientCache = {
      get(key) { return values.get(key); },
      set(key, value) { cacheKeys.push(key); values.set(key, value); },
      delete(key) { values.delete(key); },
    };
    const createClient = (principal: string, cursor: string): ColpClient => {
      const pageOne = structuredClone(first);
      pageOne.page.nextCursor = cursor;
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (url.href === manifestUrl) return Response.json(JSON.parse(manifest));
        return url.searchParams.has('pageCursor')
          ? protocolJson(second)
          : protocolJson(pageOne, {
              headers: { Link: `<https://pages.example/page?pageCursor=${cursor}>; rel="next"` },
            });
      });
      return new ColpClient({
        manifestUrl,
        fetch: fetch as typeof globalThis.fetch,
        cache,
        cachePartition: principal,
      });
    };

    const sharedCursor = 'cursor-shared';
    await createClient('principal-alice', sharedCursor).getSnapshot(collectionId);
    await createClient('principal-bob', sharedCursor).getSnapshot(collectionId);

    const pageKeys = cacheKeys.filter((key) => key.includes('pages.example'));
    expect(pageKeys).toHaveLength(2);
    expect(pageKeys[0]).not.toBe(pageKeys[1]);
    expect(pageKeys.every((key) => key.includes(`pageCursor=${sharedCursor}`))).toBe(true);
    expect(pageKeys.every((key) => !key.includes('principal-alice') && !key.includes('principal-bob'))).toBe(true);
  });

  it.each([
    ['one supplied cursor', '?pageCursor=template-cursor'],
    ['a duplicate cursor', '?pageCursor=template-cursor&pageCursor=template-cursor-2'],
  ])(`rejects an initial Snapshot URL containing %s [evidence:${evidence}]`, async (_name, suffix) => {
    const manifest = JSON.parse(await fixture('public-manifest.json')) as Record<string, any>;
    manifest.mounts[0].endpoints.snapshot += suffix;
    const fetch = vi.fn(async () => Response.json(manifest));
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });
    await expect(client.getSnapshot(collectionId)).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof Error)) return false;
      if (error.message.includes('must start without pageCursor')) return true;
      if (error.message !== 'invalid_query: Publication query is invalid.') return false;
      const issues = (error as { issues?: readonly string[] }).issues;
      return Array.isArray(issues) && issues.some((issue) => /pageCursor|must appear once/iu.test(issue));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
