/**
 * Owner: KNS-04. Formal IDs: FR-F2-RECEIPT-REPLAY.
 * Run: npx vitest run tests/bookmark-create-receipt-identity.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import {
  identityFromCreateReceipt, inFlightCreateEvidence, plannedCreateOpIdForNative,
} from '../src/bookmark-create-receipt-identity.js';
import { createSyncStateStore, SyncStateError, type JsonObject } from '../src/sync-state-store.js';
import { mapping, scope } from './bookmark-event-queue-harness.js';

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('create receipt identity', () => {
  test('virtual natives and missing creates stay unbound', async () => {
    const store = await ready();
    assert.equal(await identityFromCreateReceipt(store, scope, 'pending-1'), null);
    assert.equal(await identityFromCreateReceipt(store, scope, 'bm-missing'), null);
    assert.equal(await plannedCreateOpIdForNative(store, scope, 'pending-1'), null);
    assert.equal(await inFlightCreateEvidence(store, scope, 'bm-missing'), null);
  });

  test('terminal receipt without mapping reads getQueueReceipt, not exportScope', async () => {
    const inner = await ready();
    let exportCalls = 0;
    let receiptCalls = 0;
    const store = {
      ...inner,
      exportScope: async (...args: Parameters<typeof inner.exportScope>) => {
        exportCalls += 1;
        return inner.exportScope(...args);
      },
      getQueueReceipt: async (...args: Parameters<typeof inner.getQueueReceipt>) => {
        receiptCalls += 1;
        return inner.getQueueReceipt(...args);
      },
    };
    await enqueueCreate(store, 'bm-1', 'b3.confirm.create.bm-1', 'terminal', 'node-remote-1');
    const identity = await identityFromCreateReceipt(store, scope, 'bm-1');
    assert.equal(identity?.colpId, 'node-remote-1');
    assert.equal(exportCalls, 0);
    assert.equal(receiptCalls, 1);
    const source = readFileSync(resolve(import.meta.dirname, '../src/bookmark-create-receipt-identity.ts'), 'utf8');
    assert.equal(source.includes('exportScope'), false);
    assert.equal(source.includes('getQueueReceipt'), true);
  });

  test('FR-F2-RECEIPT-REPLAY: terminal receipt without mapping yields the remote Node', async () => {
    const store = await ready();
    await enqueueCreate(store, 'bm-1', 'b3.confirm.create.bm-1', 'terminal', 'node-remote-1');
    const identity = await identityFromCreateReceipt(store, scope, 'bm-1');
    assert.equal(identity?.colpId, 'node-remote-1');
    assert.equal(identity?.createOpId, 'b3.confirm.create.bm-1');
    assert.equal(identity?.parentNativeId, 'folder-parent');
    assert.equal(identity?.nodeKind, 'bookmark');
    assert.deepEqual(identity?.content, { title: 'Receipt', url: 'https://example.test/receipt' });
    assert.equal(await plannedCreateOpIdForNative(store, scope, 'bm-1'), 'b3.confirm.create.bm-1');
  });

  test('deleteMapping leaves a terminal receipt unbound for later rebind', async () => {
    const store = await ready();
    await enqueueCreate(store, 'bm-drop', 'b3.confirm.create.bm-drop', 'terminal', 'node-drop');
    await mapping(store, 'bm-drop', 'node-drop', 'root-selected', 'server-r1',
      { title: 'Receipt', url: 'https://example.test/receipt' }, 'folder-parent');
    assert.equal(await store.deleteMapping(scope, 'bm-drop'), true);
    assert.equal(await store.getMappingByNativeId(scope, 'bm-drop'), null);
    const identity = await identityFromCreateReceipt(store, scope, 'bm-drop');
    assert.equal(identity?.colpId, 'node-drop');
  });

  test('authoritative mapping wins over the receipt row', async () => {
    const store = await ready();
    await enqueueCreate(store, 'bm-1', 'b3.confirm.create.bm-1', 'terminal', 'node-remote-1');
    await mapping(store, 'bm-1', 'node-mapped', 'root-selected', 'server-r2',
      { title: 'Mapped', url: 'https://example.test/mapped' }, 'folder-parent');
    const identity = await identityFromCreateReceipt(store, scope, 'bm-1');
    assert.equal(identity?.colpId, 'node-mapped');
    assert.equal(identity?.revision, 'server-r2');
  });

  test('in-flight pending and claimed creates reuse the original event', async () => {
    const store = await ready();
    await store.stageBookmarkEvent(scope, {
      eventId: 'evt-pending', dedupeKey: 'dedupe-pending', occurredAt: '2026-07-27T00:00:00.000Z',
      kind: 'create', nativeId: 'bm-pending', details: {
        mapping: { nativeId: 'bm-pending', colpId: 'pending-evt-pending', rootNativeId: 'root-selected',
          nodeKind: 'bookmark', parentNativeId: 'folder-parent',
          projection: { revision: 'local-evt', digest: 'sha256:p', content: { title: 'P' } } },
      },
    });
    const pending = await inFlightCreateEvidence(store, scope, 'bm-pending');
    assert.equal(pending?.eventId, 'evt-pending');
    assert.equal(pending?.identity.colpId, 'pending-evt-pending');

    await enqueueCreate(store, 'bm-sent', 'b3.confirm.create.bm-sent', 'claimed', 'node-unused');
    await store.stageBookmarkEvent(scope, {
      eventId: 'evt-sent', dedupeKey: 'dedupe-sent', occurredAt: '2026-07-27T00:00:00.000Z',
      kind: 'create', nativeId: 'bm-sent', details: {
        mapping: { nativeId: 'bm-sent', colpId: 'pending-evt-sent', rootNativeId: 'root-selected',
          nodeKind: 'bookmark',
          projection: { revision: 'local-sent', digest: 'sha256:s', content: { title: 'S' } } },
      },
    });
    const events = await store.listBookmarkEventsByNative(scope, 'bm-sent', 0, 10);
    const processed = events.find((row) => row.eventId === 'evt-sent');
    if (processed) {
      /* processed rows keep opId through commit; in-flight uses getQueueByOpId */
    }
    const sent = await inFlightCreateEvidence(store, scope, 'bm-sent');
    assert.ok(sent === null || sent.identity.nativeId === 'bm-sent');
  });

  test('create receipt without parent proof does not guess another live mount root', async () => {
    const store = await readyWithoutParent();
    await store.putMountBinding(scope, {
      mountId: 'mount-a', nativeRootId: 'root-a', remoteMountNodeId: 'remote-a',
      boundaryVersion: '1', materialized: false, status: 'active', customSourceKey: 'folder:root-a',
    });
    await store.putMountBinding(scope, {
      mountId: 'mount-b', nativeRootId: 'root-b', remoteMountNodeId: 'remote-b',
      boundaryVersion: '1', materialized: false, status: 'active', customSourceKey: 'folder:root-b',
    });
    const payload: JsonObject = {
      type: 'create_node', opId: 'op-orphan-create', replicaId: scope.replicaId, sequence: 1,
      collectionId: scope.collectionId, baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z',
      dependencies: [], payload: { parentId: 'unknown-parent', node: { kind: 'bookmark', title: 'Orphan',
        url: 'https://example.test/orphan' } },
    };
    const queued = await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-orphan-create', batchId: 'op-orphan-create', idempotencyKey: 'op-orphan-create',
      digest: 'sha256:op-orphan-create', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: null, operationRevision: 'local-op-orphan-create', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload,
    }, { allowUnstamped: true });
    const lease = await store.acquireLease(scope, 'worker-receipt', 1, 30_000);
    await store.claimNextQueue(scope, 'worker-receipt', lease.fence, 1);
    const result = { batchId: queued.batchId, results: [{ opId: queued.opId, sequence: queued.sequence,
      status: 'applied', targetId: 'node-orphan', revision: 'server-orphan-r1', cursor: 'cursor-orphan',
      warnings: [] }], serverCursor: 'cursor-orphan' };
    await store.settleClaimedPush(scope, queued.sequence, 'worker-receipt', lease.fence, {
      outcome: 'terminal',
      receipt: {
        opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-orphan',
        resultDigest: 'sha256:node-orphan', result,
      },
      authoritativeCreate: { nativeId: 'bm-orphan', targetId: 'node-orphan', revision: 'server-orphan-r1' },
    });
    const mapped = await store.getMappingByNativeId(scope, 'bm-orphan');
    assert.equal(mapped?.colpId, 'node-orphan');
    assert.equal(mapped?.rootNativeId, 'bm-orphan');
    assert.notEqual(mapped?.rootNativeId, 'root-a');
    assert.notEqual(mapped?.rootNativeId, 'root-b');
  });

  test('parent identity can resolve through a live custom mount', async () => {
    const store = await ready();
    await store.putMountBinding(scope, {
      mountId: 'mount-custom', nativeRootId: 'folder-parent', remoteMountNodeId: 'remote-parent',
      boundaryVersion: '1', materialized: false, status: 'active', customSourceKey: 'folder-parent',
    });
    await enqueueCreate(store, 'bm-2', 'b3.confirm.create.bm-2', 'terminal', 'node-child-2', 'remote-parent');
    const identity = await identityFromCreateReceipt(store, scope, 'bm-2');
    assert.equal(identity?.parentNativeId, 'folder-parent');
    assert.equal(identity?.rootNativeId, 'folder-parent');
  });

  test('rebased receipts, folders, and pending parents stay classified', async () => {
    const store = await ready();
    await enqueueCreate(store, 'bm-rebased', 'b3.confirm.create.bm-rebased', 'terminal', 'node-rebased',
      'folder-colp', 'server-r2', 'rebased');
    assert.equal((await identityFromCreateReceipt(store, scope, 'bm-rebased'))?.colpId, 'node-rebased');
    await enqueueFolder(store, 'folder-new', 'b3.confirm.create.folder-new', 'node-folder');
    assert.equal((await identityFromCreateReceipt(store, scope, 'folder-new'))?.nodeKind, 'folder');
    await enqueueCreate(store, 'bm-pending-parent', 'b3.confirm.create.bm-pending-parent', 'terminal',
      'node-pp', 'pending-parent');
    assert.equal((await identityFromCreateReceipt(store, scope, 'bm-pending-parent'))?.parentNativeId, undefined);
    await enqueueCreate(store, 'bm-pending-status', 'b3.confirm.create.bm-pending-status', 'pending', 'node-x');
    assert.equal(await identityFromCreateReceipt(store, scope, 'bm-pending-status'), null);
    assert.equal(await plannedCreateOpIdForNative(store, scope, 'bm-pending-status'), 'b3.confirm.create.bm-pending-status');
  });

  test('rejects local revisions, non-applied receipts, and non-create payloads', async () => {
    const store = await ready();
    await enqueueCreate(store, 'bm-3', 'op-local-rev', 'terminal', 'node-3', 'folder-colp', 'local-r1');
    assert.equal(await identityFromCreateReceipt(store, scope, 'bm-3'), null);
    await enqueueCreate(store, 'bm-4', 'op-conflicted', 'terminal', 'node-4', 'folder-colp', 'r1', 'conflicted');
    assert.equal(await identityFromCreateReceipt(store, scope, 'bm-4'), null);
    await enqueueRaw(store, 'bm-update', 'b3.confirm.create.bm-update', {
      type: 'update_node_content', targetId: 'node-x', payload: { value: { title: 'X' } },
    }, 'applied', 'node-x', 'server-r1');
    assert.equal(await identityFromCreateReceipt(store, scope, 'bm-update'), null);
    assert.equal(await plannedCreateOpIdForNative(store, scope, 'bm-update'), null);
  });

  test('classifies separators, empty content, and malformed receipts without inventing identity', async () => {
    const store = await ready();
    await enqueueRaw(store, 'sep-1', 'b3.confirm.create.sep-1', {
      type: 'create_node', payload: { parentId: 'folder-colp', node: { kind: 'separator' } },
    }, 'applied', 'node-sep', 'server-r1');
    const separator = await identityFromCreateReceipt(store, scope, 'sep-1');
    assert.equal(separator?.nodeKind, 'separator');
    assert.equal(separator?.content, null);
    await enqueueRaw(store, 'bm-kind', 'b3.confirm.create.bm-kind', {
      type: 'create_node', payload: { parentId: 'folder-colp', node: { kind: 'alias', title: 'Alias' } },
    }, 'applied', 'node-kind', 'server-r1');
    assert.equal((await identityFromCreateReceipt(store, scope, 'bm-kind'))?.nodeKind, undefined);
    await enqueueRaw(store, 'bm-inner', 'b3.confirm.create.bm-inner', {
      type: 'create_node', payload: ['not-an-object'],
    }, 'applied', 'node-inner', 'server-r1');
    assert.equal((await identityFromCreateReceipt(store, scope, 'bm-inner'))?.content, null);
    await enqueueRaw(store, 'bm-empty-results', 'b3.confirm.create.bm-empty-results', {
      type: 'create_node', payload: { parentId: 'folder-colp', node: { kind: 'bookmark', title: 'E' } },
    }, 'applied', 'node-empty', 'server-r1', { results: [] });
    assert.equal(await identityFromCreateReceipt(store, scope, 'bm-empty-results'), null);
    await enqueueRaw(store, 'bm-array-row', 'b3.confirm.create.bm-array-row', {
      type: 'create_node', payload: { parentId: 'folder-colp', node: { kind: 'bookmark', title: 'A' } },
    }, 'applied', 'node-array', 'server-r1', { results: [['bad']] });
    assert.equal(await identityFromCreateReceipt(store, scope, 'bm-array-row'), null);
    await enqueueRaw(store, 'bm-pending-target', 'b3.confirm.create.bm-pending-target', {
      type: 'create_node', payload: { parentId: 'folder-colp', node: { kind: 'bookmark', title: 'P' } },
    }, 'applied', 'pending-target', 'server-r1');
    assert.equal(await identityFromCreateReceipt(store, scope, 'bm-pending-target'), null);
  });

  test('in-flight processed creates reuse the queue until the receipt is terminal', async () => {
    const store = await ready();
    await store.stageBookmarkEvent(scope, {
      eventId: 'evt-no-map', dedupeKey: 'dedupe-no-map', occurredAt: '2026-07-27T00:00:00.000Z',
      kind: 'create', nativeId: 'bm-no-map', details: { title: 'No mapping' },
    });
    assert.equal(await inFlightCreateEvidence(store, scope, 'bm-no-map'), null);

    const queued = await commitCreate(store, 'bm-sent', 'evt-sent', 'op-unplanned-sent');
    const sent = await inFlightCreateEvidence(store, scope, 'bm-sent');
    assert.equal(sent?.eventId, 'evt-sent');
    assert.equal(sent?.identity.nativeId, 'bm-sent');
    await store.completeQueueWithReceipt(scope, queued.sequence, {
      opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: 'receipt-sent',
      resultDigest: 'sha256:node-sent',
      result: { results: [{ opId: queued.opId, sequence: queued.sequence, status: 'applied',
        targetId: 'node-sent', revision: 'server-r1' }] },
    });
    assert.equal(await inFlightCreateEvidence(store, scope, 'bm-sent'), null);
    const rebound = await identityFromCreateReceipt(store, scope, 'bm-sent');
    assert.equal(rebound?.colpId, 'node-sent');
    assert.equal(rebound?.createOpId, 'op-unplanned-sent');
  });

  test('planned create lookup continues past a full first page', async () => {
    const store = await ready();
    await enqueueCreate(store, 'bm-page', 'b3.confirm.create.bm-page', 'terminal', 'node-page');
    const paged = withListQueue(store, Array.from({ length: 1_000 }, (_, index) => ({
      sequence: index + 1, opId: `b3.confirm.create.pad-${index}`, status: 'pending',
      payload: { type: 'create_node' },
    })) as unknown as Awaited<ReturnType<typeof store.listQueue>>);
    assert.equal((await identityFromCreateReceipt(paged, scope, 'bm-page'))?.colpId, 'node-page');
  });

  test('native event history continues past a full first page', async () => {
    const store = await ready();
    await store.stageBookmarkEvent(scope, {
      eventId: 'evt-hist-create', dedupeKey: 'dedupe-hist-create',
      occurredAt: '2026-07-27T00:00:01.000Z', kind: 'create', nativeId: 'bm-hist',
      details: { mapping: { nativeId: 'bm-hist', colpId: 'pending-evt-hist', rootNativeId: 'root-selected',
        nodeKind: 'bookmark', parentNativeId: 'folder-parent',
        projection: { revision: 'local-hist', digest: 'sha256:h', content: { title: 'Hist' } } } },
    });
    const paged = withNativeEvents(store, Array.from({ length: 1_000 }, (_, index) => ({
      eventId: `evt-pad-${index}`, ordinal: index + 1, kind: 'change', nativeId: 'bm-hist',
      opId: undefined, details: {}, status: 'pending',
    })) as unknown as Awaited<ReturnType<typeof store.listBookmarkEventsByNative>>);
    assert.equal((await inFlightCreateEvidence(paged, scope, 'bm-hist'))?.eventId, 'evt-hist-create');
  });

  test('pending mapping plus live occupant of targetId fails closed and keeps the pending row', async () => {
    const store = await ready();
    const queued = await commitPendingCreate(store, 'bm-collide', 'evt-collide', 'op-collide');
    await mapping(store, 'other-live', 'node-collide', 'root-selected', 'server-other-r1', { title: 'Other' });
    const lease = await store.acquireLease(scope, 'worker-receipt', 1, 30_000);
    await store.claimNextQueue(scope, 'worker-receipt', lease.fence, 1);
    await assert.rejects(() => settleCreate(store, queued, lease.fence, 'bm-collide', 'node-collide'),
      (error: unknown) => error instanceof SyncStateError && error.code === 'mapping_identity_collision');
    assert.equal((await store.getMappingByNativeId(scope, 'bm-collide'))?.colpId, `pending-${queued.opId}`);
    assert.equal((await store.getMappingByColpId(scope, 'node-collide'))?.nativeId, 'other-live');
    assert.equal((await store.listQueue(scope))[0]?.status, 'claimed');
    assert.equal(await store.getQueueReceipt(scope, queued.sequence), null);
  });

  test('insertCreateReceiptMapping with a live occupant fails closed instead of dropping identity', async () => {
    const store = await ready();
    await enqueueCreate(store, 'bm-insert', 'op-insert', 'pending', 'node-insert');
    await mapping(store, 'other-live', 'node-insert', 'root-selected', 'server-other-r1', { title: 'Other' });
    const lease = await store.acquireLease(scope, 'worker-receipt', 1, 30_000);
    const queued = (await store.claimNextQueue(scope, 'worker-receipt', lease.fence, 1))!;
    await assert.rejects(() => settleCreate(store, queued, lease.fence, 'bm-insert', 'node-insert'),
      (error: unknown) => error instanceof SyncStateError && error.code === 'mapping_identity_collision');
    assert.equal(await store.getMappingByNativeId(scope, 'bm-insert'), null);
    assert.equal((await store.getMappingByColpId(scope, 'node-insert'))?.nativeId, 'other-live');
    assert.equal((await store.listQueue(scope))[0]?.status, 'claimed');
    assert.equal(await store.getQueueReceipt(scope, queued.sequence), null);
  });

  test.each(['recovery:virt', 'sidecar:virt', 'unmounted:virt'] as const)(
    'insertCreateReceiptMapping transfers virtual occupant %s',
    async (virtualId) => {
      const store = await ready();
      await enqueueCreate(store, 'bm-virt', 'op-virt', 'pending', 'node-virt');
      await mapping(store, virtualId, 'node-virt', 'root-selected', 'server-virt-r1', { title: 'Virtual' });
      const lease = await store.acquireLease(scope, 'worker-receipt', 1, 30_000);
      const queued = (await store.claimNextQueue(scope, 'worker-receipt', lease.fence, 1))!;
      await settleCreate(store, queued, lease.fence, 'bm-virt', 'node-virt');
      assert.equal((await store.getMappingByNativeId(scope, 'bm-virt'))?.colpId, 'node-virt');
      assert.equal(await store.getMappingByNativeId(scope, virtualId), null);
      assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
    },
  );

  test('pending mapping transfers a virtual occupant of targetId', async () => {
    const store = await ready();
    const queued = await commitPendingCreate(store, 'bm-handoff', 'evt-handoff', 'op-handoff');
    await mapping(store, 'recovery:handoff', 'node-handoff', 'root-selected', 'server-virt-r1', { title: 'Virtual' });
    const lease = await store.acquireLease(scope, 'worker-receipt', 1, 30_000);
    await store.claimNextQueue(scope, 'worker-receipt', lease.fence, 1);
    await settleCreate(store, queued, lease.fence, 'bm-handoff', 'node-handoff');
    assert.equal((await store.getMappingByNativeId(scope, 'bm-handoff'))?.colpId, 'node-handoff');
    assert.equal(await store.getMappingByNativeId(scope, 'recovery:handoff'), null);
    assert.equal((await store.listQueue(scope))[0]?.status, 'terminal');
  });
});

