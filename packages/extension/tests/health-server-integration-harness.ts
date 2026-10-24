import { handleAttentionDecide } from '../src/sw/first-run-attention.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import type { StoredSession } from '../src/types.js';
import type { SyncEndpoints } from '../src/manifest-client.js';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { createCredentialStore, MemoryStorageArea } from '../src/credential-store.js';
import { createReplicaRebuilder, runReplicaRebuildCommand } from '../src/replica-rebuild.js';
import { createBootstrapCoordinator, type ConfirmInput } from '../src/bootstrap/coordinator.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';

/** Real extension persistence and rebuilder; the integration host supplies HTTP. */
export async function healthServerFixture(scope: SyncScope, input: ConfirmInput) {
  const storage = new MemoryStorageArea(); const credentials = createCredentialStore(storage);
  await credentials.saveCredential({ accessToken: 'extension-health-test', tokenType: 'Bearer', expiresAt: Date.now() + 100000,
    scope: ['known.sync'], issuer: scope.serverOrigin, audience: scope.serverOrigin, clientId: 'extension',
    serverOrigin: scope.serverOrigin, subject: scope.accountId });
  await storage.set({ 'known.auth.binding.v1': { replicaId: scope.replicaId, browserProfileId: scope.browserProfileId, generation: String(scope.generation) } });
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); let current = scope;
  const register = (target: SyncScope) => store.registerScope({ ...target, lifecycle: 'active', rootStatus: 'ready',
    lease: { leaseId: 'lease', expiresAt: Date.now() + 100000 }, checkpoint: null, selectedRoots: [], firstRun: 'completed' });
  await register(scope);
  const mount = input.mounts[0]!;
  const folder = input.remoteFacts!.find(row => row.nodeId === mount.remoteMountNodeId)!;
  await store.putMapping(scope, { nativeId: mount.nativeRootId, colpId: folder.nodeId, nodeKind: 'folder', rootNativeId: mount.nativeRootId,
    projection: { revision: folder.revision, digest: 'sha256:folder', content: { title: folder.title } } });
  await store.putMountBinding(scope, { mountId: 'local-container', nativeRootId: mount.nativeRootId, remoteMountNodeId: folder.nodeId,
    customSourceKey: 'integration-container', status: 'active', materialized: false, boundaryVersion: '1' });
  for (const local of input.localFacts) {
    const remote = input.remoteFacts!.find(row => row.nodeId === local.sourceRefColpId)!;
    await store.putMapping(scope, { nativeId: local.nativeId, colpId: remote.nodeId, nodeKind: 'bookmark', rootNativeId: mount.nativeRootId,
      parentNativeId: mount.nativeRootId, parentColpId: folder.nodeId, projection: { revision: remote.revision,
        digest: 'sha256:local', content: { title: local.title, url: local.url! } } });
  }
  const coordinator = createBootstrapCoordinator({ store, scope });
  const run = await coordinator.confirm(input);
  const rebuilder = createReplicaRebuilder({ store, credentials, journal: storage, currentScope: async () => current,
    resetRuntime() {}, ensureScope: async () => {
      const binding = (await credentials.loadBinding())!;
      current = { ...scope, replicaId: binding.replicaId, generation: Number(binding.generation) };
      await register(current); return current;
    } });
  const report = (fetcher: typeof fetch, replicaProof: string) => sendReplicaHealthReport({ scope, store, storage,
    force: true, now: () => 10000, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    mode: async () => 'enabled', credential: async () => ({ accessToken: 'extension-health-test', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
    replicaProof: async () => replicaProof, fetch: fetcher,
    commands: { replica: () => runReplicaRebuildCommand(request => rebuilder.handle(request), scope),
      serverRebuild: () => rebuilder.rebuildServerRetired(scope),
      issue: async () => ({ outcome: 'failed', code: 'action_unavailable' }) } });
  return { store, run, report, async stallUpload() {
    await store.allocateSequenceAndEnqueue(scope, { opId: 'uncertain-upload', batchId: 'uncertain-upload',
      idempotencyKey: 'uncertain-upload', digest: 'sha256:uncertain', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: null, operationRevision: 'local-uncertain', status: 'pending', retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'update_node_content', targetId: input.localFacts[0]!.sourceRefColpId! } }, { allowUnstamped: true });
    const clock = Date.now() + 120000;
    const lease = await store.acquireLease(scope, 'uncertain-worker', clock, 30000);
    const row = (await store.claimNextQueue(scope, 'uncertain-worker', lease.fence, clock))!;
    await store.bindPushAttempt(scope, row.sequence, 'uncertain-worker', lease.fence, {
      sessionId: 'old-session', batchId: row.batchId, idempotencyKey: row.idempotencyKey, endpointIdentity: 'syncPush',
      mediaType: 'application/json', body: JSON.stringify({ sessionId: 'old-session', batchId: row.batchId, operations: [row.payload] }),
      bodyDigest: 'sha256:unknown' });
    await store.settleClaimedPush(scope, row.sequence, 'uncertain-worker', lease.fence, {
      outcome: 'unknown', retry: { attempt: 10, notBefore: 0 }, recovery: { code: 'push_response_unrecognized' } });
    return rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
  }, async resolve(fetcher: typeof fetch, session: StoredSession, accessToken: string) {
    for (const item of run.run.attention!.items) {
      const result = await handleAttentionDecide(store, scope, run.run.runId, item.itemId, 'completed', {
        decision: 'keep_local', evidenceDigest: item.evidenceDigest, input });
      if (!result.ok) throw new Error(result.error);
    }
    const base = `${scope.serverOrigin}/private-entry`;
    const endpoints: SyncEndpoints = { syncSessions: `${base}/sessions`, syncSnapshot: `${base}/snapshot`,
      syncPush: `${base}/canonical-update`, syncPull: `${base}/pull`, syncAck: `${base}/ack`,
      syncConflict: `${base}/conflicts/{conflictId}`, syncEffectPages: `${base}/effects/{effectId}/{pageNumber}`,
      effectPageAuthority: scope.serverOrigin, syncRetire: `${base}/retire` };
    const outcome = await createOutboundPushWorker({ scope, store, endpoints: async () => endpoints, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      sessions: { get: async () => ({ credential: { accessToken }, session }) }, fetch: fetcher }).drain();
    const queued = await store.listQueue(scope);
    if (queued.some(row => row.status !== 'terminal' || row.recovery)) throw new Error(JSON.stringify({ outcome, rows: queued.map(row => ({ status: row.status, recovery: row.recovery, retry: row.retry })), engine: await store.getEngineState(scope) }));
  }, async rematch(remote: readonly RemoteNodeFact[]) { return coordinator.advance(run.run.runId, { ...input, remoteFacts: remote }); },
    remoteFacts: input.remoteFacts!, freeze: () => freezeScopeRecovery(store, scope, 'recovery_identity_unproven') };
}
