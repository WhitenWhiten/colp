import { createSharedCatalog } from './shared-catalog.js';
import { siteLedger } from './source-runtime.js';
import { managedClientForLibrary, projectManagedBinding } from './managed-runtime.js';
import type { ManagedBinding, ManagedSlot } from './managed-client.js';
import { managedLibraryKey, type ManagedLibrary } from './copy-identity.js';
import { currentSyncScope } from '../sw/scope.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
export const sharedCatalog = createSharedCatalog(siteLedger.db, {
  async list(library, after) {
    const client = await managedClientForLibrary(library); await client.profile();
    return client.call<{ bindings: ManagedBinding[]; nextCursor: string | null }>('managed.list', { collectionId: library.collectionId, after });
  }, schedule: scheduleSourceAlarm,
});
let refreshing: Promise<void> | undefined;
export function refreshSharedCatalog() {
  return refreshing ??= (async () => {
    const scope = await currentSyncScope().catch(() => null);
    if (scope) await sharedCatalog.refresh(scope);
  })().finally(() => { refreshing = undefined; });
}
/** Uses only local cache and ordinary Sync mappings; an outage cannot delay a new save. */
export async function cachedSharedCopy(library: ManagedLibrary | null, slot: ManagedSlot, id: string) {
  if (!library) return null;
  const scope = await currentSyncScope({ allowStopped: true }).catch(() => null);
  if (!scope || managedLibraryKey(scope) !== managedLibraryKey(library)) return null;
  const binding = await sharedCatalog.read(library, slot); if (!binding) return null;
  const projected = await projectManagedBinding(library, binding, id, true); if (!projected) return null;
  return { native: projected.native, written: { title: binding.node.title, parentId: projected.parentId,
    ...(binding.node.url === null ? {} : { url: binding.node.url }) },
    shared: { library, slot, nodeId: binding.node.nodeId, controlRevision: binding.controlRevision ?? 0 } };
}
