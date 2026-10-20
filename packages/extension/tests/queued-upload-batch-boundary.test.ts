import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import * as boundary from '../src/queued-upload-boundary.js';
import { assertQueuedUploadBatchAllowed } from '../src/queued-upload-batch-boundary.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { runTransaction } from '../src/sync-state/idb.js';
import { validateMapping } from '../src/sync-state/mapping-repository.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { STORES } from '../src/sync-state/schema.js';
import { bookmark, folder, scope } from './bookmark-event-queue-harness.js';
import { assertUnsentOriginals, batchBoundaryFixture } from './queued-upload-batch-boundary-harness.js';

afterEach(() => vi.restoreAllMocks());
type Fixture = Awaited<ReturnType<typeof batchBoundaryFixture>>;
type Change = 'private' | 'range' | 'exclusion' | 'private_mapping' | 'private_identity' | 'mount_identity';
async function changeBoundary(f: Fixture, change: Change) {
  const node = f.nodes[1]!;
  if (change === 'private' || change === 'range') f.api.put({ ...f.api.node(node.id),
    parentId: change === 'private' ? 'root-private' : 'root-unselected' });
  else if (change === 'exclusion') await f.store.putLocalSyncExclusion(scope, { nativeId: node.id,
    rootNativeId: 'root-selected', decisionId: 'later-user-choice', generation: scope.generation });
  else if (change === 'private_mapping') await f.store.deleteMapping(scope, 'root-private');
  else if (change === 'private_identity') {
    const { scopeKey: _key, ...privateRoot } = (await f.store.getMappingByNativeId(scope, 'root-private'))!;
    f.api.put(folder('migrated-private', '0', 5, 'Private root'));
    f.api.put({ ...f.api.node(node.id), parentId: 'migrated-private' });
    await f.store.deleteMapping(scope, 'root-private');
    await f.store.putMapping(scope, { ...privateRoot, nativeId: 'migrated-private', rootNativeId: 'migrated-private' });
  }
  else {
    const { scopeKey: _key, ...mount } = (await f.store.listMountBindings(scope))[0]!;
    await f.store.putMountBinding(scope, { ...mount, nativeRootId: 'root-unselected' });
  }
}

for (const after of [1, 2, 3]) for (const change of ['private', 'range', 'exclusion', 'private_mapping', 'private_identity', 'mount_identity'] as const)
  test(`a ${change} change after batch proof phase ${after} blocks the actual fetch`, async () => {
    const f = await batchBoundaryFixture();
    try {
      let changed = false;
      f.hooks.afterProof = async ordinal => { if (ordinal === after) { await changeBoundary(f, change); changed = true; } };
      await createOutboundPushWorker(f.options).drain();
      expect(changed).toBe(true); await assertUnsentOriginals(f);
      expect(f.nodes.map(node => f.api.node(node.id).title)).toEqual(f.nodes.map(node => node.title));
    } finally { f.store.close(); }
  });

for (const change of ['private', 'range', 'exclusion', 'private_mapping', 'private_identity', 'mount_identity'] as const)
  test(`a committed ${change} between two members invalidates the same phase proof without a version bump`, async () => {
    const f = await batchBoundaryFixture();
    try {
      const version = (await f.store.getScope(scope))!.boundaryVersion;
      const real = boundary.assertQueuedUploadAllowed; let changed = false;
      // Scheduling instrumentation only: each member still executes the real
      // production guard against its real proof, then another context commits.
      vi.spyOn(boundary, 'assertQueuedUploadAllowed').mockImplementation(async input => {
        await real(input);
        if (!changed && input.subscriptionExclusions && input.queue.opId === f.original[0]!.opId) {
          await changeBoundary(f, change); changed = true;
        }
      });
      await createOutboundPushWorker(f.options).drain();
      expect(changed).toBe(true); expect((await f.store.getScope(scope))!.boundaryVersion).toBe(version);
      await assertUnsentOriginals(f);
    } finally { f.store.close(); }
  });

test.each([false, true])('a subscription exclusion committed between members is rechecked (same set size: %s)', async replace => {
  const f = await batchBoundaryFixture(), id = f.nodes[1]!.id;
  const priorId = 'batch-unrelated-exclusion';
  try {
    if (replace) await subscriptionStore.put('exclusions', { id: priorId, nativeId: 'root-unselected', reason: 'preserved',
      accountId: scope.accountId, serverOrigin: scope.serverOrigin });
    const real = boundary.assertQueuedUploadAllowed; let changed = false;
    vi.spyOn(boundary, 'assertQueuedUploadAllowed').mockImplementation(async input => {
      await real(input);
      if (!changed && input.subscriptionExclusions && input.queue.opId === f.original[0]!.opId) {
        if (replace) await subscriptionStore.remove('exclusions', priorId);
        await subscriptionStore.put('exclusions', { id, nativeId: id, reason: 'preserved',
          accountId: scope.accountId, serverOrigin: scope.serverOrigin }); changed = true;
      }
    });
    await createOutboundPushWorker(f.options).drain();
    expect(changed).toBe(true); await assertUnsentOriginals(f);
  } finally {
    await subscriptionStore.remove('exclusions', id); await subscriptionStore.remove('exclusions', priorId); f.store.close();
  }
});

test('the final ancestry follows a new parent outside all earlier native lookup hints', async () => {
  const f = await batchBoundaryFixture();
  try {
    f.hooks.afterFacts = async ordinal => {
      if (ordinal !== 1) return;
      f.api.put(folder('new-private-parent', 'root-private', 0, 'New private parent'));
      f.api.put({ ...f.api.node(f.nodes[1]!.id), parentId: 'new-private-parent' });
    };
    await createOutboundPushWorker(f.options).drain();
    await assertUnsentOriginals(f);
    expect(f.reads.nativeIds).toContain('new-private-parent');
    expect(f.reads.nativeIds).toContain('root-private');
  } finally { f.store.close(); }
});

