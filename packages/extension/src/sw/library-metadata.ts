import { releaseMetadataBindings } from '../metadata-transfer.js';
import { browserMetadataSyncPolicy } from '../metadata-sync-policy.js';
import { store, workCoordinator } from './runtime.js';
import { boundCollectionId } from './scope.js';
import { scheduleSyncEngineWake } from './engine.js';

/** Change metadata consent for the bound library without changing its identity or minting a session. */
export async function configureLibraryMetadata(enabled: boolean): Promise<{ readonly ok: true }> {
  const authority = await store.fence.capture();
  const credential = await store.loadCredential(), collectionId = await boundCollectionId();
  if (!credential?.subject || !collectionId) throw new Error('not_connected');
  const identity = { serverOrigin: credential.serverOrigin, accountId: credential.subject, collectionId };
  const current = async () => {
    await store.assertWritable(authority.generation);
    const live = await store.loadCredential();
    if (live?.subject !== credential.subject || live?.serverOrigin !== credential.serverOrigin
      || await boundCollectionId() !== collectionId) throw new Error('account_switch');
  };
  await current();
  const policy = browserMetadataSyncPolicy();
  // Staying local is immediate and remains available offline. Positive consent
  // stays gated while old metadata bindings are released.
  await policy.write(identity, false);
  if (enabled) {
    await workCoordinator.run('local-bookmark', () => releaseMetadataBindings());
    await current();
    await policy.write(identity, true);
    scheduleSyncEngineWake('manual');
  }
  return { ok: true };
}
