import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import type { MappingInput } from '../src/sync-state-store.js';
import { snapshotNativeFixture } from './snapshot-native-authority-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

async function nativeApi(f: Awaited<ReturnType<typeof snapshotNativeFixture>>) {
  vi.stubGlobal('chrome', { bookmarks: f.chrome.api });
  const effects = await f.effects(); await effects.assertCurrent();
  const production = createChromePullBookmarkApi();
  // Compose the same authority -> production wrapper -> Chrome path as the
  // worker. Keep the real subscription guard and its real IndexedDB queries.
  return { ...effects.api,
    create: (input: Parameters<typeof production.create>[0]) => effects.run(() => production.create(input)),
    remove: (id: string) => effects.run(() => production.remove(id)),
  };
}

function duringSubscriptionRead(change: () => Promise<void>) {
  const pendingOperations = subscriptionStore.pendingOperations.bind(subscriptionStore);
  let changed = false;
  vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
    const rows = await pendingOperations();
    if (!changed) { changed = true; await change(); }
    return rows;
  });
  return () => changed;
}

test.each(['active', 'private'] as const)('Snapshot deletion keeps final native authority through the production wrapper (%s)', async boundary => {
  const f = await snapshotNativeFixture();
  try {
    const api = await nativeApi(f);
    const staged = [f.root, f.privateRoot]; await f.stage(staged);
    const removed: string[] = [];
    const rawRemove = f.chrome.api.remove;
    vi.spyOn(f.chrome.api, 'remove').mockImplementation(async id => { removed.push(id); await rawRemove(id); });
    const changed = duringSubscriptionRead(async () => {
      if (boundary === 'private') await f.chrome.api.move('2', { parentId: '3', index: 0 });
    });
    await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api, freezeUnprovenIdentity: true }).catch(() => undefined);
    expect(changed()).toBe(true);
    if (boundary === 'active') {
      expect(removed).toEqual(['2']); expect(f.chrome.nodes.has('2')).toBe(false);
      expect(await f.store.getMappingByColpId(f.scope, 'target')).toBeNull();
    } else {
      expect({ removed, present: f.chrome.nodes.has('2') }).toEqual({ removed: [], present: true });
      expect(f.chrome.nodes.get('2')?.parentId).toBe('3');
      expect(await f.store.getMappingByColpId(f.scope, 'target')).toMatchObject(f.target);
      expect((await f.store.listProjectionIntents(f.scope))[0]?.state).not.toBe('terminal');
    }
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});

test.each(['active', 'private'] as const)('Snapshot creation keeps final parent authority through the production wrapper (%s)', async boundary => {
  const f = await snapshotNativeFixture();
  try {
    const api = await nativeApi(f);
    const parent: MappingInput = { ...f.privateRoot, nativeId: '4', colpId: 'parent',
      projection: { revision: 'parent-r1', digest: 'parent-digest', childrenRevision: 'parent-c1', content: { title: 'Parent' } } };
    const fresh: MappingInput = { ...f.target, nativeId: 'recovery:fresh', colpId: 'fresh',
      parentNativeId: '4', parentColpId: 'parent',
      projection: { revision: 'fresh-r1', digest: 'fresh-digest', content: { title: 'Fresh', url: 'https://fresh.test/' } } };
    await f.store.putMapping(f.scope, parent);
    const staged = [f.root, f.privateRoot, f.target, parent, fresh]; await f.stage(staged);
    const changed = duringSubscriptionRead(async () => {
      if (boundary === 'private') await f.chrome.api.move('4', { parentId: '3', index: 0 });
    });
    await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api, freezeUnprovenIdentity: true }).catch(() => undefined);
    expect(changed()).toBe(true);
    const children = [...f.chrome.nodes.values()].filter(row => row.url === 'https://fresh.test/');
    if (boundary === 'active') {
      expect(f.chrome.creates).toBe(1); expect(children).toHaveLength(1);
      expect(children[0]?.parentId).toBe('4');
    } else {
      expect(f.chrome.nodes.get('4')?.parentId).toBe('3');
      expect({ creates: f.chrome.creates, children }).toEqual({ creates: 0, children: [] });
      expect((await f.store.listProjectionIntents(f.scope)).find(row => row.colpId === 'fresh')?.state).not.toBe('terminal');
    }
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});
