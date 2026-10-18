import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { advancedSelfProjectionIsProven } from '../src/pull-local-projection-evidence.js';
import type { JsonObject, MappingInput } from '../src/sync-state-store.js';
import { scope, setup } from './sync-recovery-hardening-fixture.js';

const mapping: MappingInput = { nativeId: 'native-created', colpId: 'remote-created', rootNativeId: '1',
  nodeKind: 'bookmark', parentNativeId: '1', projection: { revision: 'local-create', digest: 'digest',
    content: { title: 'Created', url: 'https://example.test/created' } } };

async function fixture() {
  const store = await setup();
  const create = await store.allocateSequenceAndEnqueue(scope, {
    opId: 'create', batchId: 'create', idempotencyKey: 'create', digest: 'sha256:create',
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
    operationRevision: 'local-create', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { type: 'create_node' },
  }, { allowUnstamped: true });
  const prove = () => advancedSelfProjectionIsProven(store, scope, mapping, undefined, '1', create.sequence);
  const remove = (nativeId = mapping.nativeId, targetId = `pending-${create.opId}`) =>
    store.stageBookmarkEvent(scope, { eventId: `remove-${nativeId}`, dedupeKey: `remove-${nativeId}`,
      nativeId, kind: 'remove', occurredAt: '2026-10-17T00:00:00Z',
      details: { deleteNativeIds: [nativeId], draft: { type: 'delete_node', targetId } } });
  return { store, create, prove, remove };
}

test('a missing native requires a removal of that exact create, not an unrelated callback', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.prove(), false);
    await f.remove('unrelated');
    assert.equal(await f.prove(), false);
    await f.remove(mapping.nativeId, 'another-create');
    assert.equal(await f.prove(), false);
    // A sequence that does not name the predecessor create cannot prove absence.
    assert.equal(await advancedSelfProjectionIsProven(f.store, scope, mapping, undefined, '1', 2), false);
  } finally { f.store.close(); }
});

test('a captured removal supersedes an earlier native-read snapshot', async () => {
  const f = await fixture();
  try {
    await f.remove();
    assert.equal(await advancedSelfProjectionIsProven(f.store, scope, mapping,
      { id: mapping.nativeId, parentId: '1', title: 'Earlier content', url: 'https://example.test/earlier' },
      '1', f.create.sequence), true);
  } finally { f.store.close(); }
});

test.each(['pending', 'processed', 'rejected'] as const)(
  'self-create absence proof respects a %s removal', async status => {
    const f = await fixture();
    try {
      const event = await f.remove();
      if (status !== 'pending') {
        await f.store.commitBookmarkEvent(scope, event.event.eventId, {
          operation: { type: 'delete_node', targetId: mapping.colpId },
          baseRevision: 'server-r1', operationRevision: 'local-delete',
          allocateOperationId: () => 'delete', validateOperation: () => true,
          digestOperation: () => 'sha256:delete',
        });
        if (status === 'rejected') {
          const lease = await f.store.acquireLease(scope, 'worker', 1, 30_000);
          await f.store.claimNextQueue(scope, 'worker', lease.fence, 1);
          await f.store.completeQueueWithReceipt(scope, f.create.sequence, { opId: f.create.opId,
            operationDigest: f.create.digest, kind: 'terminal', receiptId: 'create-receipt',
            resultDigest: 'sha256:receipt' });
          const deletion = (await f.store.claimNextQueue(scope, 'worker', lease.fence, 1))!;
          await f.store.settleClaimedPush(scope, deletion.sequence, 'worker', lease.fence, {
            outcome: 'rejected', recovery: { code: 'invalid_operation' },
          });
        }
      }
      assert.equal(await f.prove(), status !== 'rejected');
    } finally { f.store.close(); }
  });

test('processed removal evidence cannot borrow an earlier queue operation', async () => {
  const f = await fixture();
  try {
    const event = await f.remove();
    await f.store.commitBookmarkEvent(scope, event.event.eventId, {
      operation: { type: 'delete_node', targetId: mapping.colpId }, baseRevision: 'r1',
      operationRevision: 'local-delete', allocateOperationId: () => 'delete',
      validateOperation: () => true, digestOperation: () => 'sha256:delete',
    });
    const stale = { ...f.store, getQueueByOpId: async () => f.create };
    assert.equal(await advancedSelfProjectionIsProven(stale, scope, mapping, undefined, '1', f.create.sequence), false);
    const missing = { ...f.store, getQueueByOpId: async () => null };
    assert.equal(await advancedSelfProjectionIsProven(missing, scope, mapping, undefined, '1', f.create.sequence), false);
  } finally { f.store.close(); }
});

test('a native mutation proves its combined content without promoting the stored mapping', async () => {
  const f = await fixture();
  try {
    await f.store.stageBookmarkEvent(scope, { eventId: 'change', dedupeKey: 'change', kind: 'change',
      nativeId: mapping.nativeId, occurredAt: '2026-10-17T00:00:00Z',
      details: { nativeMutation: true, title: 'Edited after create' } });
    const native = { id: mapping.nativeId, parentId: '1', title: 'Edited after create',
      url: 'https://example.test/created' };
    assert.equal(await advancedSelfProjectionIsProven(f.store, scope, mapping, native, '1', f.create.sequence), true);
    assert.equal(await advancedSelfProjectionIsProven(f.store, scope, mapping, { ...native, title: 'Unproven' }, '1', 1), false);
    const event = (await f.store.listBookmarkEventsByStatus(scope, 'pending'))[0]!;
    assert.equal((event.details as JsonObject).mapping, undefined);
  } finally { f.store.close(); }
});

test.each(['proven', 'missing-parent', 'mismatched-parent'] as const)(
  'a pending move requires matching native placement and parent identity: %s', async evidence => {
    const f = await fixture();
    try {
      const projected = { ...mapping, colpId: 'pending-create', parentNativeId: 'native-target' };
      await f.store.stageBookmarkEvent(scope, { eventId: 'move', dedupeKey: 'move', kind: 'move',
        nativeId: mapping.nativeId, occurredAt: '2026-10-17T00:00:00Z', details: {
          mapping: projected as unknown as JsonObject, draft: { type: 'move_node' },
          context: { targetParentNativeId: evidence === 'mismatched-parent' ? 'another-parent' : 'native-target' },
        } });
      if (evidence !== 'missing-parent') await f.store.putMapping(scope, { nativeId: 'native-target',
        colpId: 'remote-target', rootNativeId: '1', nodeKind: 'folder',
        projection: { revision: 'r1', digest: 'target', content: { title: 'Target' } } });
      const native = { id: mapping.nativeId, parentId: 'native-target', title: 'Created',
        url: 'https://example.test/created' };
      assert.equal(await advancedSelfProjectionIsProven(f.store, scope, mapping, native, '1', 1), evidence === 'proven');
    } finally { f.store.close(); }
  });
