import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { pendingLocalContentFields } from '../src/pull-queue-facts.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

const mapping = { colpId: 'node-1', nativeId: 'native-1' };

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('snapshot cutover stamps terminal echoApplied so a historical title cannot overlay later remote content', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01') },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [],
  });
  await store.putMapping(scope, {
    nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'sha256:old-root' },
  });
  await store.putMapping(scope, {
    nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'native-root', nodeKind: 'bookmark',
    parentNativeId: 'native-root', parentColpId: 'old-root',
    projection: { revision: 'r1', digest: 'sha256:old', content: { title: 'Old local title' } },
  });
  await store.configureBrowserRoots(scope, {
    discovered: [{ nativeId: 'native-root', ancestorNativeIds: [] }],
    selectedNativeIds: ['native-root'], privateNativeIds: [], status: 'ready',
  });
  const queued = await store.allocateSequenceAndEnqueue(scope, {
    opId: 'old-local-update', batchId: 'batch-old', idempotencyKey: 'key-old',
    digest: 'sha256:old', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-0', operationRevision: 'local-old', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'node-1',
      payload: { base: { title: 'Original' }, value: { title: 'Old local title' } } },
  }, { allowUnstamped: true });
  await store.completeQueueWithReceipt(scope, queued.sequence, {
    opId: queued.opId, operationDigest: queued.digest, kind: 'terminal',
    receiptId: 'receipt-old', resultDigest: 'sha256:result',
  });
  assert.notEqual((await store.getQueueByOpId(scope, queued.opId))?.echoApplied, true);
  assert.deepEqual(await pendingLocalContentFields(store, scope, mapping), { title: 'Old local title' });

  await store.stageRecoveryPage(scope, {
    snapshotId: 'snap-cutover', revision: 'r2', syncCursor: 'spc2.after', identityDigest: 'identity-cutover',
    rootNodeId: 'node-r', page: 0, pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: null,
    complete: true,
    nodes: [
      {
        colpId: 'node-r', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:n',
        mapping: {
          nativeId: 'native-root', colpId: 'node-r', rootNativeId: 'native-root', nodeKind: 'folder',
          projection: { revision: 'r2', digest: 'sha256:new-root' },
        },
      },
      {
        colpId: 'node-1', parentId: 'node-r', position: 'b', kind: 'Bookmark', payloadDigest: 'sha256:n1',
        mapping: {
          nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'native-root', nodeKind: 'bookmark',
          parentNativeId: 'native-root', parentColpId: 'node-r',
          projection: { revision: 'r2', digest: 'sha256:remote', content: { title: 'Remote after' } },
        },
      },
    ],
  });
  await store.commitRecovery(scope, 'snap-cutover');

  const after = await store.exportScope(scope);
  assert.equal(after.cursor?.cursor, 'spc2.after');
  assert.equal(after.pullEvents.length, 0);
  assert.equal((await store.getQueueByOpId(scope, queued.opId))?.echoApplied, true);
  assert.deepEqual(await pendingLocalContentFields(store, scope, mapping), {});
});

