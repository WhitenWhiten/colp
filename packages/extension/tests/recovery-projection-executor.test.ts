/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';
import { clampRecoveryCreateIndex, collectNativeFacts, executeProjectionIntents,
  projectVirtualSnapshotChildren, recoverSnapshotProjection } from '../src/recovery-projection-executor.js';
import { createProjectionSuppression, type ProjectionIntentRecord } from '../src/recovery-overlay.js';
import { leftoverVirtualChildrenNeedReproject, recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = {
  environment: 'development', serverId: 'server-recovery', serverOrigin: 'https://known.example',
  accountId: 'account-recovery', browserProfileId: 'profile-recovery', collectionId: 'collection-recovery',
  replicaId: 'replica-recovery', generation: 1,
};

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('clamps recovery create indexes to the current Chrome child boundary', () => {
  assert.equal(clampRecoveryCreateIndex(undefined, 0), undefined);
  assert.equal(clampRecoveryCreateIndex(0, 0), 0);
  assert.equal(clampRecoveryCreateIndex(9, 2), 2);
});

test('collects nested native facts with authoritative sibling indexes', async () => {
  const chrome = fakeChrome([
    { id: '1', title: 'Know-N' },
    { id: '2', parentId: '1', index: 1, title: 'Folder' },
    { id: '3', parentId: '1', index: 0, title: 'First', url: 'https://first.example' },
    { id: '4', parentId: '2', index: 0, title: 'Nested', url: 'https://nested.example' },
  ]);

  assert.deepEqual(await collectNativeFacts(chrome.api, '1'), [
    { nativeId: '1', title: 'Know-N', index: 0, folder: true },
    { nativeId: '3', title: 'First', url: 'https://first.example', parentNativeId: '1', index: 0, folder: false },
    { nativeId: '2', title: 'Folder', parentNativeId: '1', index: 1, folder: true },
    { nativeId: '4', title: 'Nested', url: 'https://nested.example', parentNativeId: '2', index: 0, folder: false },
  ]);
});

test('executes create, update, move and delete then is idempotent after crash', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-recovery', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['root'], rootStatus: 'ready',
  });
  const root: MappingInput = {
    nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'd-root', content: { title: 'Root' } },
  };
  const stale: MappingInput = {
    nativeId: '2', colpId: 'stale', rootNativeId: '1', nodeKind: 'bookmark', parentNativeId: '1', parentColpId: 'root',
    projection: { revision: 'r1', digest: 'd-stale', content: { title: 'Stale', url: 'https://old.example' } },
  };
  await store.putMapping(scope, root);
  await store.putMapping(scope, stale);
  const chrome = fakeChrome([
    { id: '1', title: 'Root' },
    { id: '2', parentId: '1', index: 0, title: 'Stale', url: 'https://old.example' },
  ]);
  const created: MappingInput = {
    nativeId: 'recovery:fresh', colpId: 'fresh', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
    parentColpId: 'root', projection: { revision: 'r2', digest: 'd-fresh', content: { title: 'Fresh', url: 'https://new.example' } },
  };
  chrome.crashOn.create = 1;
  await store.stageRecoveryPage(scope, {
    snapshotId: 'snap-1', revision: 'r2', syncCursor: 'spc2.1', identityDigest: 'id-1',
    rootNodeId: 'root', page: 0, pageDigest: 'sha256:p0', previousPageDigest: null, nextCursor: null, complete: true,
    nodes: [
      { colpId: 'root', parentId: null, position: 'a', kind: 'Folder', payloadDigest: 'sha256:root', mapping: root },
      { colpId: 'fresh', parentId: 'root', position: 'b', kind: 'Bookmark', payloadDigest: 'sha256:fresh', mapping: created },
    ],
  });
  await assert.rejects(() => recoverSnapshotProjection({
    scope, store, staged: [root, created], api: chrome.api,
  }), /chrome_crash/);
  const mid = await store.listProjectionIntents(scope);
  assert.ok(mid.some((intent) => intent.kind === 'create' && intent.state !== 'terminal'));
  chrome.crashOn.create = 0;
  const projected = await recoverSnapshotProjection({
    scope, store, staged: [root, created], api: chrome.api,
  });
  assert.equal(projected.find((mapping) => mapping.colpId === 'fresh')?.nativeId, '3');
  assert.equal(chrome.nodes.has('2'), false);
  assert.equal(chrome.nodes.get('3')?.title, 'Fresh');
  const again = await executeProjectionIntents({
    scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: projected,
  });
  assert.equal(again.find((mapping) => mapping.colpId === 'fresh')?.nativeId, '3');
  assert.equal(chrome.creates, 1);
});

