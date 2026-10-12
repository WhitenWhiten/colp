import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { parseBuildConfig } from '../src/config.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createMemoryBookmarks } from './bookmark-batch-memory.js';
import { DATABASE_NAME } from '../src/sync-state/schema.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.unstubAllGlobals(); vi.resetModules(); });

async function fixture(state: 'guest' | 'residual-binding' | 'account-no-collection' | 'revoked') {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory());
  const local = new MemoryStorageArea(), session = new MemoryStorageArea(), api = createMemoryBookmarks();
  const network = vi.fn(async () => { throw new Error('unexpected_network'); }); vi.stubGlobal('fetch', network);
  vi.stubGlobal('chrome', { storage: { local, session: Object.assign(session, { async setAccessLevel() {} }) },
    runtime: { id: 'pplpnpegpnghcddhmpgkbfkdfadjiaen' }, bookmarks: api,
    permissions: { async contains() { return true; } } });
  const runtime = await import('../src/sw/runtime.js');
  cleanups.push(() => runtime.syncState.close());
  const config = parseBuildConfig(JSON.parse(await readFile('config/e2e-fixture.json', 'utf8')));
  runtime.sw.configPromise = Promise.resolve(config);
  if (state !== 'guest') await runtime.store.getOrCreateBinding(0);
  if (state === 'account-no-collection') await runtime.store.saveCredential({
    accessToken: 'local-first-fixture', tokenType: 'Bearer', expiresAt: Date.now() + 3600000, scope: config.scopes,
    issuer: config.issuer, audience: config.audience, clientId: config.clientId, serverOrigin: config.serverOrigin, subject: 'local-first-account',
  });
  if (state === 'revoked') await runtime.store.revokeAuthority();
  const worker = await import('../src/sw/batch.js');
  const native = await (await import('../src/bookmark-batch-local.js')).localBookmarkBatchStore();
  cleanups.push(() => native.close());
  return { ...runtime, ...worker, api, network, native };
}

for (const state of ['guest', 'residual-binding', 'account-no-collection', 'revoked'] as const) test(`${state}: local preview, delete and undo work without a sync scope`, async () => {
  const f = await fixture(state), preview = await f.handleBatchRequest({ kind: 'known.batch.preview', operation: 'delete', nativeIds: ['bm-1'] });
  assert.ok(preview.ok && 'preview' in preview);
  const commandId = crypto.randomUUID();
  const deleted = await f.handleBatchRequest({ kind: 'known.batch.confirm', operation: 'delete', nativeIds: ['bm-1'],
    commandId, previewDigest: preview.preview.digest, secondConfirm: true, userGesture: true });
  assert.ok(deleted.ok && 'status' in deleted); assert.equal(deleted.status.applied, 1);
  const undone = await f.handleBatchRequest({ kind: 'known.batch.undo', planId: deleted.status.planId, commandId, userGesture: true });
  assert.ok(undone.ok && 'status' in undone); assert.equal(undone.status.undone, 1);
  assert.equal(f.api.node('bar')!.children![0]!.url, 'https://a.test/one');
  assert.equal((await f.native.local.listBatchPlans()).length, 1);
  assert.equal(f.network.mock.calls.length, 0);
});

test('a previously admitted local delete remains undoable after a sync collection is connected', async () => {
  const f = await fixture('guest'), preview = await f.handleBatchRequest({ kind: 'known.batch.preview', operation: 'delete', nativeIds: ['bm-1'] });
  assert.ok(preview.ok && 'preview' in preview);
  const commandId = crypto.randomUUID(), deleted = await f.handleBatchRequest({ kind: 'known.batch.confirm', operation: 'delete', nativeIds: ['bm-1'], commandId,
    previewDigest: preview.preview.digest, secondConfirm: true, userGesture: true });
  assert.ok(deleted.ok && 'status' in deleted);
  const binding = await f.store.getOrCreateBinding(0), config = await f.sw.configPromise!;
  await f.store.saveCredential({ accessToken: 'new-account-fixture', tokenType: 'Bearer', expiresAt: Date.now() + 3600000, scope: config.scopes,
    issuer: config.issuer, audience: config.audience, clientId: config.clientId, serverOrigin: config.serverOrigin, subject: 'new-account' });
  await f.syncState.registerScope({ environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin, accountId: 'new-account',
    browserProfileId: binding.browserProfileId, collectionId: 'new-collection', replicaId: binding.replicaId, generation: Number(binding.generation),
    lifecycle: 'active', selectedRoots: [], lease: { leaseId: 'local-test', expiresAt: 1 }, checkpoint: { serverRevision: 'r0', cursor: 'c0' } });
  await (chrome.storage.local as unknown as MemoryStorageArea).set({ 'known.sync.collection.v1': 'new-collection' });
  const status = await f.handleBatchRequest({ kind: 'known.batch.status' });
  assert.ok(status.ok && 'status' in status); assert.equal(status.status.planId, commandId);
  const undone = await f.handleBatchRequest({ kind: 'known.batch.undo', planId: commandId, commandId, userGesture: true });
  assert.ok(undone.ok && 'status' in undone); assert.equal(undone.status.undone, 1); assert.equal(f.network.mock.calls.length, 0);
});