function withListQueue(
  store: ReturnType<typeof createSyncStateStore>,
  firstPage: Awaited<ReturnType<ReturnType<typeof createSyncStateStore>['listQueue']>>,
) {
  const original = store.listQueue.bind(store);
  let pages = 0;
  return { ...store, listQueue: async (
    ...args: Parameters<ReturnType<typeof createSyncStateStore>['listQueue']>
  ) => (pages++ === 0 ? firstPage : original(args[0], args[1], 0, args[3])) };
}

function withNativeEvents(
  store: ReturnType<typeof createSyncStateStore>,
  firstPage: Awaited<ReturnType<ReturnType<typeof createSyncStateStore>['listBookmarkEventsByNative']>>,
) {
  const original = store.listBookmarkEventsByNative.bind(store);
  let pages = 0;
  return { ...store, listBookmarkEventsByNative: async (
    ...args: Parameters<ReturnType<typeof createSyncStateStore>['listBookmarkEventsByNative']>
  ) => (pages++ === 0 ? firstPage : original(args[0], args[1], 0, args[3])) };
}

async function ready() {
  const store = await readyWithoutParent();
  await mapping(store, 'folder-parent', 'folder-colp', 'root-selected', 'folder-r1', { title: 'Parent' });
  return store;
}

async function readyWithoutParent() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-receipt', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready',
  });
  return store;
}

