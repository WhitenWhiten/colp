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
  const run = await createBootstrapCoordinator({ store, scope }).confirm(input);
  await freezeScopeRecovery(store, scope, 'recovery_identity_unproven');
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
      issue: async () => ({ outcome: 'failed', code: 'action_unavailable' }) } });
  return { store, run, report };
}
