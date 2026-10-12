import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { createSyncStateStore, type JsonObject, type ScopeRecord } from '../src/sync-state-store.js';
import { bookmark, deterministicIds, fixture, folder, mapping, memoryApi, scope } from './bookmark-event-queue-harness.js';

async function seedTerminalCreate(store: ReturnType<typeof createSyncStateStore>, nativeId: string,
  colpId: string, parentColp: string, title: string, url: string) {
  const opId = `b3.audit.create.${nativeId}`;
  const payload: JsonObject = { type: 'create_node', opId, replicaId: scope.replicaId, sequence: 1,
    collectionId: scope.collectionId, baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z',
    dependencies: [], payload: { parentId: parentColp, node: { kind: 'bookmark', title, url } } };
  const queued = await store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`, status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload,
  }, { allowUnstamped: true });
  await store.completeQueueWithReceipt(scope, queued.sequence, {
    opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `receipt-${nativeId}`,
    resultDigest: `sha256:result-${nativeId}`, result: { results: [{ opId, sequence: queued.sequence,
      status: 'applied', targetId: colpId, revision: 'server-uploaded-r1' }] },
  });
}

async function unfreeze(store: ReturnType<typeof createSyncStateStore>) {
  const current = await store.getScope(scope) as ScopeRecord;
  const { scopeKey: _key, ...authority } = current;
  await store.registerScope({ ...authority, lifecycle: 'active' });
  await store.transitionEngine(scope, { phase: 'sleeping', updatedAt: Date.now(), recoveryFrozen: false,
    authorityRefreshRequired: false, notBefore: 0 });
}

describe('FR-F1-BOUNDARY-DELETE', () => {
  let indexedDB: IDBFactory;
  beforeEach(() => { indexedDB = new IDBFactory(); });

  test('AUDIT-01 deleting an unselected bookmark must not freeze the selected scope', async () => {
    const { store, queue } = await fixture(indexedDB);
    const result = await queue.removed('only-local', { parentId: 'root-unselected', index: 0,
      node: bookmark('only-local', 'root-unselected', 0, 'Local', 'https://example.test/local') });
    assert.equal(result.outcome, 'filtered');
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal((await store.listDeletionJournal(scope, 'only-local')).length, 0);
  });

  test('private and managed removals filter without queue or freeze', async () => {
    const { store, queue } = await fixture(indexedDB);
    const privateOut = await queue.removed('priv-child', { parentId: 'root-private', index: 0,
      node: bookmark('priv-child', 'root-private', 0, 'Private', 'https://example.test/private') });
    const managedOut = await queue.removed('managed-child', { parentId: 'root-selected', index: 0,
      node: { ...bookmark('managed-child', 'root-selected', 0, 'Managed', 'https://example.test/m'),
        unmodifiable: 'managed' } });
    assert.equal(privateOut.outcome, 'filtered');
    assert.equal(managedOut.outcome, 'filtered');
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await store.listQueue(scope)).length, 0);
    assert.equal((await store.listDeletionJournal(scope, 'priv-child')).length, 0);
    assert.equal((await store.listDeletionJournal(scope, 'managed-child')).length, 0);
  });

  test('in-scope mapped delete enqueues exactly one operation', async () => {
    const { store, queue } = await fixture(indexedDB, { mappedNode: true });
    const result = await queue.removed('mapped', { parentId: 'root-selected', index: 0,
      node: bookmark('mapped', 'root-selected', 0, 'Server before', 'https://example.test/before') });
    await queue.flush();
    assert.equal(result.outcome, 'staged');
    const records = await store.listQueue(scope);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.payload.type, 'delete_node');
    assert.equal(records[0]!.payload.targetId, 'mapped-colp');
  });

  test('in-scope identity-unknown still fail-closed and is reentrant', async () => {
    const { store, queue } = await fixture(indexedDB);
    const first = await queue.removed('ghost', { parentId: 'root-selected', index: 0 });
    const second = await queue.removed('ghost', { parentId: 'root-selected', index: 0 });
    assert.equal(first.outcome, 'identity_unproven');
    assert.equal(second.outcome, 'identity_unproven');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await store.listQueue(scope)).length, 0);
  });

  test('unknown ancestor walk fails closed instead of swallowing as out of scope', async () => {
    const { store, api } = await fixture(indexedDB);
    const rejecting = { ...api, async get(id: string) {
      if (id === 'gone-parent') throw new Error('Can not find bookmark for id.');
      return api.get(id);
    } };
    const queue = createBookmarkEventQueue({ scope, store, api: rejecting, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    const result = await queue.removed('mystery', { parentId: 'gone-parent', index: 0 });
    assert.equal(result.outcome, 'identity_unproven');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);
  });

  test('out-of-scope delete does not block the next in-scope create', async () => {
    const { store, queue, api } = await fixture(indexedDB);
    await queue.removed('only-local', { parentId: 'root-unselected', index: 0,
      node: bookmark('only-local', 'root-unselected', 0, 'Local', 'https://example.test/local') });
    const node = bookmark('legal-new', 'folder-parent', 0, 'Legal', 'https://example.test/legal');
    api.put(node);
    assert.equal((await queue.created(node.id, node)).outcome, 'staged');
    await queue.flush();
    assert.equal((await store.listQueue(scope)).some((row) => row.payload.type === 'create_node'), true);
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
  });
});

describe('FR-F2-CAPTURE-LOSS', () => {
  let indexedDB: IDBFactory;
  beforeEach(() => { indexedDB = new IDBFactory(); });

  test('AUDIT-02 completed first-run recovers a create lost before durable ingress', async () => {
    const { store, queue, api } = await fixture(indexedDB);
    await store.setFirstRun(scope, 'completed');
    await store.putMountBinding(scope, { mountId: 'audit-mount', nativeRootId: 'root-selected',
      remoteMountNodeId: (await store.getMappingByNativeId(scope, 'root-selected'))!.colpId,
      rootRole: 'bookmarks-bar', boundaryVersion: '1', materialized: false, status: 'active' });
    api.put(bookmark('missed-new', 'folder-parent', 0, 'New after onboarding', 'https://example.test/new'));
    await queue.recover();
    assert.equal((await store.listQueue(scope)).some((row) => row.payload.type === 'create_node'), true);
  });

  test('second recover after capture-loss does not duplicate nested folder and child', async () => {
    const { store, queue, api } = await fixture(indexedDB);
    await store.setFirstRun(scope, 'completed');
    api.put(folder('nested-missed', 'folder-parent', 0, 'Nested'));
    api.put(bookmark('nested-child', 'nested-missed', 0, 'Child', 'https://example.test/nested-child'));
    await queue.recover();
    const first = (await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length;
    assert.equal(first >= 1, true);
    await queue.recover();
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length, first);
  });

  test('unfreeze recovers a node added while frozen, second recover does not duplicate', async () => {
    const { store, queue, api } = await fixture(indexedDB);
    await store.setFirstRun(scope, 'completed');
    await freezeScopeRecovery(store, scope, 'deletion_identity_unproven');
    api.put(bookmark('during-freeze', 'folder-parent', 0, 'Frozen add', 'https://example.test/frozen-add'));
    await unfreeze(store);
    await queue.recover();
    const first = (await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length;
    assert.equal(first, 1);
    await queue.recover();
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length, 1);
  });
});

describe('FR-F2-RECEIPT-REPLAY', () => {
  let indexedDB: IDBFactory;
  beforeEach(() => { indexedDB = new IDBFactory(); });

  test('terminal receipt without mapping restores the same remote id and never creates twice', async () => {
    const { store, queue, api } = await fixture(indexedDB);
    await store.setFirstRun(scope, 'completed');
    await seedTerminalCreate(store, 'receipt-native', 'server-receipt-n',
      (await store.getMappingByNativeId(scope, 'folder-parent'))!.colpId, 'Receipt', 'https://example.test/receipt');
    api.put(bookmark('receipt-native', 'folder-parent', 0, 'Receipt', 'https://example.test/receipt'));
    await queue.recover();
    assert.equal((await store.getMappingByNativeId(scope, 'receipt-native'))?.colpId, 'server-receipt-n');
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node'
      && row.status !== 'terminal').length, 0);
    await queue.recover();
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node'
      && row.status !== 'terminal').length, 0);
  });

  test('create already queued is reused on recover', async () => {
    const { store, queue, api } = await fixture(indexedDB);
    await store.setFirstRun(scope, 'completed');
    const node = bookmark('queued-create', 'folder-parent', 0, 'Queued', 'https://example.test/queued');
    api.put(node);
    assert.equal((await queue.created(node.id, node)).outcome, 'staged');
    await queue.recover();
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length, 1);
  });

  test('sent create that lost its response is not created a second time', async () => {
    const { store, queue, api } = await fixture(indexedDB);
    await store.setFirstRun(scope, 'completed');
    const node = bookmark('sent-create', 'folder-parent', 0, 'Sent', 'https://example.test/sent');
    api.put(node);
    await queue.created(node.id, node);
    await queue.flush();
    const first = (await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node');
    assert.equal(first.length, 1);
    await queue.recover();
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length, 1);
  });

  test('same native string on a later generation does not reuse the prior receipt', async () => {
    const store = createSyncStateStore({ indexedDB: new IDBFactory() });
    const gen1 = scope; const gen2 = { ...scope, generation: 2 };
    await store.registerScope({ ...gen1, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'completed' });
    await store.putMountBinding(gen1, { mountId: 'm1', nativeRootId: '1', remoteMountNodeId: 'server-mount-bar',
      boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
    await store.putMapping(gen1, { nativeId: '1', colpId: 'server-mount-bar', rootNativeId: '1', nodeKind: 'folder',
      projection: { revision: 'r-bar', childrenRevision: 'children-r-bar', digest: 'sha256:bar',
        content: { title: 'Bar' } } });
    await seedTerminalCreate(store, 'reused-native', 'colp-gen1', 'server-mount-bar', 'Old', 'https://example.test/old');
    await store.registerScope({ ...gen2, lifecycle: 'active', lease: { leaseId: 'lease2', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'r2', cursor: 'c2' }, selectedRoots: [], rootStatus: 'ready', firstRun: 'completed' });
    await store.putMountBinding(gen2, { mountId: 'm2', nativeRootId: '1', remoteMountNodeId: 'server-mount-g2',
      boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
    await store.putMapping(gen2, { nativeId: '1', colpId: 'server-mount-g2', rootNativeId: '1', nodeKind: 'folder',
      projection: { revision: 'r-bar-2', childrenRevision: 'children-r-bar-2', digest: 'sha256:bar2',
        content: { title: 'Bar' } } });
    const api = memoryApi();
    api.put(folder('1', '0', 0, 'Bar'));
    api.put(bookmark('reused-native', '1', 0, 'New gen', 'https://example.test/new-gen'));
    const queue = createBookmarkEventQueue({ scope: gen2, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    await queue.recover();
    assert.notEqual((await store.getMappingByNativeId(gen2, 'reused-native'))?.colpId, 'colp-gen1');
    assert.equal((await store.listQueue(gen2)).some((row) => row.payload.type === 'create_node'), true);
  });
});

describe('FR-F5-DELETE-JOURNAL', () => {
  let indexedDB: IDBFactory;
  beforeEach(() => { indexedDB = new IDBFactory(); });

  test('AUDIT-03 mapped deletion without node payload enqueues from durable facts', async () => {
    const { store, queue } = await fixture(indexedDB, { mappedNode: true });
    await queue.removed('mapped', { parentId: 'root-selected', index: 0 });
    await queue.flush();
    assert.equal((await store.listQueue(scope)).some((row) => row.payload.type === 'delete_node'), true);
  });

  test('null payload matches undefined payload for a mapped bookmark', async () => {
    const { store, queue } = await fixture(indexedDB, { mappedNode: true });
    await queue.removed('mapped', { parentId: 'root-selected', index: 0, node: null });
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.payload.type, 'delete_node');
  });

  test('complete payload still enqueues delete_node', async () => {
    const { store, queue } = await fixture(indexedDB, { mappedNode: true });
    await queue.removed('mapped', { parentId: 'root-selected', index: 0,
      node: bookmark('mapped', 'root-selected', 0, 'Server before', 'https://example.test/before') });
    await queue.flush();
    assert.equal((await store.listQueue(scope)).some((row) => row.payload.type === 'delete_node'), true);
  });

  test('folder subtree uses journal and mapping without guessing unmapped siblings', async () => {
    const { store, queue } = await fixture(indexedDB);
    await mapping(store, 'folder-parent', 'folder-colp', 'root-selected', 'folder-r1', { title: 'Parent' },
      'root-selected');
    await mapping(store, 'child-a', 'child-colp', 'root-selected', 'child-r1',
      { title: 'Child', url: 'https://c.example' }, 'folder-parent');
    const outcome = await queue.removed('folder-parent', { parentId: 'root-selected', index: 0 });
    await queue.flush();
    assert.equal(outcome.outcome, 'staged');
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.payload.type, 'delete_subtree');
    assert.equal(queued[0]!.payload.targetId, 'folder-colp');
    const journal = await store.listDeletionJournal(scope);
    assert.equal(journal.some((row) => row.nativeId === 'child-a'), true);
    assert.equal(journal.some((row) => row.nativeId === 'unknown-sibling'), false);
  });

  test('child-only evidence after parent deletion does not batch-delete the folder', async () => {
    const { store, queue } = await fixture(indexedDB);
    await mapping(store, 'child-a', 'child-colp', 'root-selected', 'child-r1',
      { title: 'Child', url: 'https://c.example' }, 'folder-parent');
    const outcome = await queue.removed('child-a', { parentId: 'folder-parent', index: 0 });
    await queue.flush();
    assert.equal(outcome.outcome, 'staged');
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.payload.type, 'delete_node');
    assert.equal(queued[0]!.payload.targetId, 'child-colp');
  });

  test('selected root removal stays filtered', async () => {
    const { store, queue, api } = await fixture(indexedDB);
    api.put(folder('root-selected', '1', 0, 'Selected root'));
    const outcome = await queue.removed('root-selected', { parentId: '1', index: 0, node: api.node('root-selected') });
    await queue.flush();
    assert.equal(outcome.outcome, 'filtered');
    assert.deepEqual(await store.listQueue(scope), []);
  });
});
