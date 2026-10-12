import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createCredentialStore, MemoryStorageArea } from '../src/credential-store.js';
import { createReplicaRebuilder, REPLICA_REBUILD_JOURNAL, validReplicaRebuildRequest,
  type ReplicaRebuildDeps, type ReplicaRebuildRequest } from '../src/replica-rebuild.js';
import { replicaRebuildConfirmation } from '../src/replica-rebuild-ui.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

async function setup() {
  const journal = new MemoryStorageArea(); const credentials = createCredentialStore(journal);
  const auth = await credentials.fence.capture();
  await credentials.saveCredential({ accessToken: 'rebuild-test', tokenType: 'Bearer', expiresAt: Date.now() + 100_000,
    scope: ['known.sync'], issuer: 'https://known.example', audience: 'https://known.example',
    clientId: 'extension', serverOrigin: 'https://known.example', subject: 'account-rebuild' });
  const binding = await credentials.getOrCreateBinding(auth.generation);
  const scope: SyncScope = { environment: 'production', serverId: 'server-rebuild', serverOrigin: 'https://known.example',
    accountId: 'account-rebuild', browserProfileId: binding.browserProfileId, replicaId: binding.replicaId,
    generation: 1, collectionId: 'collection-rebuild' };
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  const registration = { ...scope, lifecycle: 'active' as const, lease: { leaseId: 'lease', expiresAt: Date.now() + 100_000 },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'r0' }, selectedRoots: ['root'], rootStatus: 'ready' as const };
  await store.registerScope(registration);
  await store.putMapping(scope, { nativeId: 'local-kept', colpId: 'root', rootNativeId: 'local-kept',
    projection: { revision: 'r0', digest: 'sha256:root', content: { title: 'Keep me' } } });
  await store.allocateSequenceAndEnqueue(scope, { opId: 'queued', batchId: 'batch', idempotencyKey: 'queued',
    digest: 'sha256:queued', endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null,
    operationRevision: 'local-queued', status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: {} },
  { allowUnstamped: true });
  await store.putPendingReorder(scope, { parentNativeId: 'local-kept', version: 'v1', childIds: ['a', 'b'],
    moves: [], retained: 2, unmapped: [], excluded: [], reserved: [] });
  await store.transitionEngine(scope, { phase: 'recovery', recoveryFrozen: true, authorityRefreshRequired: true,
    updatedAt: 1000, notBefore: 0, lastError: 'payload_too_large' });
  let current = scope; let failRegistration = false; let registrations = 0;
  const deps: ReplicaRebuildDeps = { store, credentials, journal, currentScope: async () => current,
    resetRuntime() {}, async ensureScope() {
      if (failRegistration) throw new Error('offline');
      const next = (await credentials.loadBinding())!;
      current = { ...scope, replicaId: next.replicaId, generation: Number(next.generation) };
      if (!await store.getScope(current)) {
        await store.registerScope({ ...registration, ...current, selectedRoots: [], firstRun: 'none' }); registrations++;
      }
      return current;
    } };
  const rebuilder = createReplicaRebuilder(deps);
  const preview = await rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
  assert.ok(preview.ok && 'preview' in preview);
  const request: ReplicaRebuildRequest = { kind: 'known.scope.rebuild.confirm', userGesture: true,
    replicaId: preview.preview.replicaId, generation: preview.preview.generation, revision: preview.preview.revision };
  return { scope, store, credentials, journal, deps, request, rebuilder, preview: preview.preview,
    setOffline(value: boolean) { failRegistration = value; }, get registrations() { return registrations; } };
}

test('rebuild archives pending edits and reorder targets before opening a fresh setup scope', async () => {
  const f = await setup(); assert.equal(f.preview.queuedOperations, 1);
  assert.deepEqual(await f.rebuilder.handle(f.request), { ok: true, result: 'setup_required' });
  const binding = (await f.credentials.loadBinding())!;
  assert.notEqual(binding.replicaId, f.scope.replicaId);
  assert.equal(binding.browserProfileId, f.scope.browserProfileId);
  const archive = await f.store.exportArchive(f.scope);
  assert.equal((archive.queue as unknown[]).length, 1);
  assert.equal((archive.mappings as unknown[]).length, 1);
  assert.ok((archive.diagnostics as {kind: string}[]).some(row => row.kind === 'reorder_pending'));
  assert.equal(await f.store.getScope(f.scope), null);
  assert.deepEqual(await f.store.listPendingReorders(f.scope), []);
  const current = await f.store.getScope({ ...f.scope, replicaId: binding.replicaId });
  assert.equal(current?.firstRun, 'none'); assert.deepEqual(current?.selectedRoots, []);
  assert.equal(await f.store.getEngineState({ ...f.scope, replicaId: binding.replicaId }), null);
  assert.equal(f.registrations, 1);
  assert.equal((await f.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL], undefined);
  assert.match(replicaRebuildConfirmation(1), /Your bookmarks stay on this device and in Know-N/);
  assert.match(replicaRebuildConfirmation(1), /1 change that has not synced yet will be set aside/);
  assert.match(replicaRebuildConfirmation(3), /3 changes that have not synced yet/);
  assert.doesNotMatch(replicaRebuildConfirmation(0), /set aside/);
  assert.doesNotMatch(replicaRebuildConfirmation(2), /mirror|receipt|mapping/u);
});

