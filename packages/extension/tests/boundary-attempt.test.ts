import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAuthorityFence } from '../src/authority-fence.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { configurePersonalSyncTransport } from '../src/personal-sync-fetch.js';
import { captureBoundaryAttempt } from '../src/sw/boundary-attempt.js';
import { nativeChromeFacts } from '../src/sw/native-chrome.js';
import type { SyncScope } from '../src/sync-state-store.js';

vi.mock('../src/sw/runtime.js', () => ({ rootScopeKey: (value: unknown) => JSON.stringify(value) }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => current }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));
const scope: SyncScope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
let current = scope;
const stored: Record<string, unknown> = {};
const storage = { get: async () => structuredClone(stored), set: async (values: Record<string, unknown>) => { Object.assign(stored, values); } };
const policy = createPersonalSyncPolicyStore(storage);
configurePersonalSyncTransport(policy);
beforeEach(async () => {
  for (const key of Object.keys(stored)) delete stored[key];
  current = scope;
  vi.stubGlobal('chrome', { storage: { local: storage }, bookmarks: { get: vi.fn() } });
  await policy.write(scope, 'enabled');
});
afterEach(() => vi.unstubAllGlobals());

test('Pause → Resume before a later native port is created cannot revive the original attempt', async () => {
  const attempt = await captureBoundaryAttempt(scope);
  await policy.write(scope, 'paused'); await policy.write(scope, 'enabled');
  const mutate = vi.fn();
  const api = await attempt.nativeApi({ mutate });
  await expect(api.mutate()).rejects.toThrow('personal_sync_stopped');
  expect(mutate).not.toHaveBeenCalled();
  await expect(attempt.assertCurrent()).rejects.toThrow('personal_sync_stopped');
  const fresh = await captureBoundaryAttempt(scope);
  await (await fresh.nativeApi({ mutate })).mutate();
  expect(mutate).toHaveBeenCalledTimes(1);
});

test('account A → B → A invalidates old work even when the final scope again equals A', async () => {
  const attempt = await captureBoundaryAttempt(scope);
  const fence = createAuthorityFence(storage);
  await fence.revoke(); current = { ...scope, accountId: 'B' }; await fence.activate();
  await fence.revoke(); current = scope; await fence.activate();
  const mutate = vi.fn();
  await expect((await attempt.nativeApi({ mutate })).mutate()).rejects.toThrow('authority_fenced');
  expect(mutate).not.toHaveBeenCalled();
});

test('a different current replica cannot use an earlier attempt even without a fence notification', async () => {
  const attempt = await captureBoundaryAttempt(scope);
  current = { ...scope, replicaId: 'another-replica' };
  const create = vi.fn(async () => ({ id: 'must-not-create' }));
  await expect(attempt.assertCurrent()).rejects.toThrow('not_connected');
  await expect((await attempt.nativeApi({ create })).create()).rejects.toThrow('not_connected');
  expect(create).not.toHaveBeenCalled();
});

test('an API result remains available for durable evidence if authority changes during the native call', async () => {
  const attempt = await captureBoundaryAttempt(scope);
  const create = vi.fn(async () => { await policy.write(scope, 'paused'); return { id: 'created-once' }; });
  expect(await (await attempt.nativeApi({ create })).create()).toEqual({ id: 'created-once' });
  await expect(attempt.assertCurrent()).rejects.toThrow('personal_sync_stopped');
  expect(create).toHaveBeenCalledTimes(1);
});

test.each(['permission denied', 'bookmark service temporarily unavailable'])('native lookup propagates %s instead of reporting deletion', async message => {
  vi.mocked(chrome.bookmarks.get).mockRejectedValue(new Error(message));
  await expect(nativeChromeFacts().getNative('native')).rejects.toThrow(message);
});
test('only a classified missing bookmark is absence; an empty API response is unreadable evidence', async () => {
  vi.mocked(chrome.bookmarks.get).mockRejectedValueOnce(new Error("Can't find bookmark for id."));
  expect(await nativeChromeFacts().getNative('native')).toBeUndefined();
  vi.mocked(chrome.bookmarks.get).mockResolvedValueOnce([]);
  await expect(nativeChromeFacts().getNative('native')).rejects.toThrow('bookmark_lookup_empty');
});
