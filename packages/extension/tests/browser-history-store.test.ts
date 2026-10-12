import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_HISTORY_DATABASE, BROWSER_HISTORY_RETENTION_MS, createBrowserHistoryStore } from '../src/capture/browser-history-store.js';
import { browserHistoryFact, browserHistoryItem } from '../src/capture/browser-history-fact.js';
import type { CaptureScope, CaptureTask } from '../src/capture/contracts.js';

const scope: CaptureScope = { serverOrigin: 'https://known.example', accountId: 'a', collectionId: 'collection', authorityGeneration: 1 };
const guest: CaptureScope = { ...scope, accountId: null, collectionId: null, authorityGeneration: 2 };
let factory: IDBFactory, clock: number;
const stores: ReturnType<typeof createBrowserHistoryStore>[] = [];
function open() {
  const store = createBrowserHistoryStore({ indexedDB: factory, now: () => clock });
  stores.push(store); return store;
}
function saved(id: string, createdAt = 100): CaptureTask {
  const fact = browserHistoryFact({ captureId: id, targetNativeId: 'parent', title: id,
    url: `https://example.org/${id}`, source: 'manual-popup', automaticIntent: false, createdAt }, `native-${id}`, createdAt + 1);
  const { historyReadOnly: _readOnly, historyOrigin: _origin, ...task } = browserHistoryItem(fact, scope);
  return { ...task, scope };
}
async function storedFacts() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(BROWSER_HISTORY_DATABASE, 2);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('activity', 'readonly'), request = tx.objectStore('activity').getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
beforeEach(() => { factory = new IDBFactory(); clock = 10_000; });
it('explicit clearing survives restart and lazy migration cannot resurrect cleared saves', async () => {
  const store = open(), old = saved('old');
  await store.rememberMany([old]); await store.clear();
  await store.rememberMany([old]);
  expect(await store.listForOwner(guest)).toEqual([]);
  store.close(); clock += 10;
  const restarted = open(); await restarted.rememberMany([old]);
  expect(await restarted.listForOwner(guest)).toEqual([]);
  await restarted.rememberMany([saved('new', clock)]);
  expect((await restarted.listForOwner(guest)).map(task => task.captureId)).toEqual(['new']);
});
it('legacy saves without savedAt stay cleared when status timestamps change, including after restart', async () => {
  const store = open();
  const { savedAt: _savedAt, ...legacy } = saved('legacy');
  await store.rememberMany([{ ...legacy, updatedAt: 200 }]);
  await store.clear(); store.close(); clock += 100;
  const restarted = open();
  await restarted.rememberMany([{ ...legacy, updatedAt: clock }]);
  expect(await restarted.listForOwner(guest)).toEqual([]);
  // A real new native save may finish after clear even if its task began earlier.
  await restarted.remember({ ...legacy, captureId: 'new-save' }, 'new-native');
  expect((await restarted.listForOwner(guest)).map(task => task.captureId)).toEqual(['new-save']);
});
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('durable browser activity', () => {
  it('survives reopening and remains read-only after logout and account switching', async () => {
    const first = open(), task = saved('one');
    await first.remember(task, task.nativeId!); first.close();
    const next = open();
    for (const account of [guest, { ...scope, accountId: 'b', collectionId: 'other' }]) {
      expect(await next.listForOwner(account)).toMatchObject([{ captureId: 'one', historyReadOnly: true,
        historyOrigin: 'device', scope: { accountId: null, collectionId: null }, decisionId: null, nodeId: null }]);
    }
  });
  it('persists only device facts and never replaces the original receipt on retry', async () => {
    const store = open(), task = saved('one');
    await store.remember({ ...task, annotation: { tags: ['private'], note: 'private' } } as CaptureTask, task.nativeId!);
    await store.remember({ ...task, title: 'late retry', savedAt: 999 }, 'different-id');
    const rows = await storedFacts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nativeId: 'native-one', title: 'one', savedAt: 101 });
    expect(JSON.stringify(rows)).not.toContain('private');
    expect(rows[0]).not.toHaveProperty('scope');
    expect(rows[0]).not.toHaveProperty('commandId');
  });
  it('uses stable compound pagination with no missing or repeated records', async () => {
    const store = open();
    const tasks = Array.from({ length: 121 }, (_, index) => saved(String(index).padStart(3, '0'), 100 + Math.floor(index / 3)));
    await store.rememberMany(tasks);
    const seen: string[] = []; let before: readonly [number, string] | undefined;
    for (;;) {
      const page = await store.listForOwner(guest, before);
      expect(page.length).toBeLessThanOrEqual(50);
      seen.push(...page.map(row => row.captureId));
      const last = page.at(-1); if (!last || page.length < 50) break;
      before = [last.createdAt, last.captureId];
    }
    expect(seen).toEqual(tasks.map(task => task.captureId).reverse());
    expect(new Set(seen).size).toBe(121);
  });
  it('prunes expired records on a read even when no new bookmark was saved', async () => {
    const store = open(); await store.rememberMany([saved('old')]);
    clock = BROWSER_HISTORY_RETENTION_MS + 10_000;
    expect(await store.listForOwner(guest)).toEqual([]);
    expect(await storedFacts()).toEqual([]);
    await store.rememberMany([saved('old')]);
    expect(await storedFacts()).toEqual([]);
  });
  it('isolates corrupt legacy rows and ignores cloud-only, imported and failed history', async () => {
    const store = open(), valid = saved('valid');
    await store.rememberMany([
      { ...saved('corrupt'), source: 'unknown' as never }, valid,
      { ...valid, title: 'duplicate must not win' },
      { ...saved('cloud'), nativeId: null }, { ...saved('failed'), save: 'failed' },
      { ...saved('imported'), historyReadOnly: true } as CaptureTask,
    ]);
    expect(await storedFacts()).toHaveLength(1);
    expect(await store.listForOwner(guest)).toMatchObject([{ captureId: 'valid', title: 'valid' }]);
  });
  it('validates page sizes, cursors and migration batch limits before opening storage', async () => {
    const store = open();
    for (const limit of [0, -1, 101, 1.5]) await expect(store.listForOwner(guest, undefined, limit)).rejects.toThrow('browser_history_invalid');
    for (const cursor of [[-1, 'x'], [NaN, 'x'], [10, '']] as const) {
      await expect(store.listForOwner(guest, cursor)).rejects.toThrow('browser_history_invalid');
    }
    await expect(store.rememberMany(Array.from({ length: 201 }, () => saved('too-many')))).rejects.toThrow('browser_history_invalid');
    clock = BROWSER_HISTORY_RETENTION_MS + 10_000;
    expect(await store.listForOwner(guest, [1, 'expired'])).toEqual([]);
  });
});