test('registration failure survives restart and never rotates a second identity or loses the archive', async () => {
  const f = await setup(); f.setOffline(true);
  assert.deepEqual(await f.rebuilder.handle(f.request), { ok: false, code: 'offline' });
  const binding = await f.credentials.loadBinding();
  const restarted = createReplicaRebuilder(f.deps);
  assert.equal(await restarted.hasPending(), true);
  assert.deepEqual(await restarted.handle({ kind: 'known.scope.rebuild.preview' }), { ok: true, preview: f.preview });
  f.setOffline(false);
  assert.equal(await restarted.resume(), true);
  assert.deepEqual(await f.credentials.loadBinding(), binding);
  assert.equal((await f.store.exportArchive(f.scope)).reason, 'user_replica_rebuild');
  assert.equal(await restarted.resume(), false);
  assert.equal(await restarted.hasPending(), false);
  assert.equal(f.registrations, 1);
});

test('a crash after archiving but before publishing the new binding is restartable', async () => {
  const f = await setup(); let fail = true;
  const deps = { ...f.deps, credentials: { ...f.credentials, async replaceBindingForRebuild(...args:
    Parameters<typeof f.credentials.replaceBindingForRebuild>) {
    if (fail) throw new Error('storage_unavailable');
    return f.credentials.replaceBindingForRebuild(...args);
  } } };
  assert.deepEqual(await createReplicaRebuilder(deps).handle(f.request), { ok: false, code: 'storage_unavailable' });
  assert.equal(await f.store.getScope(f.scope), null);
  assert.equal((await f.credentials.loadBinding())?.replicaId, f.scope.replicaId);
  fail = false;
  assert.equal(await createReplicaRebuilder(deps).resume(), true);
  assert.equal(f.registrations, 1);
});

test('stale confirmation and revoked restart cannot retire or replace unrelated authority', async () => {
  const f = await setup();
  assert.equal(validReplicaRebuildRequest(f.request), true);
  assert.equal(validReplicaRebuildRequest({ ...f.request, userGesture: false }), false);
  assert.equal(validReplicaRebuildRequest({ ...f.request, extra: 'ignored' }), false);
  assert.deepEqual(await f.rebuilder.handle({ ...f.request, revision: f.preview.revision + 1 } as ReplicaRebuildRequest),
    { ok: false, code: 'stale_ref' });
  assert.ok(await f.store.getScope(f.scope));
  f.setOffline(true); await f.rebuilder.handle(f.request);
  const binding = await f.credentials.loadBinding();
  await f.credentials.revokeAuthority();
  assert.equal(await createReplicaRebuilder(f.deps).resume(), false);
  assert.deepEqual(await f.credentials.loadBinding(), binding);
  assert.equal(f.registrations, 0);
});

test('a changed account discards its stale rebuild journal without blocking the new account', async () => {
  const f = await setup(); f.setOffline(true); await f.rebuilder.handle(f.request);
  const credential = (await f.credentials.loadCredential())!;
  await f.credentials.saveCredential({ ...credential, subject: 'another-account' });
  assert.equal(await createReplicaRebuilder(f.deps).resume(), false);
  assert.equal((await f.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL], undefined);
  assert.equal(f.registrations, 0);
});

test('a saved Session without its IDB scope cannot prematurely complete the rebuild journal', async () => {
  const f = await setup();
  const deps = { ...f.deps, async ensureScope() {
    return { ...f.scope, replicaId: (await f.credentials.loadBinding())!.replicaId };
  } };
  assert.deepEqual(await createReplicaRebuilder(deps).handle(f.request), { ok: false, code: 'scope_not_found' });
  assert.ok((await f.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL]);
  assert.equal(await createReplicaRebuilder(f.deps).resume(), true);
  assert.equal(f.registrations, 1);
});

test('rebuild deep-link opens the Sync center pane, not Sync folders', async () => {
  const ui = await readFile(new URL('../src/replica-rebuild-ui.ts', import.meta.url), 'utf8');
  assert.match(ui, /options\.html#sync/);
  assert.doesNotMatch(ui, /options\.html#folders/);
});