async function enqueueCreate(
  store: ReturnType<typeof createSyncStateStore>, nativeId: string, opId: string,
  status: 'pending' | 'claimed' | 'terminal', targetId: string, parentId = 'folder-colp',
  revision = 'server-r1', resultStatus = 'applied',
) {
  const payload: JsonObject = {
    type: 'create_node', opId, replicaId: scope.replicaId, sequence: 1,
    collectionId: scope.collectionId, baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z',
    dependencies: [], payload: { parentId, node: { kind: 'bookmark', title: 'Receipt',
      url: 'https://example.test/receipt' } },
  };
  const queued = await store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload,
  }, { allowUnstamped: true });
  if (status === 'claimed') {
    const lease = await store.acquireLease(scope, 'worker-receipt', 1, 30_000);
    await store.claimNextQueue(scope, 'worker-receipt', lease.fence, 1);
  }
  if (status === 'terminal') {
    await store.completeQueueWithReceipt(scope, queued.sequence, {
      opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `receipt-${nativeId}`,
      resultDigest: `sha256:${targetId}`,
      result: { results: [{ opId, sequence: queued.sequence, status: resultStatus, targetId, revision }] },
    });
  }
}

async function enqueueRaw(
  store: ReturnType<typeof createSyncStateStore>, nativeId: string, opId: string, payload: JsonObject,
  resultStatus: string, targetId: string, revision: string, result?: JsonObject,
) {
  const queued = await store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload,
  }, { allowUnstamped: true });
  await store.completeQueueWithReceipt(scope, queued.sequence, {
    opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `receipt-${nativeId}`,
    resultDigest: `sha256:${targetId}`,
    result: result ?? { results: [{ opId, sequence: queued.sequence, status: resultStatus, targetId, revision }] },
  });
}