test('treats already-present and already-deleted Chrome facts as terminal', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-recovery', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['root'], rootStatus: 'ready',
  });
  const root: MappingInput = {
    nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'd-root', content: { title: 'Root' } },
  };
  await store.putMapping(scope, root);
  const intents: ProjectionIntentRecord[] = [
    {
      intentId: 'create:dup', kind: 'create', colpId: 'dup', order: 1, suppression: 'recovery:create:dup',
      generation: 1, state: 'pending', parentNativeId: '1', title: 'Dup', url: 'https://dup.example',
    },
    {
      intentId: 'delete:missing', kind: 'delete', colpId: 'missing', order: 2, suppression: 'recovery:delete:missing',
      generation: 1, state: 'pending', nativeId: '99', folder: false,
    },
  ];
  await store.replaceProjectionIntents(scope, intents);
  const chrome = fakeChrome([
    { id: '1', title: 'Root' },
    { id: '8', parentId: '1', index: 0, title: 'Dup', url: 'https://dup.example' },
  ]);
  const mapped = await executeProjectionIntents({
    scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: [root, {
      nativeId: 'recovery:dup', colpId: 'dup', rootNativeId: '1', nodeKind: 'bookmark', parentColpId: 'root',
      projection: { revision: 'r2', digest: 'd-dup', content: { title: 'Dup', url: 'https://dup.example' } },
    }],
  });
  assert.equal(chrome.creates, 1);
  assert.notEqual(mapped.find((mapping) => mapping.colpId === 'dup')?.nativeId, '8');
  assert.equal((await store.listProjectionIntents(scope)).every((intent) => intent.state === 'terminal'), true);
});

test('FRR-03: multiple equal local siblings keep independent projection instead of freezing', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-ambiguous', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['root'], rootStatus: 'ready',
  });
  const root: MappingInput = { nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'd-root', content: { title: 'Know-N' } } };
  await store.replaceProjectionIntents(scope, [{
    intentId: 'create:duplicate', kind: 'create', colpId: 'duplicate', order: 1,
    suppression: createProjectionSuppression('1', 'Duplicate'), generation: 1, state: 'pending',
    parentColpId: 'root', parentNativeId: '1', title: 'Duplicate', folder: true,
  }, {
    intentId: 'create:unrelated', kind: 'create', colpId: 'unrelated', order: 2,
    suppression: createProjectionSuppression('1', 'Unrelated'), generation: 1, state: 'pending',
    parentColpId: 'root', parentNativeId: '1', title: 'Unrelated', folder: false, url: 'https://unrelated.example.test/',
  }]);
  const chrome = fakeChrome([{ id: '1', title: 'Know-N' },
    { id: '2', parentId: '1', index: 0, title: 'Duplicate' },
    { id: '3', parentId: '1', index: 1, title: 'Duplicate' }]);

  await executeProjectionIntents({ scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: [root, {
    nativeId: 'recovery:duplicate', colpId: 'duplicate', rootNativeId: '1', nodeKind: 'folder', parentColpId: 'root',
    projection: { revision: 'r2', digest: 'd-dup', content: { title: 'Duplicate' } },
  }, {
    nativeId: 'recovery:unrelated', colpId: 'unrelated', rootNativeId: '1', nodeKind: 'bookmark', parentColpId: 'root',
    projection: { revision: 'r3', digest: 'd-unrel', content: { title: 'Unrelated', url: 'https://unrelated.example.test/' } },
  }] });
  assert.equal((await store.listProjectionIntents(scope)).every((intent) => intent.state === 'terminal'), true);
  assert.ok(await store.getMappingByColpId(scope, 'duplicate'));
  assert.ok(await store.getMappingByColpId(scope, 'unrelated'));
  assert.equal(chrome.creates, 2);
});