test.each(['bookmark', 'folder', 'multiple-folders'] as const)('paused personal sync still permits local %s deletion and undo', async selection => {
  const f = await fixture('account-no-collection');
  const binding = await f.store.loadBinding(), config = await f.sw.configPromise!;
  assert.ok(binding);
  const scope = { environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin,
    accountId: 'local-first-account', browserProfileId: binding.browserProfileId, collectionId: 'paused-collection',
    replicaId: binding.replicaId, generation: Number(binding.generation) };
  await f.syncState.registerScope({ ...scope, lifecycle: 'active', selectedRoots: ['bar'],
    lease: { leaseId: 'paused-test', expiresAt: Date.now() + 3600000 }, checkpoint: { serverRevision: 'r0', cursor: 'c0' } });
  await f.syncState.putMapping(scope, { nativeId: 'bm-1', colpId: 'remote-bookmark', parentNativeId: 'bar',
    rootNativeId: 'bar', nodeKind: 'bookmark', projection: { revision: 'r1', digest: 'sha256:one' } });
  await chrome.storage.local.set({ 'known.sync.collection.v1': scope.collectionId });
  const { createPersonalSyncPolicyStore } = await import('../src/personal-sync-policy.js');
  const { configurePersonalSyncTransport } = await import('../src/personal-sync-fetch.js');
  const policy = createPersonalSyncPolicyStore(chrome.storage.local);
  configurePersonalSyncTransport(policy);
  await policy.write(scope, 'paused');
  const folder = await f.api.create!({ parentId: 'bar', title: 'Duplicate folder' });
  await f.api.create!({ parentId: folder.id, title: 'Nested bookmark', url: 'https://nested.test/' });
  const nativeIds = selection === 'bookmark' ? ['bm-1'] : selection === 'folder' ? [folder.id] : ['folder-a', folder.id];
  const before = await f.api.getTree();
  const preview = await f.handleBatchRequest({ kind: 'known.batch.preview', operation: 'delete', nativeIds });
  assert.ok(preview.ok && 'preview' in preview, JSON.stringify(preview));
  const commandId = crypto.randomUUID();
  const deleted = await f.handleBatchRequest({ kind: 'known.batch.confirm', operation: 'delete', nativeIds,
    commandId, previewDigest: preview.preview.digest, secondConfirm: true, userGesture: true });
  assert.ok(deleted.ok && 'status' in deleted, JSON.stringify(deleted));
  assert.equal(deleted.status.applied, nativeIds.length);
  for (const id of nativeIds) assert.equal(f.api.node(id), undefined);
  const undone = await f.handleBatchRequest({ kind: 'known.batch.undo', planId: commandId, commandId, userGesture: true });
  assert.ok(undone.ok && 'status' in undone, JSON.stringify(undone));
  assert.equal(undone.status.undone, nativeIds.length);
  const content = (value: unknown): unknown => Array.isArray(value) ? value.map(content)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'id' && key !== 'parentId')
      .map(([key, entry]) => [key, content(entry)])) : value;
  assert.deepEqual(content(await f.api.getTree()), content(before));
  assert.equal((await f.native.local.listBatchPlans()).length, 1);
  assert.equal((await f.syncState.listBatchPlans(scope)).length, 0);
  assert.equal((await f.syncState.getMappingByNativeId(scope, 'bm-1'))?.colpId, 'remote-bookmark');
  assert.equal((await policy.read(scope)).mode, 'paused');
  assert.equal(f.network.mock.calls.length, 0);
});