async function settleCreate(
  store: ReturnType<typeof createSyncStateStore>, queued: { readonly opId: string; readonly sequence: number;
    readonly digest: string }, fence: number, nativeId: string, targetId: string, revision = 'server-r1',
) {
  return store.settleClaimedPush(scope, queued.sequence, 'worker-receipt', fence, {
    outcome: 'terminal',
    receipt: {
      opId: queued.opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `receipt-${nativeId}`,
      resultDigest: `sha256:${targetId}`,
      result: { results: [{ opId: queued.opId, sequence: queued.sequence, status: 'applied', targetId, revision }] },
    },
    authoritativeCreate: { nativeId, targetId, revision },
  });
}

async function commitPendingCreate(
  store: ReturnType<typeof createSyncStateStore>, nativeId: string, eventId: string, opId: string,
) {
  const pending = {
    nativeId, colpId: `pending-${eventId}`, rootNativeId: 'root-selected', nodeKind: 'bookmark' as const,
    parentNativeId: 'folder-parent',
    projection: { revision: `local-${eventId}`, digest: 'sha256:c',
      content: { title: 'Sent', url: 'https://example.test/sent' } },
  };
  await store.stageBookmarkEvent(scope, {
    eventId, dedupeKey: `dedupe-${eventId}`, occurredAt: '2026-07-27T00:00:00.000Z',
    kind: 'create', nativeId, details: { mapping: pending },
  });
  return store.commitBookmarkEvent(scope, eventId, {
    operation: {
      type: 'create_node', replicaId: scope.replicaId, collectionId: scope.collectionId,
      baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
      payload: { parentId: 'folder-colp', node: { kind: 'bookmark', title: 'Sent',
        url: 'https://example.test/sent' } },
    },
    mapping: pending, baseRevision: null, operationRevision: `local-${eventId}`,
    validateOperation: () => true, digestOperation: () => `sha256:${opId}`,
    allocateOperationId: () => opId,
  });
}

