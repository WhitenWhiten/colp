import { createAuthorityFence } from '../authority-fence.js';
import { configuredPersonalSyncPolicy, personalSyncNativeApi } from '../personal-sync-fetch.js';
import type { SyncScope } from '../sync-state-store.js';
import { rootScopeKey } from './runtime.js';
import { currentSyncScope } from './scope.js';

export type BoundaryAttempt = Awaited<ReturnType<typeof captureBoundaryAttempt>>;

/** One lease covers the whole attempt, including awaits before a native port is
 * created. A pause/resume or account A→B→A cannot revive the old command body. */
export async function captureBoundaryAttempt(scope: SyncScope) {
  const fence = createAuthorityFence(chrome.storage.local);
  const authority = await fence.capture();
  const lease = await configuredPersonalSyncPolicy()?.capture(scope);
  async function assertCurrent() {
    await fence.assertWritable(authority.generation);
    await lease?.assertCurrent();
    if (rootScopeKey(await currentSyncScope()) !== rootScopeKey(scope)) throw new Error('not_connected');
    await fence.assertWritable(authority.generation);
    lease?.assertLive();
  }
  await assertCurrent();
  return { assertCurrent, generation: authority.generation,
    nativeApi: <T extends object>(api: T) => personalSyncNativeApi(scope, api, assertCurrent) };
}