test('persists a resolved parent correlation before creating a nested child', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-nested', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: ['root'], rootStatus: 'ready',
  });
  const mappings: MappingInput[] = [{
    nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'd-root', content: { title: 'Root' } },
  }, {
    nativeId: 'recovery:folder', colpId: 'folder', rootNativeId: '1', nodeKind: 'folder',
    parentColpId: 'root', projection: { revision: 'r2', digest: 'd-folder', content: { title: 'Folder' } },
  }, {
    nativeId: 'recovery:child', colpId: 'child', rootNativeId: '1', nodeKind: 'bookmark',
    parentColpId: 'folder', projection: { revision: 'r3', digest: 'd-child',
      content: { title: 'Child', url: 'https://child.example' } },
  }];
  await store.putMapping(scope, mappings[0]!);
  await store.replaceProjectionIntents(scope, [{
    intentId: 'create:folder', kind: 'create', colpId: 'folder', order: 1,
    suppression: createProjectionSuppression('1', 'Folder'), generation: 1, state: 'pending',
    parentColpId: 'root', parentNativeId: '1', title: 'Folder', folder: true,
  }, {
    intentId: 'create:child', kind: 'create', colpId: 'child', order: 2,
    suppression: 'recovery:create:child', generation: 1, state: 'pending',
    parentColpId: 'folder', title: 'Child', url: 'https://child.example', folder: false,
  }]);
  const chrome = fakeChrome([{ id: '1', title: 'Root' }]);
  const projected = await executeProjectionIntents({
    scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: mappings,
  });
  const folder = projected.find((mapping) => mapping.colpId === 'folder');
  const child = projected.find((mapping) => mapping.colpId === 'child');
  assert.equal(chrome.nodes.get(child!.nativeId)?.parentId, folder!.nativeId);
  const childIntent = (await store.listProjectionIntents(scope)).find((intent) => intent.colpId === 'child');
  assert.equal(childIntent?.suppression,
    createProjectionSuppression(folder!.nativeId, 'Child', 'https://child.example'));
  assert.equal(childIntent?.parentNativeId, folder!.nativeId);
});

test('does not swallow update failures and leaves a retryable recovery intent', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-recovery', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready',
  });
  const root: MappingInput = {
    nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'd-root', content: { title: 'Root' } },
  };
  await store.putMapping(scope, root);
  await store.replaceProjectionIntents(scope, [{
    intentId: 'update:root', kind: 'update', colpId: 'root', order: 1,
    suppression: 'recovery:update:root', generation: scope.generation, state: 'pending',
    nativeId: '1', title: 'Renamed',
  }]);
  const chrome = fakeChrome([{ id: '1', title: 'Root' }]); chrome.crashOn.update = 1;
  await assert.rejects(() => executeProjectionIntents({
    scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: [root],
  }), /chrome_crash/);
  assert.equal((await store.listProjectionIntents(scope))[0]?.state, 'recovery');
});

test('replans virtual children when leftover terminal projection intents would skip Chrome create', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-leftover', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready',
  });
  await store.replaceProjectionIntents(scope, [{
    intentId: 'create:stale', kind: 'create', colpId: 'stale', order: 1,
    suppression: 'recovery:create:stale', generation: 1, state: 'terminal',
  }]);
  const bound: MappingInput[] = [{
    nativeId: 'recovery:root', colpId: 'root', rootNativeId: 'recovery:root', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'd-root', content: { title: '', folderRole: 'root' } },
  }, {
    nativeId: '1', colpId: 'mount-bar', rootNativeId: '1', nodeKind: 'folder', parentColpId: 'root',
    rootRole: 'bookmarks-bar', projection: { revision: 'r2', digest: 'd-bar',
      content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
  }, {
    nativeId: 'recovery:child', colpId: 'child', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
    parentColpId: 'mount-bar', projection: { revision: 'r3', digest: 'd-child',
      content: { title: 'Child', url: 'https://child.example' } },
  }];
  const chrome = fakeChrome([{ id: '1', title: 'Bookmarks bar' }]);
  const projected = await projectVirtualSnapshotChildren({ scope, store, api: chrome.api, bound });
  assert.equal(chrome.creates, 1);
  assert.equal(projected.find((mapping) => mapping.colpId === 'child')?.nativeId, '2');
  assert.equal(chrome.nodes.get('2')?.parentId, '1');
  assert.equal((await store.getMappingByColpId(scope, 'child'))?.nativeId, '2');
});

