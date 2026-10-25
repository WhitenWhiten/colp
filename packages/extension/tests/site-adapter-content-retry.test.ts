import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { retryUnsubmittedContent } from '../src/site-adapters/content-retry.js';
import { contentBindingKey } from '../src/site-adapters/content-identity.js';
import type { ContentBindingRow } from '../src/site-adapters/content-bindings.js';
const binding: ContentBindingRow = { id: 'pending', content: { siteKey: 'fixture.posts', identityVersion: 1, itemId: 'post' }, scopeId: 'library', purpose: 'semantic',
  native: null, captureIntentId: 'capture', connectionId: null, commandId: 'command', requestDigest: 'digest', state: 'pending', mode: 'create', policyRevision: null,
  title: 'Post', url: 'https://posts.test/post', parentId: 'folder' };
async function fixture() {
  const db = createSourceDatabase(new IDBFactory()), key = contentBindingKey(binding.content, binding.id);
  await db.transaction(['contentBindings'], 'readwrite', async tx => { tx.objectStore('contentBindings').put(binding, key); });
  return { db, key };
}
test('an unsubmitted popup save is fenced before checking its task and can be prepared again without a create', async () => {
  const f = await fixture(); try {
    const release = vi.fn(async () => {});
    await retryUnsubmittedContent(f.db, binding, { release, cancelUnsubmitted: async () => {
      expect(await f.db.read('contentBindings', f.key)).toMatchObject({ state: 'detached' });
    } });
    expect(await f.db.read('contentBindings', f.key)).toBeUndefined(); expect(release).toHaveBeenCalledOnce();
  } finally { await f.db.close(); }
});
test('an unknown native result keeps its original binding and never releases its shared ownership', async () => {
  const f = await fixture(); try {
    const release = vi.fn(async () => {});
    await expect(retryUnsubmittedContent(f.db, binding, { release, cancelUnsubmitted: async () => { throw new Error('content_result_unknown'); } })).rejects.toThrow('content_result_unknown');
    expect(await f.db.read('contentBindings', f.key)).toEqual(binding); expect(release).not.toHaveBeenCalled();
  } finally { await f.db.close(); }
});
test('a worker stop while checking a pending save remains explicitly recoverable', async () => {
  const f = await fixture(); try {
    const frozen = { ...binding, state: 'detached' as const };
    await f.db.transaction(['contentBindings', 'meta'], 'readwrite', async tx => {
      tx.objectStore('contentBindings').put(frozen, f.key); tx.objectStore('meta').put({ state: 'checking', binding }, `contentRetry:${binding.id}`);
    });
    await retryUnsubmittedContent(f.db, frozen, { cancelUnsubmitted: async () => {}, release: async () => {} });
    expect(await f.db.read('contentBindings', f.key)).toBeUndefined();
  } finally { await f.db.close(); }
});
test('automatic semantic work keeps its independent retry path', async () => {
  const f = await fixture(); try {
    await f.db.transaction(['semanticJobs'], 'readwrite', async tx => { tx.objectStore('semanticJobs').put({ state: 'pending' }, binding.captureIntentId); });
    const cancelUnsubmitted = vi.fn(async () => {});
    await expect(retryUnsubmittedContent(f.db, binding, { cancelUnsubmitted, release: async () => {} })).rejects.toThrow('content_retry_unavailable');
    expect(cancelUnsubmitted).not.toHaveBeenCalled(); expect(await f.db.read('contentBindings', f.key)).toEqual(binding);
  } finally { await f.db.close(); }
});
