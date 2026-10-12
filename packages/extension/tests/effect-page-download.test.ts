import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';

import { canonicalAuthoritativeEffectPageDigest } from '@know-n/colp/sync/canonical';
import {
  downloadAuthoritativeEffectPages,
  EffectPageRateLimitedError,
} from '../src/effect-page-download.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = {
  environment: 'development', serverId: 'server-download', serverOrigin: 'https://known.example',
  accountId: 'account-download', browserProfileId: 'profile-download', collectionId: 'collection-download',
  replicaId: 'replica-download', generation: 1,
};

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('resumes a 20-page effect after 429 on pages 1, 10, 11 and 20', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-download', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['root'], rootStatus: 'ready',
  });
  const pages = buildPages(20);
  const hits: number[] = [];
  const limited = new Set([1, 10, 11, 20]);
  let clock = 1_000;
  const fetchImpl: typeof fetch = async function (this: unknown, input) {
    assert.equal(this, undefined, 'the browser fetch implementation must be called without a receiver');
    const pageNumber = Number(String(input).split('/').at(-1));
    hits.push(pageNumber);
    if (limited.has(pageNumber)) {
      limited.delete(pageNumber);
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } });
    }
    return new Response(JSON.stringify(pages[pageNumber - 1]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  async function attempt() {
    return downloadAuthoritativeEffectPages({
      scope, store, refs: [{ effectId: 'effect-20', pageCount: 20, memberCount: 20 }],
      template: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
      authority: 'https://known.example', headers: { 'Known-Sync-Session': 'session-download' },
      remainingBytes: 2 * 1024 * 1024, fetch: fetchImpl, now: () => clock,
    });
  }

  for (const expectedPage of [1, 10, 11, 20]) {
    await assert.rejects(attempt(), (error: unknown) => {
      assert.ok(error instanceof EffectPageRateLimitedError);
      assert.equal(error.retryAfterMilliseconds, 2_000);
      return true;
    });
    const download = await store.getEffectDownload(scope, 'effect-20');
    assert.equal(download?.nextPageNumber, expectedPage);
    clock += 2_000;
  }

  const downloaded = await attempt();
  assert.equal(downloaded.length, 20);
  assert.equal(hits.filter((page) => page === 1).length, 2);
  assert.equal(hits.filter((page) => page === 10).length, 2);
  assert.equal(hits.filter((page) => page === 20).length, 2);
  assert.equal(await store.getEffectDownload(scope, 'effect-20'), null);
});

for (const phase of ['headers', 'body'] as const) {
  test(`a stalled effect ${phase} releases the download and preserves the last completed page`, async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', selectedRoots: [],
      checkpoint: { serverRevision: 'r1', cursor: 'c0' },
      lease: { leaseId: 'lease-download', expiresAt: Date.parse('2099-01-01T00:00:00Z') } });
    const pages = buildPages(2); let stalled = true; const hits: number[] = [];
    const attempt = () => downloadAuthoritativeEffectPages({
      scope, store, refs: [{ effectId: 'effect-20', pageCount: 2, memberCount: 2 }],
      template: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
      authority: 'https://known.example', headers: {}, remainingBytes: 1024 * 1024,
      now: Date.now, requestTimeoutMilliseconds: 25,
      fetch: async (url, init) => {
        const page = Number(String(url).split('/').at(-1)); hits.push(page);
        if (stalled && page === 2) {
          if (phase === 'headers') return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          });
          return new Response(new ReadableStream<Uint8Array>(), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return Response.json(pages[page - 1]);
      },
    });
    try {
      await assert.rejects(attempt(), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
      assert.equal((await store.getEffectDownload(scope, 'effect-20'))?.nextPageNumber, 2);
      stalled = false;
      assert.equal((await attempt()).length, 2);
      assert.deepEqual(hits, [1, 2, 2]);
    } finally { await store.close(); }
  }, 1_000);
}

test('honors a persisted cooldown and an HTTP-date Retry-After without restarting the page', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-date', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['root'], rootStatus: 'ready',
  });
  const page = buildPages(1)[0]!;
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  let calls = 0;
  const input = () => ({
    scope, store, refs: [{ effectId: 'effect-20', pageCount: 1, memberCount: 1 }],
    template: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    authority: 'https://known.example', headers: {}, remainingBytes: 64 * 1024,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 429,
        headers: { 'Retry-After': new Date(clock + 4_000).toUTCString() } });
      return Response.json(page);
    },
    now: () => clock,
  });

  await assert.rejects(downloadAuthoritativeEffectPages(input()), (error: unknown) =>
    error instanceof EffectPageRateLimitedError && error.retryAfterMilliseconds === 4_000);
  await assert.rejects(downloadAuthoritativeEffectPages(input()), (error: unknown) =>
    error instanceof EffectPageRateLimitedError && error.retryAfterMilliseconds === 4_000);
  assert.equal(calls, 1);
  clock += 4_000;
  assert.equal((await downloadAuthoritativeEffectPages(input())).length, 1);
  assert.equal(calls, 2);
});

test('rejects a page whose digest does not match the canonical members', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-digest', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['root'], rootStatus: 'ready',
  });
  const page = buildPages(1)[0]!;
  await assert.rejects(downloadAuthoritativeEffectPages({
    scope, store, refs: [{ effectId: 'effect-20', pageCount: 1, memberCount: 1 }],
    template: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
    authority: 'https://known.example', headers: {}, remainingBytes: 64 * 1024,
    fetch: async () => Response.json({ ...page, pageDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:' }),
    now: () => 1_000,
  }), /effect_page_invalid/);
});

function buildPages(count: number) {
  const pages: Record<string, unknown>[] = [];
  let previous: string | null = null;
  for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
    const raw: Record<string, unknown> = {
      effectId: 'effect-20', pageNumber, pageCount: count,
      members: [`node-${pageNumber}`], memberCount: 1, pageDigest: '', previousPageDigest: previous,
    };
    const page = { ...raw, pageDigest: canonicalAuthoritativeEffectPageDigest(raw) };
    pages.push(page);
    previous = page.pageDigest;
  }
  return pages;
}