test('replans persisted recovery:* children after a later native mount bind', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-later-bind', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready',
  });
  const first: MappingInput[] = [{
    nativeId: 'recovery:root', colpId: 'root', rootNativeId: 'recovery:root', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'd-root', content: { title: '', folderRole: 'root' } },
  }, {
    nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root', nodeKind: 'folder',
    parentColpId: 'root', rootRole: 'bookmarks-bar', projection: { revision: 'r2', digest: 'd-bar',
      content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
  }, {
    nativeId: 'recovery:child', colpId: 'child', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
    parentColpId: 'mount-bar', projection: { revision: 'r3', digest: 'd-child',
      content: { title: 'Child', url: 'https://child.example' } },
  }];
  const chrome = fakeChrome([{ id: '1', title: 'Bookmarks bar' }]);
  const skipped = await projectVirtualSnapshotChildren({ scope, store, api: chrome.api, bound: first });
  assert.equal(chrome.creates, 0);
  for (const mapping of skipped) await store.putMapping(scope, mapping);
  const bound = skipped.map((mapping) => mapping.colpId === 'mount-bar'
    ? { ...mapping, nativeId: '1', rootNativeId: '1' } : mapping);
  const projected = await projectVirtualSnapshotChildren({ scope, store, api: chrome.api, bound });
  assert.equal(chrome.creates, 1);
  assert.equal(projected.find((mapping) => mapping.colpId === 'child')?.nativeId, '2');
  assert.equal(chrome.nodes.get('2')?.parentId, '1');
  assert.equal((await store.getMappingByColpId(scope, 'child'))?.nativeId, '2');
  assert.equal(await store.getMappingByNativeId(scope, 'recovery:child'), null);
  assert.equal([...chrome.nodes.values()].some((node) => node.title === 'Bar' && node.id !== '1'), false);
});

test('projects virtual snapshot children under a bound mount without creating the mount folder', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-virtual', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready',
  });
  const bound: MappingInput[] = [{
    nativeId: 'recovery:root', colpId: 'root', rootNativeId: 'recovery:root', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'd-root', content: { title: '', folderRole: 'root' } },
  }, {
    nativeId: '1', colpId: 'mount-bar', rootNativeId: '1', nodeKind: 'folder', parentColpId: 'root',
    rootRole: 'bookmarks-bar', projection: { revision: 'r2', digest: 'd-bar',
      content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
  }, {
    nativeId: 'recovery:child', colpId: 'child', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
    parentColpId: 'mount-bar', projection: { revision: 'r3', digest: 'd-child',
      content: { title: 'Child', url: 'https://child.example' } },
  }];
  const chrome = fakeChrome([{ id: '1', title: 'Bookmarks bar' }]);
  const projected = await projectVirtualSnapshotChildren({ scope, store, api: chrome.api, bound });
  assert.equal(chrome.creates, 1);
  assert.equal(projected.find((mapping) => mapping.colpId === 'mount-bar')?.nativeId, '1');
  assert.equal(projected.find((mapping) => mapping.colpId === 'child')?.nativeId, '2');
  assert.equal(chrome.nodes.get('2')?.parentId, '1');
  assert.equal(chrome.nodes.get('2')?.title, 'Child');
  assert.equal([...chrome.nodes.values()].some((node) => node.title === 'Bar' && node.id !== '1'), false);
});