test('authority rebase stamps terminal echoApplied when it discards a blocked own-echo page', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01') },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [],
  });
  await store.putMapping(scope, {
    nativeId: 'native-root', colpId: 'old-root', rootNativeId: 'native-root', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'sha256:old-root' },
  });
  await store.putMapping(scope, {
    nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'native-root', nodeKind: 'bookmark',
    parentNativeId: 'native-root', parentColpId: 'old-root',
    projection: { revision: 'r1', digest: 'sha256:old', content: { title: 'Old local title' } },
  });
  const queued = await store.allocateSequenceAndEnqueue(scope, {
    opId: 'old-local-update', batchId: 'batch-old', idempotencyKey: 'key-old',
    digest: 'sha256:old', endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-0', operationRevision: 'local-old', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'node-1',
      payload: { base: { title: 'Original' }, value: { title: 'Old local title' } } },
  }, { allowUnstamped: true });
  await store.completeQueueWithReceipt(scope, queued.sequence, {
    opId: queued.opId, operationDigest: queued.digest, kind: 'terminal',
    receiptId: 'receipt-old', resultDigest: 'sha256:result',
  });
  const stagedEvent = {
    eventId: 'own-echo', cursor: 'cursor-blocked', operationId: queued.opId, effectId: queued.opId,
    effectDigest: 'sha256:effect', operationDigest: queued.digest, kind: 'node_content_updated', payload: {},
  };
  await store.stagePullPage(scope, {
    pageId: 'page-blocked', previousCursor: 'cursor-0', nextCursor: 'cursor-blocked',
    collectionRevision: 'revision-blocked', pageDigest: 'sha256:blocked', events: [stagedEvent],
  });
  await store.preparePullIntent(scope, 'own-echo', {
    intentId: 'intent:own-echo', correlationId: 'correlation-blocked', operationId: queued.opId,
    eventId: 'own-echo', effectId: queued.opId, expected: { kind: 'update', nativeId: 'native-1' },
    expiresAt: Date.now() + 300_000, state: 'intent_prepared', generation: 1,
  });
  await store.putMapping(scope, {
    nativeId: 'native-blocker', colpId: 'node-created-77', rootNativeId: 'native-root', nodeKind: 'bookmark',
    projection: { revision: 'r1', digest: 'sha256:blocker' },
  });
  await store.commitPullEvent(scope, 'own-echo', { mappings: [{
    nativeId: 'native-race', colpId: 'node-created-77', rootNativeId: 'native-root', nodeKind: 'bookmark',
    projection: { revision: 'revision-blocked', digest: 'sha256:race' },
  }] });
  await assert.rejects(() => store.completePullPage(scope, 'page-blocked'), /recovery_required/u);
  assert.deepEqual(await pendingLocalContentFields(store, scope, mapping), {},
    'a still-stored own-echo event currently excludes the terminal title');
  await store.transitionEngine(scope, {
    phase: 'recovery', updatedAt: 1, recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0,
  });
  await store.rebaseActiveSessionAuthority(scope, {
    cursor: 'cursor-rebased', serverRevision: 'revision-rebased',
  });
  const after = await store.exportScope(scope);
  assert.equal(after.cursor?.cursor, 'cursor-rebased');
  assert.equal(after.pullEvents.length, 0);
  assert.equal((await store.getQueueByOpId(scope, queued.opId))?.echoApplied, true);
  assert.deepEqual(await pendingLocalContentFields(store, scope, mapping), {});
});

