import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getCurrentPullMapping'>;

/** Page-local shadow, including deletes not yet published. Not Ack/cursor authority. */
export async function currentPullMapping(store: Store, scope: SyncScope, colpId: string): Promise<MappingInput | null> {
  return store.getCurrentPullMapping(scope, colpId);
}