test('leftover projection requires a virtual child reachable from a bound native mount', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 }, checkpoint: null, selectedRoots: [] });
  await store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'mount-bar',
    boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
  const root = lifecycleMapping('recovery:root', 'root');
  const mount = { ...lifecycleMapping('recovery:mount-bar', 'mount-bar', 'root'),
    rootRole: 'bookmarks-bar' as const, nodeKind: 'folder' as const };
  for (const mapping of [root, mount, lifecycleMapping('unmounted:outside', 'outside', 'root')]) {
    await store.putMapping(scope, mapping);
  }
  assert.equal(await leftoverVirtualChildrenNeedReproject(store, scope), false);
  await store.putMapping(scope, lifecycleMapping('recovery:child', 'child', 'mount-bar'));
  assert.equal(await leftoverVirtualChildrenNeedReproject(store, scope), true);
  const chrome = fakeChrome([{ id: '1', title: 'Bookmarks bar' }]);
  await recoverVerifiedOrFreeze({ scope, store, api: chrome.api,
    staged: await store.listMappings(scope), freezeUnprovenIdentity: true });
  assert.equal(chrome.creates, 1);
  assert.equal(await leftoverVirtualChildrenNeedReproject(store, scope), false);
});

test('terminal projection history cannot overwrite a later restored native identity', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 }, checkpoint: null, selectedRoots: [] });
  const root = { ...lifecycleMapping('1', 'root'), nodeKind: 'folder' as const };
  const restored = lifecycleMapping('5', 'child', 'root');
  await store.putMapping(scope, root); await store.putMapping(scope, restored);
  await store.replaceProjectionIntents(scope, [{ intentId: 'create:child', kind: 'create', colpId: 'child', order: 1,
    suppression: 'old-create', generation: 1, state: 'terminal', observedNativeId: '2', parentNativeId: '1' }]);
  const chrome = fakeChrome([{ id: '1', title: 'Root' }, { id: '5', parentId: '1', title: 'Child', url: 'https://child.test/' }]);
  const projected = await projectVirtualSnapshotChildren({ scope, store, api: chrome.api,
    bound: [root, restored, lifecycleMapping('recovery:another', 'another', 'root')] });
  assert.equal(projected.find((row) => row.colpId === 'child')?.nativeId, '5');
  assert.equal((await store.getMappingByColpId(scope, 'child'))?.nativeId, '5');
  assert.equal(await store.getMappingByNativeId(scope, '2'), null);
  assert.equal(chrome.creates, 1);
});

test('new projection of the same Node executes its new desired state after an earlier terminal plan', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 }, checkpoint: null, selectedRoots: [] });
  const root: MappingInput = { ...lifecycleMapping('1', 'root'), nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'original', content: { title: 'Original' } } };
  await store.putMapping(scope, root);
  const chrome = fakeChrome([{ id: '1', title: 'Original' }]);
  for (const title of ['First state', 'Second state']) {
    await store.replaceProjectionIntents(scope, [{ intentId: 'update:root', kind: 'update', colpId: 'root', order: 1,
      suppression: 'update-root', generation: 1, state: 'pending', nativeId: '1', title }]);
    await executeProjectionIntents({ scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: [root] });
    assert.equal(chrome.nodes.get('1')?.title, title);
  }
});

test('an observed create identity missing from its parent cannot become a ghost mapping', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 }, checkpoint: null, selectedRoots: [] });
  const root = { ...lifecycleMapping('1', 'root'), nodeKind: 'folder' as const };
  await store.putMapping(scope, root);
  await store.replaceProjectionIntents(scope, [{ intentId: 'create:child', kind: 'create', colpId: 'child', order: 1,
    suppression: 'create-child', generation: 1, state: 'executing', observedNativeId: '2', parentNativeId: '1' }]);
  const chrome = fakeChrome([{ id: '1', title: 'Root' }]);
  await assert.rejects(() => executeProjectionIntents({ scope, store, api: chrome.api, selectedRootNativeId: '1',
    seedMappings: [root, lifecycleMapping('recovery:child', 'child', 'root')] }), /snapshot_native_projection_ambiguous/);
  assert.equal(await store.getMappingByColpId(scope, 'child'), null);
  assert.equal(chrome.creates, 0);
  assert.equal((await store.listProjectionIntents(scope))[0]?.state, 'ambiguous');
});