test('snapshot projection publishes snapshot title and URL before terminal echoApplied, while a non-terminal edit still overlays', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01') },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [],
  });
  const root: MappingInput = {
    nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'sha256:root', content: { title: 'Root' } },
  };
  const settledLive = liveBookmark('2', 'settled', 'Old settled title', 'https://old.example/settled');
  const liveEdit = liveBookmark('3', 'live', 'Old live title', 'https://old.example/live');
  await store.putMapping(scope, root);
  await store.putMapping(scope, settledLive);
  await store.putMapping(scope, liveEdit);
  await store.configureBrowserRoots(scope, {
    discovered: [{ nativeId: '1', ancestorNativeIds: [] }],
    selectedNativeIds: ['1'], privateNativeIds: [], status: 'ready',
  });
  const settledQueued = await enqueueContent(store, 'settled-history', 'settled',
    'Old settled title', 'https://old.example/settled', true);
  const liveQueued = await enqueueContent(store, 'live-edit', 'live',
    'Outstanding live title', 'https://local.example/live', false);
  assert.notEqual((await store.getQueueByOpId(scope, settledQueued.opId))?.echoApplied, true);
  assert.deepEqual(await pendingLocalContentFields(store, scope, { colpId: 'settled', nativeId: '2' }),
    { title: 'Old settled title', url: 'https://old.example/settled' });

  const stagedRoot: MappingInput = {
    ...root, nativeId: 'recovery:root', rootNativeId: 'recovery:root',
    projection: { revision: 'r2', digest: 'sha256:root-2', content: { title: 'Root' } },
  };
  const stagedSettled = stagedBookmark('settled', 'Snapshot settled title', 'https://snapshot.example/settled');
  const stagedLive = stagedBookmark('live', 'Snapshot live title', 'https://snapshot.example/live');
  await store.stageRecoveryPage(scope, {
    snapshotId: 'snap-project', revision: 'r2', syncCursor: 'spc2.after', identityDigest: 'identity-project',
    rootNodeId: 'root', page: 0, pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: null,
    complete: true,
    nodes: [
      { colpId: 'root', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:root', mapping: stagedRoot },
      { colpId: 'settled', parentId: 'root', position: 'b', kind: 'Bookmark', payloadDigest: 'sha256:settled',
        mapping: stagedSettled },
      { colpId: 'live', parentId: 'root', position: 'c', kind: 'Bookmark', payloadDigest: 'sha256:live',
        mapping: stagedLive },
    ],
  });
  const chrome = fakeChrome([
    { id: '1', title: 'Root' },
    { id: '2', parentId: '1', index: 0, title: 'Old settled title', url: 'https://old.example/settled' },
    { id: '3', parentId: '1', index: 1, title: 'Old live title', url: 'https://old.example/live' },
  ]);
  const projected = await recoverVerifiedOrFreeze({
    scope, store, api: chrome.api, freezeUnprovenIdentity: true,
    staged: [stagedRoot, stagedSettled, stagedLive],
  });
  assert.notEqual((await store.getQueueByOpId(scope, settledQueued.opId))?.echoApplied, true);
  assert.equal(chrome.nodes.get('2')?.title, 'Snapshot settled title');
  assert.equal(chrome.nodes.get('2')?.url, 'https://snapshot.example/settled');
  assert.equal(chrome.nodes.get('3')?.title, 'Outstanding live title');
  assert.equal(chrome.nodes.get('3')?.url, 'https://local.example/live');
  assert.deepEqual(nativeFields(projected.find((item) => item.colpId === 'settled')),
    { title: 'Snapshot settled title', url: 'https://snapshot.example/settled' });
  assert.deepEqual(nativeFields(projected.find((item) => item.colpId === 'live')),
    { title: 'Outstanding live title', url: 'https://local.example/live' });

  await store.finalizeRecoveryMappings(scope, 'snap-project', projected);
  await store.commitRecovery(scope, 'snap-project');
  assert.deepEqual(nativeFields(await store.getMappingByColpId(scope, 'settled')),
    { title: 'Snapshot settled title', url: 'https://snapshot.example/settled' });
  assert.deepEqual(nativeFields(await store.getMappingByColpId(scope, 'live')),
    { title: 'Outstanding live title', url: 'https://local.example/live' });
  assert.equal(chrome.nodes.get('2')?.title, 'Snapshot settled title');
  assert.equal(chrome.nodes.get('2')?.url, 'https://snapshot.example/settled');
  assert.equal((await store.getQueueByOpId(scope, settledQueued.opId))?.echoApplied, true);
  assert.notEqual((await store.getQueueByOpId(scope, liveQueued.opId))?.echoApplied, true);
  assert.deepEqual(await pendingLocalContentFields(store, scope, { colpId: 'settled', nativeId: '2' }), {});
  assert.deepEqual(await pendingLocalContentFields(store, scope, { colpId: 'live', nativeId: '3' }),
    { title: 'Outstanding live title', url: 'https://local.example/live' });
});

