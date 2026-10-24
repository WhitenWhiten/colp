import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { DATABASE_NAME, DATABASE_VERSION, createSyncStateStore } from '../src/sync-state-store.js';
import { classifySyncFailure } from '../src/sync-failure-class.js';
import { seedPreviousVersion } from './sync-storage-fixtures.js';

/**
 * W2A-10: an upgrade held back by another connection (an older page that never closes) left `open()` pending
 * forever, so every status read and every wake hung without a message. After a bounded wait the callers get
 * `storage_blocked`, a retryable code; the queued upgrade finishes when the holder lets go, and the connection
 * it opens for nobody is closed again.
 */
test('an upgrade held back by another connection gives up with storage_blocked, then recovers once it is released', async () => {
  const factory = new IDBFactory(); await seedPreviousVersion(factory, DATABASE_VERSION - 1);
  const holder = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE_NAME); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  let blockedEvents = 0;
  const store = createSyncStateStore({ indexedDB: factory, blockedWaitMilliseconds: 30, onBlocked: () => { blockedEvents += 1; } });
  assert.deepEqual(await store.storageState(), { state: 'unavailable', code: 'storage_blocked' });
  assert.equal(blockedEvents, 1);
  assert.equal(classifySyncFailure('storage_blocked')?.class, 'transient');

  holder.close();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(await store.storageState(), { state: 'ok' });
  assert.equal((await store.open()).version, DATABASE_VERSION);
  // Nothing is left holding the database: it can be deleted without being blocked.
  store.close();
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(DATABASE_NAME); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('a stray connection is still open'));
  });
});
