import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { identityFromCreateReceipt } from '../src/bookmark-create-receipt-identity.js';
import { pendingLocalContentFields } from '../src/pull-queue-facts.js';
import { compactNativePayload } from '../src/compacted-native-facts.js';

test('compaction retains tag baselines and explicit clears for metadata receipt/recovery checks', () => {
  assert.deepEqual(compactNativePayload({ type: 'update_node_content', payload: {
    base: { tags: ['a', 'b'] }, value: { tags: [] },
  } }), { base: { tags: ['a', 'b'] }, value: { tags: [] } });
});
import { fixture, bookmark, scope, confirmQueued } from './bookmark-event-queue-harness.js';

test('description edits retain their observed base and value after queue payload compaction', () => {
  assert.deepEqual(compactNativePayload({ type: 'update_node_content', payload: {
    base: { description: 'Before' }, value: { description: null } } }), { base: { description: 'Before' }, value: { description: null } });
});

test('compacted creates retain the original parent and content needed by native identity repair', async () => {
  const f = await fixture(new IDBFactory());
  const node = bookmark('new', 'root-selected', 0, 'Original title', 'https://example.test/original');
  f.api.put(node); await f.queue.created(node.id, node); await f.queue.flush();
  await confirmQueued(f.store, 1, 'new-colp', 'server-created');
  const row = (await f.store.listQueue(scope))[0]!;
  const receipt = await f.store.getQueueReceipt(scope, 1);
  await f.store.publishCursor(scope, { cursor: 'published-cursor', checkpoint: 'checkpoint',
    evidence: { receiptId: receipt!.receiptId, operationDigest: row.digest } });
  assert.equal((await f.store.compactScope(scope)).compactedQueue, 1);
  await f.store.deleteMapping(scope, node.id);
  const identity = await identityFromCreateReceipt(f.store, scope, node.id);
  assert.equal(identity?.colpId, 'new-colp');
  assert.equal(identity?.parentNativeId, 'root-selected');
  assert.equal(identity?.rootNativeId, 'root-selected');
  assert.deepEqual(identity?.content, { title: 'Original title', url: 'https://example.test/original' });
});

test('compaction after a Push receipt preserves the local edit until its Pull echo', async () => {
  const f = await fixture(new IDBFactory(), { mappedNode: true });
  f.api.put(bookmark('mapped', 'root-selected', 0, 'Pending title', 'https://example.test/before'));
  await f.queue.changed('mapped', { title: 'Pending title' }); await f.queue.flush();
  await confirmQueued(f.store, 1, 'mapped-colp', 'server-updated');
  const row = (await f.store.listQueue(scope))[0]!; const receipt = await f.store.getQueueReceipt(scope, 1);
  await f.store.publishCursor(scope, { cursor: 'cursor-before-echo', checkpoint: 'checkpoint',
    evidence: { receiptId: receipt!.receiptId, operationDigest: row.digest } });
  assert.equal((await f.store.compactScope(scope)).compactedQueue, 1);
  assert.deepEqual(await pendingLocalContentFields(f.store, scope, { nativeId: 'mapped', colpId: 'mapped-colp' }),
    { title: 'Pending title' });
});
