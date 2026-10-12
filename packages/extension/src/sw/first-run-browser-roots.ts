import type { createSyncStateStore, SyncScope } from '../sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

/** Persist first-run native selection as selectedRoots COLP ids (same authority as range confirm). */
export async function persistFirstRunBrowserRoots(store: Store, scope: SyncScope, input: {
  readonly discovered: readonly { nativeId: string; ancestorNativeIds: readonly string[] }[];
  readonly selectedNativeIds: readonly string[];
  readonly privateNativeIds?: readonly string[];
}): Promise<void> {
  const selected = new Set(input.selectedNativeIds);
  for (const mount of await store.listMountBindings(scope)) {
    if (!selected.has(mount.nativeRootId) || !mount.remoteMountNodeId) continue;
    await store.bindMountMapping(scope, {
      nativeId: mount.nativeRootId, colpId: mount.remoteMountNodeId, mountId: mount.mountId,
      ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
      revision: 'rev-mount-root',
    });
  }
  await store.configureBrowserRoots(scope, {
    discovered: input.discovered, selectedNativeIds: input.selectedNativeIds,
    privateNativeIds: input.privateNativeIds ?? [], status: 'ready',
  });
}
