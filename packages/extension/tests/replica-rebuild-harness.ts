import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createCredentialStore, MemoryStorageArea } from '../src/credential-store.js';
import { createReplicaRebuilder, REPLICA_REBUILD_JOURNAL, validReplicaRebuildRequest,
  type ReplicaRebuildDeps, type ReplicaRebuildRequest } from '../src/replica-rebuild.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

export async function setup(input: { degraded?: boolean } = {}) {
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
  if (!input.degraded) await store.transitionEngine(scope, { phase: 'recovery', recoveryFrozen: true, authorityRefreshRequired: true,
    updatedAt: 1000, notBefore: 0, lastError: 'payload_too_large' });
  if (input.degraded) {
    await store.stagePullPage(scope, { pageId: 'issue-page', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
      collectionRevision: 'r1', pageDigest: 'sha256:page', effectPages: [], events: [{ eventId: 'issue-event',
        operationId: 'remote-op', effectId: 'remote-effect', effectDigest: 'sha256:effect', operationDigest: 'sha256:op',
        cursor: 'cursor-1', kind: 'node_content_updated', payload: {} }] });
    await store.setAsidePullEvent(scope, 'issue-event', { code: 'record_too_large', nodeId: 'root', title: 'Needs repair', now: 1000 });
    await store.completePullPage(scope, 'issue-page');
  }
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
    replicaId: preview.preview.replicaId, generation: preview.preview.generation, revision: preview.preview.revision, targetFence: preview.preview.targetFence };
  return { scope, store, credentials, journal, deps, request, rebuilder, preview: preview.preview,
    setOffline(value: boolean) { failRegistration = value; }, get registrations() { return registrations; } };
}

