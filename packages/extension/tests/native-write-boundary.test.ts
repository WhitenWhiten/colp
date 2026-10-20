import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import type { NativeWriteCheck } from '../src/native-call-result.js';

const identity = { serverOrigin: 'https://known.test', accountId: 'native-boundary', collectionId: 'bookmarks' };
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture() {
  const { nativeChromeFacts } = await import('../src/sw/native-chrome.js');
  const { subscriptionStore } = await import('../src/bookmark-subscriptions/store.js');
  const { NativeWriteNotStartedError } = await import('../src/native-call-result.js');
  const transport = await import('../src/personal-sync-fetch.js');
  const log: string[] = [];
  const raw = vi.fn(async () => { log.push('chrome'); return { id: 'created' }; });
  vi.stubGlobal('chrome', { bookmarks: { create: raw, update: raw, move: raw, remove: raw, removeTree: raw,
    get: async (id: string) => [{ id, title: 'Folder', ...(id === '0' ? {} : id === '1'
      ? { parentId: '0', folderType: 'bookmarks-bar' } : { parentId: '1' }) }],
    getChildren: async () => [], getSubTree: async (id: string) => [{ id, title: 'Empty folder' }],
  } });
  const read = subscriptionStore.pendingOperations;
  const observed = vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
    const result = await read(); log.push('subscription'); return result;
  });
  return { ...transport, native: nativeChromeFacts(), raw, log, observed, read, NativeWriteNotStartedError };
}

const mutations = {
  create: (api: Awaited<ReturnType<typeof fixture>>['native'], check: NativeWriteCheck) => api.createNative({ parentId: '1', title: 'Created' }, check),
  update: (api: Awaited<ReturnType<typeof fixture>>['native'], check: NativeWriteCheck) => api.updateNative('4', { title: 'Updated' }, check),
  move: (api: Awaited<ReturnType<typeof fixture>>['native'], check: NativeWriteCheck) => api.moveNative('4', { parentId: '1', index: 0 }, check),
  remove: (api: Awaited<ReturnType<typeof fixture>>['native'], check: NativeWriteCheck) => api.removeNative('4', false, check),
  removeTree: (api: Awaited<ReturnType<typeof fixture>>['native'], check: NativeWriteCheck) => api.removeNative('4', true, check),
};

test.each(Object.keys(mutations) as (keyof typeof mutations)[])
('the real %s adapter runs its exact check after subscription admission and immediately calls Chrome', async kind => {
  const f = await fixture();
  const checks = vi.fn(async () => { expect(f.log).toContain('subscription'); f.log.push('check'); });
  const api = await f.personalSyncNativeApi(identity, f.native, async () => {});
  await mutations[kind](api, checks);
  expect(checks).toHaveBeenCalledTimes(1); expect(f.raw).toHaveBeenCalledTimes(1);
  expect(f.log.slice(-2)).toEqual(['check', 'chrome']);
});

test.each(['attempt', 'pause-resume'] as const)
('a late %s during actual subscription admission cannot pass the captured outer authority', async changed => {
  const f = await fixture(), policy = createPersonalSyncPolicyStore(new MemoryStorageArea());
  f.configurePersonalSyncTransport(policy);
  let allowed = true;
  const api = await f.personalSyncNativeApi(identity, f.native, async () => {
    if (!allowed) throw new Error('attempt_stale');
  });
  f.observed.mockImplementationOnce(async () => {
    const result = await f.read();
    if (changed === 'attempt') allowed = false;
    else { await policy.write(identity, 'paused'); await policy.write(identity, 'enabled'); }
    return result;
  });
  const check = vi.fn(async () => {});
  await expect(api.updateNative('4', { title: 'Stale' }, check)).rejects.toBeInstanceOf(f.NativeWriteNotStartedError);
  expect(check).not.toHaveBeenCalled(); expect(f.raw).not.toHaveBeenCalled();
});

test.each([new Error('guard_refused'), 'guard_refused'] as const)
('a final-check refusal is a proven non-call, preserving its original reason: %s', async reason => {
  const f = await fixture();
  const failed = f.native.updateNative('4', { title: 'Stale' }, () => Promise.reject(reason));
  await expect(failed).rejects.toMatchObject({ name: 'NativeWriteNotStartedError', message: 'guard_refused', cause: reason });
  expect(f.raw).not.toHaveBeenCalled();
});

test('an actual raw Chrome rejection is never labeled as a proven non-call', async () => {
  const f = await fixture(), failure = new Error('raw_chrome_rejected');
  f.raw.mockRejectedValueOnce(failure);
  await expect(f.native.createNative({ parentId: '1' }, async () => {})).rejects.toBe(failure);
  expect(failure).not.toBeInstanceOf(f.NativeWriteNotStartedError); expect(f.raw).toHaveBeenCalledTimes(1);
});
