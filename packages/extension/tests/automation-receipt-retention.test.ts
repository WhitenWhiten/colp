import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { STORES } from '../src/sync-state/schema.js';
import { syncReceiptEvidence } from '../src/automation/receipt-evidence.js';
import { createReceiptStore, newPlacementReceipt, RECEIPT_MAX_AGE_MS, serializeReceipt,
  syncReceipts } from '../src/automation/receipt-sync.js';
import { COLLECTION_ID, DAY, NOW, folderRef } from './automation-fixture.js';

const scope: SyncScope = { environment: 'production', serverId: 'server-fixture', serverOrigin: 'https://colp.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: COLLECTION_ID, replicaId: 'replica', generation: 1 };
const key = scopeKey(scope), nativeId = 'native-bookmark', destination = 'native-folder';
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

for (const observed of [false, true]) test(`${observed ? 'observed move' : 'pre-save'} receipt sends identical evidence after GC and restart`, async () => {
  const factory = new IDBFactory();
  let store = await seeded(factory, observed);
  const evidence = syncReceiptEvidence(store, scope);
  const created = await evidence.create(nativeId); assert.ok(created);
  const values = new Map<string, unknown>();
  const area = { async get(id: string) { return structuredClone(values.get(id)); },
    async set(id: string, value: unknown) { values.set(id, structuredClone(value)); } };
  const receipts = createReceiptStore(area);
  const receipt = newPlacementReceipt({ ownerKey: 'owner', collectionId: scope.collectionId,
    replicaId: scope.replicaId, generation: scope.generation, path: observed ? 'observed' : 'preSave',
    rule: { id: 'rule', name: 'Rule', revision: '1', bindingRevision: '1', bundleRevision: '1' },
    destination: folderRef('academic'), destinationTitle: 'Academic', satisfies: ['classify.root'],
    page: { title: created.title, url: created.url },
    ...(observed ? { beforeFolder: folderRef('other-bookmarks') } : {}),
    native: { nativeId, destinationNativeId: destination, ...(observed ? { movedAt: NOW } : {}) },
  }, NOW, '6c5b0f8e-7c9a-4f3e-9d51-2a0b1c3d4e5f');
  await receipts.add(receipt, NOW);
  const device = { deviceId: 'device-server', replicaGeneration: 1 };
  const expected = serializeReceipt({ ...receipt, canonical: { nodeId: 'node-bookmark', operationId: 'op-create',
    ...(observed ? { placementOperationId: 'op-move' } : {}) } }, created, device);
  await store.compactScope(scope, { now: NOW });
  await store.compactScope(scope, { now: NOW + 2 * DAY });
  assert.equal(await store.getQueueByOpId(scope, 'op-create'), null);
  assert.equal(await store.getQueueReceipt(scope, 1), null);
  assert.equal(await store.getBookmarkEvent(scope, 'event-create'), null);
  store.close(); store = createSyncStateStore({ indexedDB: factory }); stores.push(store);
  const posted: unknown[] = [];
  const result = await syncReceipts(createReceiptStore(area), { ownerKey: 'owner', collectionId: scope.collectionId,
    replicaId: scope.replicaId, generation: scope.generation, ...device, now: NOW + 2 * DAY,
    evidence: syncReceiptEvidence(store, scope), post: async input => {
      posted.push(input); return { ok: true, status: 202, body: { receiptId: 'accepted-receipt', state: 'accepted',
        satisfiedTaskTypes: ['classify.root'], diagnostics: [] } };
    } });
  assert.deepEqual(result, { sent: 1, pending: 0 });
  assert.deepEqual(posted, [expected]);
  assert.equal((await receipts.list())[0]!.state, 'accepted');
  assert.deepEqual((await syncReceiptEvidence(store, scope).create(nativeId))?.tags, ['research']);
});

test('mapped creation proof survives long retention, then an unmapped proof gets a full retry grace', async () => {
  const store = await seeded(new IDBFactory(), false);
  await store.compactScope(scope, { now: NOW });
  await store.compactScope(scope, { now: NOW + DAY });
  // An old eligibility mark from an earlier release cannot shorten the grace
  // when a currently protected mapping later disappears.
  await write(store, [STORES.compactSummaries], tx => {
    tx.objectStore(STORES.compactSummaries).put({ scopeKey: key, kind: 'retention',
      id: JSON.stringify(['automation_create', nativeId]), eligibleAt: NOW - 40 * DAY });
  });
  await store.compactScope(scope, { now: NOW + 30 * DAY });
  assert.ok(await store.getRetainedCreateReceipt(scope, nativeId));
  assert.equal(await store.getQueueByOpId(scope, 'op-create'), null);
  await store.deleteMapping(scope, nativeId);
  const start = NOW + 31 * DAY;
  await store.compactScope(scope, { now: start });
  await store.compactScope(scope, { now: start + RECEIPT_MAX_AGE_MS });
  assert.ok(await store.getRetainedCreateReceipt(scope, nativeId));
  await store.compactScope(scope, { now: start + RECEIPT_MAX_AGE_MS + 1 });
  assert.equal(await store.getQueueByOpId(scope, 'op-create'), null);
  assert.equal(await store.getBookmarkEvent(scope, 'event-create'), null);
  assert.equal(await store.getQueueReceipt(scope, 1), null);
  assert.equal(await store.getRetainedCreateReceipt(scope, nativeId), null);
});

test('move evidence retains destination at the retry boundary and is reclaimed after it', async () => {
  const store = await seeded(new IDBFactory(), true);
  await store.compactScope(scope, { now: NOW });
  assert.equal(await syncReceiptEvidence(store, scope).move(nativeId, destination, NOW), 'op-move');
  await store.compactScope(scope, { now: NOW + RECEIPT_MAX_AGE_MS });
  assert.equal(await syncReceiptEvidence(store, scope).move(nativeId, destination, NOW), 'op-move');
  assert.equal(await syncReceiptEvidence(store, scope).move(nativeId, 'wrong-folder', NOW), null);
  assert.equal(await syncReceiptEvidence(store, scope).move(nativeId, destination, NOW + DAY), null);
  await store.compactScope(scope, { now: NOW + RECEIPT_MAX_AGE_MS + 1 });
  assert.equal(await store.getQueueByOpId(scope, 'op-move'), null);
  assert.equal(await store.getBookmarkEvent(scope, 'event-move'), null);
  assert.ok(await syncReceiptEvidence(store, scope).create(nativeId));
});

test('creating the retained proof and removing its history roll back atomically', async () => {
  const store = await seeded(new IDBFactory(), false);
  await store.compactScope(scope, { now: NOW });
  const before = await store.exportScope(scope);
  await assert.rejects(store.compactScope(scope, { now: NOW + DAY, fault: 'after_retention' }), /fault_injected/);
  assert.deepEqual(await store.exportScope(scope), before);
  assert.equal(await store.getRetainedCreateReceipt(scope, nativeId), null);
  await store.compactScope(scope, { now: NOW + DAY });
  assert.ok(await store.getRetainedCreateReceipt(scope, nativeId));
  assert.equal(await store.getQueueByOpId(scope, 'op-create'), null);
  await store.auditIntegrity();
});

test('retained proofs cannot cross a scope, tombstone, or replaced native identity', async () => {
  const store = await seeded(new IDBFactory(), false);
  await store.compactScope(scope, { now: NOW });
  await store.compactScope(scope, { now: NOW + DAY });
  assert.ok(await syncReceiptEvidence(store, scope).create(nativeId));
  assert.equal(await store.getRetainedCreateReceipt({ ...scope, generation: 2 }, nativeId), null);
  await store.putRemoteObservation(scope, { colpId: 'node-bookmark', kind: 'tombstone', remoteRevision: 'deleted',
    cursor: 'deleted-cursor', payload: { deleted: true }, sourceDigest: 'sha256:deleted', observedAt: NOW });
  assert.equal(await syncReceiptEvidence(store, scope).create(nativeId), null);
  await write(store, [STORES.remoteObservations], tx => tx.objectStore(STORES.remoteObservations).delete([key, 'node-bookmark']));
  await store.deleteMapping(scope, nativeId);
  await store.putMapping(scope, { nativeId, colpId: 'replacement', rootNativeId: 'root', nodeKind: 'bookmark',
    projection: { revision: 'replacement-revision', digest: 'sha256:replacement' } });
  assert.equal(await syncReceiptEvidence(store, scope).create(nativeId), null);
});

test('a planned create without a captured event retains its canonical receipt evidence', async () => {
  const store = await seeded(new IDBFactory(), false);
  const queued = (await store.listQueue(scope))[0]!;
  const receipt = (await store.getQueueReceipt(scope, 1))!;
  const opId = `b3.confirm.create.${nativeId}`;
  await write(store, [STORES.queue, STORES.receipts, STORES.bookmarkEvents], tx => {
    tx.objectStore(STORES.queue).put({ ...queued, opId });
    tx.objectStore(STORES.receipts).put({ ...receipt, opId, result: { results: [{
      opId, sequence: 1, status: 'applied', targetId: 'node-bookmark', revision: 'created-revision' }] } });
    tx.objectStore(STORES.bookmarkEvents).delete([key, 'event-create']);
  });
  const before = await syncReceiptEvidence(store, scope).create(nativeId); assert.ok(before);
  await store.compactScope(scope, { now: NOW });
  await store.compactScope(scope, { now: NOW + DAY });
  assert.equal(await store.getQueueByOpId(scope, opId), null);
  assert.deepEqual(await syncReceiptEvidence(store, scope).create(nativeId), before);
});

async function seeded(factory: IDBFactory, move: boolean) {
  const store = createSyncStateStore({ indexedDB: factory }); stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 9e12 },
    checkpoint: { cursor: 'current', serverRevision: 'rev' }, selectedRoots: [], firstRun: 'completed' });
  await store.putMapping(scope, { nativeId, colpId: 'node-bookmark', rootNativeId: 'root', nodeKind: 'bookmark',
    projection: { revision: 'later-revision', digest: 'sha256:later', content: { title: 'Edited later',
      url: 'https://example.test/changed', tags: ['edited'] } } });
  await write(store, [STORES.queue, STORES.receipts, STORES.bookmarkEvents, STORES.cursors, STORES.sequences], tx => {
    tx.objectStore(STORES.sequences).put({ scopeKey: key, next: move ? 3 : 2 });
    for (const [index, kind] of (move ? ['create', 'move'] : ['create']).entries()) {
      const sequence = index + 1, opId = `op-${kind}`, digest = `sha256:${opId}`;
      tx.objectStore(STORES.queue).put({ scopeKey: key, sequence, opId, digest,
        batchId: opId, idempotencyKey: opId, endpointIdentity: 'syncPush', mediaType: 'application/json',
        baseRevision: null, operationRevision: `local-${opId}`, status: 'terminal', echoApplied: true,
        retry: { attempt: 0, notBefore: 0 }, payload: { type: `${kind}_node`,
          ...(kind === 'create' ? { payload: { parentId: move ? 'other-bookmarks' : 'academic', node: {
            kind: 'bookmark', title: 'Original', url: 'https://example.test/original', tags: ['research'] } } }
            : { targetId: 'node-bookmark', payload: { newParentId: 'academic' } }) } });
      tx.objectStore(STORES.receipts).put({ scopeKey: key, sequence, opId, operationDigest: digest, kind: 'terminal',
        receiptId: `receipt-${kind}`, resultDigest: 'sha256:result', result: { results: [{
          opId, sequence, status: 'applied', targetId: 'node-bookmark', revision: 'created-revision' }] } });
      tx.objectStore(STORES.bookmarkEvents).put({ scopeKey: key, eventId: `event-${kind}`, dedupeKey: `dedupe-${kind}`,
        ordinal: sequence, status: 'processed', opId, kind, nativeId,
        occurredAt: new Date(kind === 'create' && move ? NOW - 30 * DAY : NOW).toISOString(),
        details: kind === 'move' ? { context: { targetParentNativeId: destination }, unnecessary: 'large payload' }
          : { node: { title: 'Original' } } });
    }
    tx.objectStore(STORES.cursors).put({ scopeKey: key, cursor: 'current', checkpoint: 'rev',
      evidence: { snapshotId: 'snapshot', pageDigest: 'sha256:page' } });
  });
  return store;
}

async function write(store: ReturnType<typeof createSyncStateStore>, names: readonly string[], apply: (tx: IDBTransaction) => void) {
  const tx = (await store.open()).transaction([...names], 'readwrite'); const done = transactionDone(tx);
  apply(tx); await done;
}