for (const lifecycle of ['active', 'recovery_required'] as const) test(`${lifecycle}: mapped deletes have native backups and undo after pausing and changing accounts`, async () => {
  const f = await fixture('account-no-collection');
  const binding = await f.store.loadBinding(), config = await f.sw.configPromise!;
  assert.ok(binding);
  const scope = { environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin,
    accountId: 'local-first-account', browserProfileId: binding.browserProfileId, collectionId: 'connected-collection',
    replicaId: binding.replicaId, generation: Number(binding.generation) };
  await f.syncState.registerScope({ ...scope, lifecycle, selectedRoots: ['bar'],
    lease: { leaseId: 'connected-test', expiresAt: Date.now() + 3600000 }, checkpoint: { serverRevision: 'r0', cursor: 'c0' } });
  await f.syncState.putMapping(scope, { nativeId: 'bm-1', colpId: 'remote-bookmark', parentNativeId: 'bar',
    rootNativeId: 'bar', nodeKind: 'bookmark', projection: { revision: 'r1', digest: 'sha256:one' } });
  await chrome.storage.local.set({ 'known.sync.collection.v1': scope.collectionId });
  const preview = await f.handleBatchRequest({ kind: 'known.batch.preview', operation: 'delete', nativeIds: ['bm-1'] });
  assert.ok(preview.ok && 'preview' in preview, JSON.stringify(preview));
  const commandId = crypto.randomUUID();
  const deleted = await f.handleBatchRequest({ kind: 'known.batch.confirm', operation: 'delete', nativeIds: ['bm-1'],
    commandId, previewDigest: preview.preview.digest, secondConfirm: true, userGesture: true });
  assert.ok(deleted.ok && 'status' in deleted, JSON.stringify(deleted)); assert.equal(deleted.status.applied, 1);
  const record = await f.native.local.readBatchPlan(commandId);
  assert.ok(record); assert.equal(record.items[0]?.colpId, undefined);
  assert.equal((await f.syncState.listBatchPlans(scope)).length, 0);
  const { createPersonalSyncPolicyStore } = await import('../src/personal-sync-policy.js');
  await createPersonalSyncPolicyStore(chrome.storage.local).write(scope, 'paused');
  await f.store.revokeAuthority(); await f.store.activateAuthority();
  await f.store.clearAuthority();
  await f.store.saveCredential({ accessToken: 'other-account', tokenType: 'Bearer', expiresAt: Date.now() + 3600000,
    scope: config.scopes, issuer: config.issuer, audience: config.audience, clientId: config.clientId,
    serverOrigin: config.serverOrigin, subject: 'other-account' });
  await f.native.close(); // Reopen the journal when Undo runs, as after a worker restart.
  const status = await f.handleBatchRequest({ kind: 'known.batch.status', planId: commandId });
  assert.ok(status.ok && 'status' in status); assert.equal(status.status.planId, commandId);
  const undone = await f.handleBatchRequest({ kind: 'known.batch.undo', planId: commandId, commandId, userGesture: true });
  assert.ok(undone.ok && 'status' in undone, JSON.stringify(undone)); assert.equal(undone.status.undone, 1);
  assert.equal(f.api.node('bar')!.children![0]!.url, 'https://a.test/one');
  assert.equal(f.network.mock.calls.length, 0);
});

test('an unavailable account sync store cannot block local delete or undo', async () => {
  const f = await fixture('account-no-collection');
  const binding = await f.store.loadBinding(), config = await f.sw.configPromise!; assert.ok(binding);
  const scope = { environment: config.environment, serverId: config.serverOrigin, serverOrigin: config.serverOrigin,
    accountId: 'local-first-account', browserProfileId: binding.browserProfileId, collectionId: 'broken-collection',
    replicaId: binding.replicaId, generation: Number(binding.generation) };
  await f.syncState.registerScope({ ...scope, lifecycle: 'active', selectedRoots: ['bar'],
    lease: { leaseId: 'test', expiresAt: Date.now() + 3600000 }, checkpoint: { serverRevision: 'r0', cursor: 'c0' } });
  await chrome.storage.local.set({ 'known.sync.collection.v1': scope.collectionId });
  await f.syncState.close();
  const open = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
    if (name === DATABASE_NAME) throw new Error('account_database_unavailable');
    return open(name, version);
  });
  const preview = await f.handleBatchRequest({ kind: 'known.batch.preview', operation: 'delete', nativeIds: ['bm-1'] });
  assert.ok(preview.ok && 'preview' in preview, JSON.stringify(preview));
  const commandId = crypto.randomUUID();
  const deleted = await f.handleBatchRequest({ kind: 'known.batch.confirm', operation: 'delete', nativeIds: ['bm-1'],
    commandId, previewDigest: preview.preview.digest, secondConfirm: true, userGesture: true });
  assert.ok(deleted.ok && 'status' in deleted, JSON.stringify(deleted)); assert.equal(deleted.status.applied, 1);
  const undone = await f.handleBatchRequest({ kind: 'known.batch.undo', planId: commandId, commandId, userGesture: true });
  assert.ok(undone.ok && 'status' in undone, JSON.stringify(undone)); assert.equal(undone.status.undone, 1);
  assert.equal(f.network.mock.calls.length, 0);
});