test('a replayed delete intent removes its seed and durable mapping before becoming terminal', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 }, checkpoint: null, selectedRoots: [] });
  const root = { ...lifecycleMapping('1', 'root'), nodeKind: 'folder' as const };
  const child = lifecycleMapping('2', 'child', 'root');
  await store.putMapping(scope, root); await store.putMapping(scope, child);
  await store.replaceProjectionIntents(scope, [{ intentId: 'delete:child', kind: 'delete', colpId: 'child', order: 1,
    suppression: 'delete-child', generation: 1, state: 'executing', nativeId: '2', folder: false }]);
  // The prior worker already completed Chrome deletion and stopped before
  // publishing its mapping removal. Replay must finish that durable work.
  const chrome = fakeChrome([{ id: '1', title: 'Root' }]);
  const result = await executeProjectionIntents({ scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: [root, child] });
  assert.equal(result.some((mapping) => mapping.colpId === 'child'), false);
  assert.equal(await store.getMappingByColpId(scope, 'child'), null);
  assert.equal((await store.listProjectionIntents(scope))[0]?.state, 'terminal');
  const replayed = await executeProjectionIntents({ scope, store, api: chrome.api, selectedRootNativeId: '1', seedMappings: result });
  assert.equal(replayed.some((mapping) => mapping.colpId === 'child'), false);
});

test('terminal native history cannot rematerialize a Node that is now outside the selected mount', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 }, checkpoint: null, selectedRoots: [] });
  const root = { ...lifecycleMapping('recovery:root', 'root'), nodeKind: 'folder' as const };
  const mounted = { ...lifecycleMapping('1', 'mount', 'root'), nodeKind: 'folder' as const };
  const outside = { ...lifecycleMapping('unmounted:outside', 'outside', 'root'), nodeKind: 'folder' as const };
  const child = lifecycleMapping('unmounted:child', 'child', 'outside');
  for (const mapping of [root, mounted, outside, child]) await store.putMapping(scope, mapping);
  await store.replaceProjectionIntents(scope, [{ intentId: 'create:child', kind: 'create', colpId: 'child', order: 1,
    suppression: 'old-create', generation: 1, state: 'terminal', observedNativeId: '2', parentNativeId: '1' }]);
  const chrome = fakeChrome([{ id: '1', title: 'Bookmarks bar' }]);
  const result = await projectVirtualSnapshotChildren({ scope, store, api: chrome.api,
    bound: [root, mounted, outside, child, lifecycleMapping('recovery:another', 'another', 'mount')] });
  assert.equal(result.find((mapping) => mapping.colpId === 'child')?.nativeId, 'unmounted:child');
  assert.equal((await store.getMappingByColpId(scope, 'child'))?.nativeId, 'unmounted:child');
  assert.equal(chrome.creates, 1);
});

test.each([false, true])('snapshot projection respects selected subfolders with overlapping mounts: %s', async (overlap) => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
    checkpoint: null, selectedRoots: ['selected'], rootStatus: 'ready' });
  const folder = (nativeId: string, colpId: string, parentColpId?: string): MappingInput => ({
    ...lifecycleMapping(nativeId, colpId, parentColpId), nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'sha256:folder', content: { title: colpId } },
  });
  const root = folder('recovery:root', 'root');
  const bar = { ...folder('1', 'bar', 'root'), rootRole: 'bookmarks-bar' as const };
  const selected = { ...folder('2', 'selected', 'bar'), parentNativeId: '1', rootNativeId: '2', mountId: 'selected-mount' };
  const nested = { ...folder('3', 'nested', 'selected'), parentNativeId: '2', rootNativeId: '3', mountId: 'nested-mount' };
  await store.putMapping(scope, bar); await store.putMapping(scope, selected);
  await store.putMountBinding(scope, { mountId: 'selected-mount', nativeRootId: '2', remoteMountNodeId: 'selected',
    customSourceKey: 'folder:2', boundaryVersion: '1', materialized: false, status: 'active' });
  if (overlap) {
    await store.putMapping(scope, nested);
    await store.putMountBinding(scope, { mountId: 'nested-mount', nativeRootId: '3', remoteMountNodeId: 'nested',
      customSourceKey: 'folder:3', boundaryVersion: '1', materialized: false, status: 'active' });
  }
  const chrome = fakeChrome([{ id: '1', title: 'bar' }, { id: '2', parentId: '1', title: 'selected' },
    ...(overlap ? [{ id: '3', parentId: '2', title: 'nested' }] : [])]);
  const outside = folder('recovery:outside', 'outside', 'bar');
  const inside = lifecycleMapping('recovery:inside', 'inside', 'selected');
  const result = await recoverVerifiedOrFreeze({ scope, store, api: chrome.api,
    staged: [root, { ...bar, nativeId: 'recovery:bar' }, { ...selected, nativeId: 'recovery:selected' },
      ...(overlap ? [{ ...nested, nativeId: 'recovery:nested' }] : []), outside, inside],
    freezeUnprovenIdentity: true });
  assert.equal([...chrome.nodes.values()].some(node => node.title === 'outside'), false);
  assert.equal([...chrome.nodes.values()].filter(node => node.title === 'inside').length, 1);
  assert.equal(result.find(row => row.colpId === 'outside')?.nativeId, 'unmounted:outside');
  store.close();
});

