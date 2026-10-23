import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { findBlockingUnsettledAttempt } from '../src/sync-state/queue-live-work.js';
import { INDEXES } from '../src/sync-state/schema.js';
import { requestValue, transactionDone } from '../src/sync-state/idb.js';

test.each(['deep', 'cycle', 'disjoint'] as const)('subtree overlap is conservative for %s ancestor chains', async (kind) => {
  const request = new IDBFactory().open('overlap');
  request.onupgradeneeded = () => {
    const queue = request.result.createObjectStore('queue', { keyPath: 'sequence' });
    queue.createIndex(INDEXES.queueByStatusSequence, ['scopeKey', 'status', 'sequence']);
    queue.createIndex(INDEXES.queueByAttempt, ['scopeKey', 'status', 'attempt.sessionId', 'sequence']);
    const mappings = request.result.createObjectStore('mappings', { keyPath: 'nativeId' });
    mappings.createIndex(INDEXES.mappingByNativeId, ['scopeKey', 'nativeId']);
    mappings.createIndex(INDEXES.mappingByColpId, ['scopeKey', 'colpId']);
  };
  const db = await requestValue(request);
  try {
    const write = db.transaction(['queue', 'mappings'], 'readwrite');
    const done = transactionDone(write);
    write.objectStore('queue').put({ scopeKey: 'scope', sequence: 1, status: 'claimed',
      opId: 'held', payload: { targetId: 'ancestor-colp' } });
    const put = (nativeId: string, parentNativeId?: string) => write.objectStore('mappings').put({
      scopeKey: 'scope', nativeId, colpId: nativeId === 'ancestor' ? 'ancestor-colp' : nativeId,
      parentNativeId,
    });
    put('ancestor');
    if (kind === 'deep') {
      for (let i = 0; i < 70; i += 1) put(`node-${i}`, i === 69 ? 'ancestor' : `node-${i + 1}`);
    } else if (kind === 'cycle') { put('node-0', 'node-1'); put('node-1', 'node-0'); }
    else put('node-0');
    await done;
    const read = db.transaction(['queue', 'mappings']);
    const complete = transactionDone(read);
    const blocker = await findBlockingUnsettledAttempt(read.objectStore('queue'), 'scope',
      { nativeIds: ['node-0'] }, read.objectStore('mappings'));
    await complete;
    assert.equal(blocker?.opId ?? null, kind === 'disjoint' ? null : 'held');
  } finally { db.close(); }
});
