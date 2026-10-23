import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { executeRemoteDeleteMembers, hasTerminalDeleteEvidence } from '../src/native-delete-executor.js';
import type { PullBookmarkApi } from '../src/pull-applier-types.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = { environment: 'production', serverId: 's', serverOrigin: 'https://known.example',
  accountId: 'a', browserProfileId: 'p', collectionId: 'c', replicaId: 'r', generation: 1 };
async function fixture() {
  const indexedDB = new IDBFactory(), store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'l', expiresAt: Date.now() + 60000 },
    checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: ['root'], rootStatus: 'ready' });
  await store.createApplyIntent(scope, { intentId: 'delete', correlationId: 'corr', operationId: 'op',
    expected: { kind: 'delete', nativeId: 'n0' }, expiresAt: Date.now() + 60000 });
  return { store, indexedDB };
}

test('large deletes resume after restart with bounded records and one delete per member', async () => {
  const f = await fixture(); let store = f.store;
  const nodes = new Map<string, { id: string; parentId: string; title: string; url: string }>();
  const mappings: MappingInput[] = [];
  for (let i = 0; i < 800; i++) {
    const node = { id: `n${i}`, parentId: 'root', title: `bookmark ${i}`, url: `https://example.test/?q=${'x'.repeat(300)}` };
    nodes.set(node.id, node);
    mappings.push({ nativeId: node.id, colpId: `c${i}`, rootNativeId: 'root', nodeKind: 'bookmark',
      projection: { revision: 'r', digest: 'sha256:x', content: { title: node.title, url: node.url } } });
  }
  const deleted = new Set<string>();
  const api = { get: async (id: string) => nodes.has(id) ? [nodes.get(id)!] : [], getChildren: async () => [],
    remove: async (id: string) => { assert.ok(!deleted.has(id)); deleted.add(id); nodes.delete(id); } } as unknown as PullBookmarkApi;
  const input = { scope, api, mounts: [], intentId: 'delete',
    members: mappings.map(({ nativeId, colpId }) => ({ nativeId, colpId })), mappings, writable: true };
  try {
    await assert.rejects(executeRemoteDeleteMembers({ ...input, store, crash: () => {
      if (deleted.size === 525) throw new Error('worker_crash');
    } }), /worker_crash/);
    store.close(); store = createSyncStateStore({ indexedDB: f.indexedDB });
    const outcome = await executeRemoteDeleteMembers({ ...input, store });
    assert.equal(outcome.deletedNativeIds.length, 800); assert.equal(nodes.size, 0); assert.equal(deleted.size, 800);
    const intent = (await store.getApplyIntent(scope, 'delete'))!;
    assert.ok(hasTerminalDeleteEvidence(intent)); assert.ok(JSON.stringify(intent).length < 2048);
    const members = await store.listDeleteMembers(scope, 'delete');
    assert.equal(members.length, 800); assert.ok(JSON.stringify(members).length > 256 * 1024);
    assert.ok(members.every(row => row.preimage?.url && JSON.stringify(row).length < 2048));
    assert.equal(await store.discardAppliedRemoteDeleteEcho(scope, 'n799'), true);
    const db = await store.open(), tx = db.transaction('apply_intents', 'readwrite');
    const complete = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    tx.objectStore('apply_intents').put({ ...intent, state: 'page_complete', expiresAt: 1 }); await complete;
    assert.equal((await store.pruneExpiredCompletedApplyIntents(scope)).deleted, 1);
    assert.equal((await store.listDeleteMembers(scope, 'delete')).length, 0);
  } finally { store.close(); }
}, 20000);

test('legacy partial deletes migrate receipts and preimages atomically', async () => {
  const { store } = await fixture();
  try {
    await store.persistApplyIntentFacts(scope, 'delete', { liveWorkKind: 'delete', anchors: {
      deleteMemberSet: [{ colpId: 'old', nativeId: 'old-native' }, { colpId: 'next', nativeId: 'next-native' }],
      deleteMemberResults: { old: 'applied', next: 'not_started' },
      deletePreimages: { old: { title: 'Saved title', url: 'https://example.test/saved' } },
    } });
    const rows = await store.prepareDeleteMembers(scope, 'delete', [{ colpId: 'different', nativeId: 'different' }]);
    assert.deepEqual(rows.map(row => row.colpId), ['old', 'next']);
    assert.equal(rows[0]?.result, 'applied'); assert.equal(rows[0]?.preimage?.title, 'Saved title');
    assert.equal((await store.getApplyIntent(scope, 'delete'))?.anchors?.deletePreimages, undefined);
    await store.saveDeleteMember(scope, 'delete', 'next', { result: 'absent' });
    assert.ok(hasTerminalDeleteEvidence((await store.getApplyIntent(scope, 'delete'))!));
    await store.saveDeleteMember(scope, 'delete', 'next', { result: 'absent' });
    assert.ok(hasTerminalDeleteEvidence((await store.getApplyIntent(scope, 'delete'))!));
  } finally { store.close(); }
});
