import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import canonicalize from 'canonicalize';
import { describe, expect, it, vi } from 'vitest';

import { ColpClient, type ClientCache } from '../../src/client/index.js';
import type { Snapshot, SnapshotQuery } from '../../src/types/index.js';

const evidence = 'core.snapshot-metadata';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as unknown;
}

async function clientFor(...snapshots: Snapshot[]): Promise<ColpClient> {
  const manifest = await fixture('public-manifest.json');
  let page = 0;
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/.well-known/collection-protocol') return Response.json(manifest);
    const snapshot = snapshots[page++] as Snapshot;
    const nextUrl = new URL('https://alice.example/page');
    url.searchParams.forEach((value, name) => {
      if (name !== 'pageCursor') nextUrl.searchParams.append(name, value);
    });
    if (snapshot.page.nextCursor !== null) {
      nextUrl.searchParams.set('pageCursor', snapshot.page.nextCursor);
    }
    const headers = new Headers({ ETag: `"snapshot-page-${page}"` });
    if (snapshot.page.hasMore) headers.set('Link', `<${nextUrl.href}>; rel="next"`);
    return Response.json(snapshot, { headers });
  });
  return new ColpClient({
    manifestUrl: 'https://alice.example/.well-known/collection-protocol',
    fetch: fetch as typeof globalThis.fetch,
  });
}

describe(`publication client Snapshot completeness [evidence:${evidence}]`, () => {
  it.each([
    ['root selection', { root: '019b3ca2-9a3f-7e07-8f18-cc4f2cb4bca8' }],
    ['depth selection', { depth: 1 }],
    ['partial include', { include: ['annotations'] }],
  ] satisfies Array<[string, SnapshotQuery]>)('expects complete=false for %s', async (_label, query) => {
    const snapshot = await fixture('collection-snapshot.json') as Snapshot;
    snapshot.complete = false;
    await expect((await clientFor(snapshot)).getSnapshot(collectionId, query)).resolves.toMatchObject({
      complete: false,
      page: { hasMore: false },
    });
  });

  it.each([
    ['an unfiltered query', {}],
    ['all authoritative arrays', { include: ['annotations', 'attachments', 'relations'] }],
    ['all authoritative arrays in a different order', { include: ['relations', 'annotations', 'attachments'] }],
    ['a page-size limit', { limit: 25 }],
    ['a page-size limit and all authoritative arrays', { limit: 25, include: ['attachments', 'relations', 'annotations'] }],
  ] satisfies Array<[string, SnapshotQuery]>)('expects complete=true for %s', async (_label, query) => {
    const snapshot = await fixture('collection-snapshot.json') as Snapshot;
    await expect((await clientFor(snapshot)).getSnapshot(collectionId, query)).resolves.toMatchObject({
      complete: true,
    });
  });

  it.each([
    ['cropped query marked complete', { depth: 1 }, true],
    ['authoritative query marked cropped', {}, false],
    ['limit-only query marked cropped', { limit: 25 }, false],
    ['full include set marked cropped', { include: ['relations', 'attachments', 'annotations'] }, false],
  ] satisfies Array<[string, SnapshotQuery, boolean]>)(
    'rejects %s',
    async (_label, query, complete) => {
      const snapshot = await fixture('collection-snapshot.json') as Snapshot;
      snapshot.complete = complete;
      await expect((await clientFor(snapshot)).getSnapshot(collectionId, query)).rejects.toThrow(
        `Snapshot complete=${complete} does not match the requested logical query scope`,
      );
    },
  );

  it('does not turn a cropped final page into a complete Snapshot', async () => {
    const source = await fixture('collection-snapshot.json') as Snapshot;
    const first = structuredClone(source);
    const second = structuredClone(source);
    first.complete = false;
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.complete = false;
    second.nodes = source.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    const result = await (await clientFor(first, second)).getSnapshot(collectionId, { depth: 1 });
    expect(result.complete).toBe(false);
    expect(result.page).toEqual({ nextCursor: null, hasMore: false, sequence: 1 });
  });

  it('keeps complete=true while assembling continuation pages selected only by limit and pageCursor', async () => {
    const source = await fixture('collection-snapshot.json') as Snapshot;
    const first = structuredClone(source);
    const second = structuredClone(source);
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.attachments = [];
    first.relations = [];
    first.tombstones = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = source.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    const result = await (await clientFor(first, second)).getSnapshot(collectionId, { limit: 1 });
    expect(result.complete).toBe(true);
    expect(result.nodes.map((node) => node.id)).toEqual(source.nodes.map((node) => node.id));
    expect(result.page).toEqual({ nextCursor: null, hasMore: false, sequence: 1 });
  });

  it('rejects a complete-scope continuation page that changes complete=false', async () => {
    const source = await fixture('collection-snapshot.json') as Snapshot;
    const first = structuredClone(source);
    const second = structuredClone(source);
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.attachments = [];
    first.relations = [];
    first.tombstones = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = source.nodes.slice(1);
    second.complete = false;
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    await expect((await clientFor(first, second)).getSnapshot(collectionId, { limit: 1 }))
      .rejects.toThrow(/complete|page sequence/iu);
  });

  it.each([
    ['protocolVersion', '0.2'],
    ['snapshotId', 'changed-snapshot'],
    ['revision', 'changed-revision'],
    ['mode', 'sync'],
    ['complete', false],
    ['generatedAt', '2026-07-16T06:31:00Z'],
  ] as const)('rejects a page sequence that changes %s before returning assembled state', async (field, value) => {
    const source = await fixture('collection-snapshot.json') as Snapshot;
    const first = structuredClone(source);
    const second = structuredClone(source) as unknown as Record<string, unknown>;
    first.nodes = source.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = source.nodes.slice(1);
    second[field] = value;
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    await expect((await clientFor(first, second as unknown as Snapshot)).getSnapshot(collectionId))
      .rejects.toThrow();
  });

  it('verifies the body digest over canonical logical content excluding the digest field itself', async () => {
    const snapshot = await fixture('collection-snapshot.json') as Snapshot;
    const canonical = canonicalize(snapshot);
    if (canonical === undefined) throw new Error('Fixture is not canonicalizable.');
    snapshot.contentDigest = `sha-256=:${createHash('sha256').update(canonical).digest('base64')}:`;

    await expect((await clientFor(snapshot)).getSnapshot(collectionId)).resolves.toMatchObject({
      contentDigest: snapshot.contentDigest,
    });

    snapshot.contentDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    await expect((await clientFor(snapshot)).getSnapshot(collectionId)).rejects.toThrow(
      'contentDigest does not match',
    );
  });

  it('does not cache a Snapshot whose logical body digest is wrong', async () => {
    const manifest = await fixture('public-manifest.json');
    const snapshot = await fixture('collection-snapshot.json') as Snapshot;
    snapshot.contentDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    const cache: ClientCache = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? Response.json(manifest)
        : Response.json(snapshot, { headers: { ETag: '"bad-snapshot"' } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
      cache,
    });

    await expect(client.getSnapshot(collectionId)).rejects.toThrow('contentDigest does not match');
    expect(cache.set).not.toHaveBeenCalled();
  });
});