test('one bookmark keeps a later non-terminal edit over the snapshot and the older terminal payload before commitRecovery', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01') },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [],
  });
  const root: MappingInput = {
    nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'sha256:root', content: { title: 'Root' } },
  };
  const live = liveBookmark('2', 'one', 'Older terminal title', 'https://terminal.example/one');
  await store.putMapping(scope, root);
  await store.putMapping(scope, live);
  await store.configureBrowserRoots(scope, {
    discovered: [{ nativeId: '1', ancestorNativeIds: [] }],
    selectedNativeIds: ['1'], privateNativeIds: [], status: 'ready',
  });
  const terminalQueued = await enqueueContent(store, 'terminal-history', 'one',
    'Older terminal title', 'https://terminal.example/one', true);
  const laterQueued = await enqueueContent(store, 'later-edit', 'one',
    'Outstanding one title', 'https://outstanding.example/one', false);
  assert.ok(laterQueued.sequence > terminalQueued.sequence);
  assert.notEqual((await store.getQueueByOpId(scope, terminalQueued.opId))?.echoApplied, true);

  const stagedRoot: MappingInput = {
    ...root, nativeId: 'recovery:root', rootNativeId: 'recovery:root',
    projection: { revision: 'r2', digest: 'sha256:root-2', content: { title: 'Root' } },
  };
  const stagedOne = stagedBookmark('one', 'Snapshot one title', 'https://snapshot.example/one');
  await store.stageRecoveryPage(scope, {
    snapshotId: 'snap-one', revision: 'r2', syncCursor: 'spc2.one', identityDigest: 'identity-one',
    rootNodeId: 'root', page: 0, pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: null,
    complete: true,
    nodes: [
      { colpId: 'root', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:root',
        mapping: stagedRoot },
      { colpId: 'one', parentId: 'root', position: 'b', kind: 'Bookmark', payloadDigest: 'sha256:one',
        mapping: stagedOne },
    ],
  });
  const chrome = fakeChrome([
    { id: '1', title: 'Root' },
    { id: '2', parentId: '1', index: 0, title: 'Older terminal title', url: 'https://terminal.example/one' },
  ]);
  const projected = await recoverVerifiedOrFreeze({
    scope, store, api: chrome.api, freezeUnprovenIdentity: true, staged: [stagedRoot, stagedOne],
  });
  const outstanding = { title: 'Outstanding one title', url: 'https://outstanding.example/one' };
  assert.notEqual((await store.getQueueByOpId(scope, terminalQueued.opId))?.echoApplied, true);
  assert.equal(chrome.nodes.get('2')?.title, outstanding.title);
  assert.equal(chrome.nodes.get('2')?.url, outstanding.url);
  assert.deepEqual(nativeFields(projected.find((item) => item.colpId === 'one')), outstanding);
  assert.deepEqual(nativeFields(await store.getMappingByColpId(scope, 'one')), outstanding);
});

function liveBookmark(nativeId: string, colpId: string, title: string, url: string): MappingInput {
  return {
    nativeId, colpId, rootNativeId: '1', nodeKind: 'bookmark', parentNativeId: '1', parentColpId: 'root',
    projection: { revision: 'r1', digest: `sha256:${colpId}`, content: { title, url } },
  };
}

function stagedBookmark(colpId: string, title: string, url: string): MappingInput {
  return {
    nativeId: `recovery:${colpId}`, colpId, rootNativeId: 'recovery:root', nodeKind: 'bookmark', parentColpId: 'root',
    projection: { revision: 'r2', digest: `sha256:${colpId}-2`, content: { title, url } },
  };
}

function nativeFields(mapping: MappingInput | null | undefined) {
  return { title: mapping?.projection.content?.title, url: mapping?.projection.content?.url };
}

async function enqueueContent(store: ReturnType<typeof createSyncStateStore>, opId: string, targetId: string,
  title: string, url: string, terminal: boolean) {
  const queued = await store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: `batch-${opId}`, idempotencyKey: `key-${opId}`,
    digest: `sha256:${opId}`, endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-0', operationRevision: `local-${opId}`, status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId,
      payload: { base: { title: 'Original', url: 'https://original.example' }, value: { title, url } } },
  }, { allowUnstamped: true });
  if (!terminal) return queued;
  await store.completeQueueWithReceipt(scope, queued.sequence, {
    opId: queued.opId, operationDigest: queued.digest, kind: 'terminal',
    receiptId: `receipt-${opId}`, resultDigest: 'sha256:result',
  });
  return queued;
}