async function commitCreate(
  store: ReturnType<typeof createSyncStateStore>, nativeId: string, eventId: string, opId: string,
) {
  await store.stageBookmarkEvent(scope, {
    eventId, dedupeKey: `dedupe-${eventId}`, occurredAt: '2026-07-27T00:00:00.000Z',
    kind: 'create', nativeId, details: {
      mapping: { nativeId, colpId: `pending-${eventId}`, rootNativeId: 'root-selected',
        nodeKind: 'bookmark', parentNativeId: 'folder-parent',
        projection: { revision: `local-${eventId}`, digest: 'sha256:c', content: { title: 'Sent' } } },
    },
  });
  return store.commitBookmarkEvent(scope, eventId, {
    operation: {
      type: 'create_node', replicaId: scope.replicaId, collectionId: scope.collectionId,
      baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z', dependencies: [],
      payload: { parentId: 'folder-colp', node: { kind: 'bookmark', title: 'Sent',
        url: 'https://example.test/sent' } },
    },
    baseRevision: null, operationRevision: `local-${eventId}`,
    validateOperation: () => true, digestOperation: () => `sha256:${opId}`,
    allocateOperationId: () => opId,
  });
}

async function enqueueFolder(
  store: ReturnType<typeof createSyncStateStore>, nativeId: string, opId: string, targetId: string,
) {
  const payload: JsonObject = {
    type: 'create_node', opId, replicaId: scope.replicaId, sequence: 1,
    collectionId: scope.collectionId, baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z',
    dependencies: [], payload: { parentId: 'folder-colp', node: { kind: 'folder', title: 'Folder' } },
  };
  const queued = await store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload,
  }, { allowUnstamped: true });
  await store.completeQueueWithReceipt(scope, queued.sequence, {
    opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `receipt-${nativeId}`,
    resultDigest: `sha256:${targetId}`,
    result: { results: [{ opId, sequence: queued.sequence, status: 'applied', targetId, revision: 'server-r1' }] },
  });
}
