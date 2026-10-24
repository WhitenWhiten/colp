import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';

/**
 * W2A-09: a recovery that dropped an apply intent (the authority rebase for a not-called event, the Snapshot
 * cutover for every intent it supersedes) left the intent's `remote_delete_members` behind, the sibling of the
 * pull-side cleanup. An orphan member row is an integrity fault (`orphan_delete_member`).
 */
const scope: SyncScope = Object.freeze({ environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a', replicaId: 'replica-a', generation: 1 });
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function fixture() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01') },
    checkpoint: { cursor: 'cursor-old', serverRevision: 'revision-0' }, selectedRoots: [] });
  const key = (await store.getScope(scope))!.scopeKey;
  return { store, key };
}

/** A staged, never-called pull event with its apply intent and two delete members. */
async function stageNotCalledDelete(store: ReturnType<typeof createSyncStateStore>, key: string) {
  const tx = (await store.open()).transaction([STORES.pullPages, STORES.pullEvents, STORES.intents, STORES.deleteMembers], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORES.pullPages).put({ scopeKey: key, pageId: 'page-1', state: 'staged', previousCursor: 'cursor-old', nextCursor: 'cursor-next' });
  tx.objectStore(STORES.pullEvents).put({ scopeKey: key, eventId: 'event-1', pageId: 'page-1', state: 'staged', intentId: 'intent-1',
    operationId: 'remote-op-1' });
  tx.objectStore(STORES.intents).put({ scopeKey: key, intentId: 'intent-1', eventId: 'event-1', correlationId: 'correlation-1',
    state: 'staged', nativeResult: 'not_started', expiresAt: Date.now() + 60_000, expected: { nativeId: 'native-1' } });
  for (const colpId of ['node-1', 'node-2']) {
    tx.objectStore(STORES.deleteMembers).put({ scopeKey: key, intentId: 'intent-1', colpId, nativeId: `native-${colpId}`, result: 'not_started' });
  }
  await done;
}
const members = async (store: ReturnType<typeof createSyncStateStore>, key: string) => (await store.exportScope(scope)).deleteMembers
  .filter(row => (row as { scopeKey: string }).scopeKey === key);

test('an authority rebase that retires a never-called delete takes its members with it', async () => {
  const { store, key } = await fixture();
  await store.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true, authorityRefreshRequired: true,
    notBefore: 0, lastError: 'stale_replica' });
  await stageNotCalledDelete(store, key);
  assert.equal((await members(store, key)).length, 2);
  await store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-new', serverRevision: 'revision-1' });
  const exported = await store.exportScope(scope);
  assert.equal(exported.intents.length, 0, 'the intent was retired');
  assert.equal(exported.deleteMembers.length, 0, 'and its members with it');
});

test('a Snapshot cutover takes the members of every intent it supersedes', async () => {
  const { store, key } = await fixture();
  await store.putMapping(scope, { nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'sha256:old-root' } });
  await store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
    selectedNativeIds: ['native-root'], privateNativeIds: [], status: 'ready' });
  await stageNotCalledDelete(store, key);
  await store.stageRecoveryPage(scope, { snapshotId: 'snap-1', revision: 'r2', syncCursor: 'spc2.after', identityDigest: 'identity-1',
    rootNodeId: 'node-r', page: 0, pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: null, complete: true,
    nodes: [{ colpId: 'node-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:n',
      mapping: { nativeId: 'native-root', colpId: 'node-r', rootNativeId: 'native-root', nodeKind: 'folder',
        projection: { revision: 'r2', digest: 'sha256:new-root' } } }] });
  await store.commitRecovery(scope, 'snap-1');
  const exported = await store.exportScope(scope);
  assert.equal(exported.intents.length, 0);
  assert.equal(exported.deleteMembers.length, 0);
  assert.deepEqual(await store.auditIntegrity(), { outcome: 'valid' });
});