// The 5000-pair codec/IDB fixture has its own budget; dispatch is bounded by
// actual native calls and returned mapping rows, not an inflated time target.
test.each([0, 5_000])('eight selected creates never scan %i unrelated native nodes or their mappings', async history => {
  const f = await batchBoundaryFixture();
  try {
    // Existing native/mapping pairs are legitimate unrelated history. Bulk
    // setup uses the real mapping codec and never creates queue/ACK evidence.
    await runTransaction(await f.store.open(), [STORES.mappings], 'readwrite', async tx => {
      for (let index = 0; index < history; index++) {
        const node = bookmark(`outside-${index}`, 'root-unselected', index,
          `Private local ${index}`, `https://private-local.test/${index}`);
        f.api.put(node);
        tx.objectStore(STORES.mappings).put(validateMapping(scopeKey(scope), { nativeId: node.id,
          colpId: `outside-colp-${index}`, rootNativeId: node.parentId, parentNativeId: node.parentId,
          nodeKind: 'bookmark', projection: { revision: `outside-r-${index}`, digest: `outside-d-${index}`,
            content: { title: node.title, url: node.url } } }, 256 * 1024));
      }
    });
    expect((await createOutboundPushWorker(f.options).drain()).outcome).toBe('terminal');
    expect(f.sent).toHaveLength(1); expect(f.reads.batchProofs).toBe(4); expect(f.reads.facts).toBe(8);
    expect(f.reads.nativeCalls).toBeLessThanOrEqual(32);
    expect(f.reads.nativeIds.length).toBeLessThanOrEqual(8 * (f.nodes.length + 2) + 10);
    expect(f.reads.mappingFacts).toBeLessThanOrEqual(8 * (f.nodes.length + 2));
    expect(f.reads.nativeIds.some(id => id.startsWith('outside-'))).toBe(false);
    for (const row of f.original) {
      expect(await f.store.getQueueByOpId(scope, row.opId)).toMatchObject({ status: 'terminal', sequence: row.sequence, digest: row.digest });
      expect((await f.store.getQueueReceipt(scope, row.sequence))?.operationDigest).toBe(row.digest);
    }
  } finally { f.store.close(); }
}, 15_000);

test('a lost batch replays exact persisted singleton bytes after restart through current individual guards', async () => {
  const f = await batchBoundaryFixture();
  try {
    let firstBody = '';
    expect((await createOutboundPushWorker({ ...f.options, fetch: async (_url, init) => {
      firstBody = String(init?.body); throw new Error('lost_response');
    } }).drain()).outcome).toBe('unknown');
    const before = await f.store.listQueue(scope), first = JSON.parse(firstBody);
    expect(before.every(row => row.status === 'unknown' && row.attempt?.body)).toBe(true);
    for (const [index, row] of before.entries()) expect(JSON.parse(row.attempt!.body).operations).toEqual([first.operations[index]]);
    const proofs = f.reads.batchProofs; f.advance(); f.store.close();
    expect((await createOutboundPushWorker(f.options).drain()).outcome).toBe('terminal');
    expect(f.sent).toEqual(before.map(row => row.attempt!.body));
    expect(f.reads.batchProofs).toBe(proofs);
    expect(f.reads.individualCalls).toBeGreaterThan(before.length);
    for (const row of before) expect(await f.store.getQueueByOpId(scope, row.opId)).toMatchObject({
      status: 'terminal', digest: row.digest, sequence: row.sequence });
  } finally { f.store.close(); }
});

test('96 confirmed creates retain all real receipts while bounding guard reads per batch', async () => {
  const f = await batchBoundaryFixture(96);
  try {
    expect((await createOutboundPushWorker(f.options).drain()).outcome).toBe('terminal');
    expect(f.sent).toHaveLength(2); expect(f.reads.batchProofs).toBe(8);
    expect(f.reads.facts).toBe(16); expect(f.reads.individualCalls).toBe(2);
    expect(f.reads.nativeCalls).toBeLessThanOrEqual(50);
    for (const row of f.original) expect(await f.store.getQueueReceipt(scope, row.sequence))
      .toMatchObject({ opId: row.opId, operationDigest: row.digest, kind: 'terminal' });
  } finally { f.store.close(); }
});

test('a missing batch native falls back to the real captured-removal proof, never a guessed parent', async () => {
  const f = await batchBoundaryFixture();
  try {
    const missing = f.nodes[1]!.id, get = f.api.get;
    f.api.get = async id => { if (id === missing) throw new Error("Can't find bookmark for id."); return get(id); };
    await expect(f.batchGuard(f.original)).rejects.toThrow(/Can't find bookmark/);
    await assertUnsentOriginals(f);
  } finally { f.store.close(); }
});

test('non-batchable work and an empty list retain the individual authority path', async () => {
  const f = await batchBoundaryFixture();
  try {
    await assertQueuedUploadBatchAllowed({ store: f.store, scope, rows: [], getMany: f.getMany,
      parentOf: async id => (await f.api.get(id))[0]?.parentId });
    expect(f.reads.nativeCalls).toBe(0);
    const row = f.original[0]!;
    await expect(f.batchGuard([{ ...row, payload: { ...row.payload, dependencies: ['not-ready'] } }])).resolves.toBeUndefined();
    expect(f.reads.facts).toBe(0);
    expect(f.reads.nativeCalls).toBeGreaterThan(0); await assertUnsentOriginals(f);
  } finally { f.store.close(); }
});