test('the verified guard retains the legacy selected-root overlay for an entirely native projection', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
    checkpoint: null, selectedRoots: ['root'] });
  const root: MappingInput = { nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'sha256:root', content: { title: 'Root' } } };
  const child = { ...lifecycleMapping('2', 'child', 'root'),
    projection: { revision: 'r1', digest: 'before', content: { title: 'Child before', url: 'https://child.test/' } } };
  await store.putMapping(scope, root); await store.putMapping(scope, child);
  const chrome = fakeChrome([{ id: '1', title: 'Root' }, { id: '2', parentId: '1', index: 0,
    title: 'Child before', url: 'https://child.test/' }]);
  await recoverVerifiedOrFreeze({ scope, store, api: chrome.api, freezeUnprovenIdentity: true,
    staged: [root, { ...child, projection: { ...child.projection, content: { title: 'Child after', url: 'https://child.test/' } } }] });
  assert.equal(chrome.nodes.get('2')?.title, 'Child after');
  assert.equal(chrome.nodes.get('1')?.title, 'Root');
  assert.equal(chrome.creates, 0);
});

for (const timing of ['before planning', 'after an interrupted plan'] as const) {
  test(`snapshot deletion preserves a local-only descendant added ${timing}`, async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
      checkpoint: null, selectedRoots: ['root'], rootStatus: 'ready' });
    const root: MappingInput = { nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
      projection: { revision: 'r1', digest: 'root', content: { title: 'Root' } } };
    const folder: MappingInput = { nativeId: '2', colpId: 'folder', rootNativeId: '1', nodeKind: 'folder',
      parentNativeId: '1', parentColpId: 'root',
      projection: { revision: 'r1', digest: 'folder', content: { title: 'Folder' } } };
    await store.putMapping(scope, root); await store.putMapping(scope, folder);
    const chrome = fakeChrome([{ id: '1', title: 'Root' }, { id: '2', parentId: '1', title: 'Folder' }]);
    const recover = () => recoverSnapshotProjection({ scope, store, staged: [root], api: chrome.api });
    try {
      if (timing === 'after an interrupted plan') {
        chrome.crashOn.remove = 1;
        await assert.rejects(recover(), /chrome_crash/);
      }
      chrome.nodes.set('3', { id: '3', parentId: '2', title: 'Only local copy', url: 'https://local.test/' });
      await assert.rejects(recover(), /non-empty folder/);
      assert.equal(chrome.nodes.get('3')?.url, 'https://local.test/');
      assert.ok(chrome.nodes.has('2'));
      assert.ok(await store.getMappingByColpId(scope, 'folder'));
      assert.equal((await store.listProjectionIntents(scope)).find(row => row.colpId === 'folder')?.state, 'recovery');
      // Once the user moves the local copy away, the exact plan can finish.
      await chrome.api.move('3', { parentId: '1' });
      await recover();
      assert.equal(chrome.nodes.has('2'), false);
      assert.equal(chrome.nodes.get('3')?.parentId, '1');
    } finally { await store.close(); }
  });
}

