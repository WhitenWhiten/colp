import type { MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';
type Store = ReturnType<typeof createSyncStateStore>;

export async function detachScopeMount(store: Store, scope: SyncScope, mountId: string): Promise<MountBindingRecord> {
  const cursor = (await store.getCursor(scope))?.cursor
    ?? (await store.getScope(scope))?.checkpoint?.cursor ?? null;
  const current = await store.getMountBinding(scope, mountId);
  if (!current) throw new Error('mount_not_found');
  if (current.status === 'detached') return current;
  return store.detachMount(scope, mountId, {
    generation: scope.generation, boundaryVersion: current.boundaryVersion,
    lastAppliedCursor: cursor, completeness: cursor ? 'complete' : 'unknown',
  });
}
