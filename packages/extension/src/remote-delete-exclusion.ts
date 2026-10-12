import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getLocalSyncExclusion'>;

export async function nativeIsLocallyExcluded(store: Store, scope: SyncScope,
  nativeId: string, ancestors: readonly string[] = []): Promise<boolean> {
  for (const id of [nativeId, ...ancestors]) {
    if (!id) continue;
    if (await store.getLocalSyncExclusion(scope, id)) return true;
  }
  return false;
}
