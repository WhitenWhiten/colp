import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { validateOperation, digestJson } from '../src/bookmark-event-codec.js';
import { classifySyncFailure } from '../src/sync-failure-class.js';
import { scope } from './kns-05-pull-harness.js';

test('actual mapping, queue and ingress codec emissions retain subjects and reject the write', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  try {
    await store.registerScope({ ...scope, lifecycle: 'active', selectedRoots: [], checkpoint: null,
      lease: { leaseId: 'lease', expiresAt: Date.now() + 60000 } });
    const check = (subject: string) => (error: any) => {
      assert.equal(error.code, 'record_too_large');
      assert.ok(Object.values(error.subject).includes(subject));
      assert.equal(classifySyncFailure(error.code, error.subject)?.class, 'item'); return true;
    };
    await assert.rejects(store.putMapping(scope, { nativeId: 'native-bad', colpId: 'bad', rootNativeId: 'root',
      projection: { revision: 'r1', digest: 'sha256:original', content: { title: 'x'.repeat(300000) } } }), check('bad'));
    await assert.rejects(store.allocateSequenceAndEnqueue(scope, { opId: 'bad-op', batchId: 'batch', idempotencyKey: 'key',
      digest: 'sha256:original', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
      operationRevision: 'r1', status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { title: 'x'.repeat(300000) } }, { validateOperation, digestOperation: digestJson }), check('bad-op'));
    await assert.rejects(store.stageBookmarkEvent(scope, { eventId: 'bad-event', nativeId: 'native-bad', dedupeKey: 'bad-event',
      kind: 'change', occurredAt: new Date().toISOString(), details: { title: 'x'.repeat(300000) } }), check('native-bad'));
    assert.equal((await store.listMappings(scope)).length, 0);
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal((await store.listBookmarkEvents(scope)).length, 0);
  } finally { store.close(); }
});