test('the verified recovery entry resumes a deletion after Chrome committed but the mapping write crashed', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
    checkpoint: null, selectedRoots: ['root'], rootStatus: 'ready' });
  const root: MappingInput = { nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'root', content: { title: 'Root' } } };
  const child = lifecycleMapping('2', 'child', 'root');
  await store.putMapping(scope, root); await store.putMapping(scope, child);
  const chrome = fakeChrome([{ id: '1', title: 'Root' },
    { id: '2', parentId: '1', title: 'child', url: 'https://child.test/' }]);
  const crashingStore = { ...store, async deleteMapping() { throw new Error('mapping_write_crash'); } };
  await assert.rejects(() => recoverVerifiedOrFreeze({ scope, store: crashingStore, api: chrome.api,
    staged: [root], freezeUnprovenIdentity: true }), /mapping_write_crash/);
  assert.equal(chrome.nodes.has('2'), false);
  assert.ok(await store.getMappingByColpId(scope, 'child'));
  await store.close();
  const reopened = createSyncStateStore({ indexedDB });
  try {
    await recoverVerifiedOrFreeze({ scope, store: reopened, api: chrome.api,
      staged: [root], freezeUnprovenIdentity: true });
    assert.equal(await reopened.getMappingByColpId(scope, 'child'), null);
    assert.equal((await reopened.listProjectionIntents(scope))[0]?.state, 'terminal');
    assert.equal((await reopened.getScope(scope))?.lifecycle, 'active');
  } finally { await reopened.close(); }
});

for (const failure of ['Permission denied', "Can't modify a managed bookmark.", 'temporary API failure', 'empty']) {
  test(`delete replay does not treat ${failure} as absence`, async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
      checkpoint: null, selectedRoots: ['root'], rootStatus: 'ready' });
    const child = lifecycleMapping('2', 'child', 'root'); await store.putMapping(scope, child);
    await store.replaceProjectionIntents(scope, [{ intentId: 'delete:child', kind: 'delete', colpId: 'child', order: 1,
      suppression: 'delete-child', generation: 1, state: 'executing', nativeId: '2', folder: false }]);
    const chrome = fakeChrome([]);
    const api = { ...chrome.api, async get() { if (failure === 'empty') return []; throw new Error(failure); } };
    try {
      await assert.rejects(() => executeProjectionIntents({ scope, store, api,
        selectedRootNativeId: '1', seedMappings: [child] }), (error: unknown) => error instanceof Error
          && error.message === (failure === 'empty' ? 'bookmark_lookup_empty' : failure));
      assert.ok(await store.getMappingByColpId(scope, 'child'));
      assert.equal((await store.listProjectionIntents(scope))[0]?.state, 'recovery');
    } finally { await store.close(); }
  });
}

test('snapshot deletion still removes an observed mapped subtree in child-first order', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 99_999 },
    checkpoint: null, selectedRoots: ['root'], rootStatus: 'ready' });
  const root: MappingInput = { nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'r1', digest: 'root', content: { title: 'Root' } } };
  const folder: MappingInput = { nativeId: '2', colpId: 'folder', rootNativeId: '1', nodeKind: 'folder',
    parentNativeId: '1', parentColpId: 'root',
    projection: { revision: 'r1', digest: 'folder', content: { title: 'Folder' } } };
  const child = { ...lifecycleMapping('3', 'child', 'folder'), parentNativeId: '2' };
  for (const mapping of [root, folder, child]) await store.putMapping(scope, mapping);
  const chrome = fakeChrome([{ id: '1', title: 'Root' }, { id: '2', parentId: '1', title: 'Folder' },
    { id: '3', parentId: '2', title: 'child', url: 'https://child.test/' }]);
  try {
    await recoverSnapshotProjection({ scope, store, staged: [root], api: chrome.api });
    assert.deepEqual([...chrome.nodes.keys()], ['1']);
    assert.deepEqual((await store.listMappings(scope)).map(row => row.colpId), ['root']);
  } finally { await store.close(); }
});

function lifecycleMapping(nativeId: string, colpId: string, parentColpId?: string): MappingInput {
  return { nativeId, colpId, rootNativeId: '1', nodeKind: 'bookmark',
    ...(parentColpId ? { parentColpId, parentNativeId: '1' } : {}),
    projection: { revision: 'r1', digest: 'sha256:lifecycle', content: {
      title: colpId, url: 'https://child.test/' } } };
}
