import { createPersonalSyncLifecycle } from '../personal-sync-lifecycle.js';
import { browserPersonalSyncPolicy, type PersonalSyncIdentity } from '../personal-sync-policy.js';
import { createRememberedConnectionStore } from '../personal-sync-connection.js';
import { nativeTreeProof, localProofDigest } from '../native-tree-proof.js';
import { isProtocolOpaqueId } from '../protocol-id.js';
import { store, sw, syncState, hasBookmarkPermission, workCoordinator, COLLECTION_BINDING } from './runtime.js';
import { boundCollectionId, currentSyncScope, pushSessionAuthority } from './scope.js';
import { verifyLibraryAvailability } from './library.js';
import { scheduleSyncEngineWake } from './engine.js';
import { captureStore } from './capture.js';
import { browserHistoryStore, BROWSER_HISTORY_RETENTION_MS } from '../capture/browser-history-store.js';
import { currentCaptureScope } from './capture-native.js';
import { recoverBookmarkEventsAfterEngineSettles } from './bookmarks.js';

const connections = () => createRememberedConnectionStore(chrome.storage.local);
export async function personalSyncIdentity() {
  const credential = await store.loadCredential();
  if (!credential?.subject) throw new Error('not_connected');
  const owner = { serverOrigin: credential.serverOrigin, accountId: credential.subject };
  const collectionId = await boundCollectionId() ?? (await connections().read(owner))?.collectionId;
  if (!collectionId || !isProtocolOpaqueId(collectionId)) throw new Error('collection_required');
  return { ...owner, collectionId };
}
export function resetPersonalSyncRuntime() {
  sw.bindingPromise = undefined; sw.bookmarkEventQueue = undefined;
  sw.bookmarkEventScopeKey = undefined; sw.rootViewTokens = undefined;
}
/** Remember a fresh, non-secret replica identity; retired work can never revive on login. */
export async function rememberPersonalConnection(identity: PersonalSyncIdentity & { collectionId: string }) {
  const binding = await store.loadBinding();
  if (binding) await connections().write(identity, { version: 1, collectionId: identity.collectionId,
    binding: { replicaId: `replica-${crypto.randomUUID()}`, browserProfileId: binding.browserProfileId, generation: '1' } });
}
export async function suspendPersonalSyncForLogout() {
  const identity = await personalSyncIdentity().catch(() => null);
  if (identity) {
    await browserPersonalSyncPolicy().write(identity, 'paused', 'signed-out');
    await rememberPersonalConnection(identity);
  }
  const owner = await currentCaptureScope();
  let before: readonly [number, string] | undefined;
  // Migrate the current caller's successful native facts before private history
  // becomes inaccessible. This never reads a different account's command ledger.
  for (;;) {
    const page = await captureStore.listForOwner(owner, before).catch(() => []);
    await browserHistoryStore.rememberMany(page).catch(() => undefined);
    const last = page.at(-1);
    if (!last || page.length < 50 || last.createdAt < Date.now() - BROWSER_HISTORY_RETENTION_MS) break;
    before = [last.createdAt, last.captureId];
  }
}
let lifecycle: ReturnType<typeof createPersonalSyncLifecycle> | undefined;
export function personalSyncLifecycle() {
  return lifecycle ??= createPersonalSyncLifecycle({ policy: browserPersonalSyncPolicy(), identity: personalSyncIdentity,
    generation: async () => (await store.fence.capture()).generation,
    assertCurrent: async generation => { await store.assertWritable(generation); },
    async facts() {
      const scope = await currentSyncScope({ allowStopped: true }).catch(() => null);
      const exported = scope && await syncState.getScope(scope) ? await syncState.exportScope(scope) : null;
      const tree = await hasBookmarkPermission() ? nativeTreeProof(await chrome.bookmarks.getTree()) : null;
      const identity = await personalSyncIdentity();
      const metadata = (await chrome.storage.local.get('known.metadata-sync-policy.v1:' + JSON.stringify([
        identity.serverOrigin, identity.accountId, identity.collectionId])));
      const queue = (exported?.queue ?? []) as readonly { status: string }[];
      const proof = exported ? { scope: exported.scope, queue: exported.queue, mountBindings: exported.mountBindings,
        advancedPlans: exported.advancedPlans, bootstrapRuns: exported.bootstrapRuns, importPlans: exported.importPlans,
        ackIntents: exported.ackIntents } : null;
      return { digest: await localProofDigest([tree, proof, metadata]),
        queued: queue.filter(row => !['terminal', 'rejected'].includes(row.status)).length, attached: exported !== null || Boolean(await boundCollectionId() && await store.loadBinding()) };
    },
    available: verifyLibraryAvailability,
    async disconnect(identity, generation) {
      await store.assertWritable(generation);
      await rememberPersonalConnection(identity);
      await workCoordinator.run('engine', async () => {
        await store.assertWritable(generation);
        const scope = await currentSyncScope({ allowStopped: true }).catch(() => null);
        await store.assertWritable(generation);
        if (scope && (scope.accountId !== identity.accountId || scope.collectionId !== identity.collectionId)) throw new Error('account_switch');
        if (scope && await syncState.getScope(scope)) await syncState.retireScope(scope, { retiredAt: Date.now(), reason: 'user_personal_sync_disconnect' });
      });
      await workCoordinator.run('auth', async () => {
        await store.assertWritable(generation);
        await store.clearBinding();
        await chrome.storage.local.remove(COLLECTION_BINDING);
        resetPersonalSyncRuntime();
      });
    },
    async reconnect(identity, generation, publish) {
      await workCoordinator.run('auth', () => publish(async () => {
        await store.assertWritable(generation);
        if (await boundCollectionId() && await store.loadBinding()) return;
        const remembered = await connections().read(identity);
        if (!remembered) throw new Error('connection_invalid');
        const unbound = await store.loadBinding();
        if (unbound && unbound.replicaId !== remembered.binding.replicaId) {
          // Read-only folder views may provision an unused identity after login.
          // Replace only an unbound identity without a Session, under the auth lane.
          if (await boundCollectionId() || await store.loadSession()) throw new Error('binding_mismatch');
          await store.replaceBindingForRebuild(generation, unbound.replicaId, remembered.binding);
        } else await store.restoreBinding(remembered.binding, generation);
        await store.assertWritable(generation);
        await chrome.storage.local.set({ [COLLECTION_BINDING]: remembered.collectionId });
        resetPersonalSyncRuntime();
      }));
    },
    wake() {
      void pushSessionAuthority().then(() => recoverBookmarkEventsAfterEngineSettles('manual'))
        .catch(() => { void scheduleSyncEngineWake('manual').catch(() => undefined); });
    },
  });
}
