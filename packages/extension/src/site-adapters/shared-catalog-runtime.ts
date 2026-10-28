import { createSharedCatalog } from './shared-catalog.js';
import { siteLedger } from './source-runtime.js';
import { managedClientForLibrary, projectManagedBinding } from './managed-runtime.js';
import type { ManagedBinding, ManagedSlot } from './managed-client.js';
import { managedLibraryKey, type ManagedLibrary, type ManagedContent } from './copy-identity.js';
import { currentSyncScope } from '../sw/scope.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
import { refreshSharedProjection } from './shared-projection.js';
export const sharedCatalog = createSharedCatalog(siteLedger.db, {
  async list(library, after) {
    const client = await managedClientForLibrary(library); await client.profile();
    const page = await client.call<{ bindings: ManagedBinding[]; nextCursor: string | null }>('managed.list', { collectionId: library.collectionId, after });
    if (!Array.isArray(page.bindings) || page.bindings.length > 100) throw Error('sourceSyncInvalid');
    for (const binding of page.bindings) {
      if (binding.collectionId !== library.collectionId) throw Error('sourceSyncInvalid');
      const projection = await projectManagedBinding(library, binding, 'shared-refresh', true).catch(() => null);
      if (projection) await refreshSharedProjection(siteLedger.db, library, binding, projection);
    }
    return page;
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
/** A single-copy policy may reuse a source role before any semantic role exists on this device. */
export async function cachedSingleCopy(library: ManagedLibrary, content: ManagedContent, id: string) {
  const bindings = await sharedCatalog.content(library, content);
  if (bindings.some(b => b.state !== 'active')) throw Error('content_binding_needs_review');
  if (new Set(bindings.map(b => b.node.nodeId)).size > 1) throw Error('multiple_copies_need_review');
  const binding = bindings.find(b => b.slot.kind === 'bookmark' && b.slot.copy.purpose === 'semantic') ?? bindings[0];
  if (!binding || binding.slot.kind !== 'bookmark') return null;
  const copy = await cachedSharedCopy(library, binding.slot, id);
  return copy?.native.kind === 'bookmark' && copy.written.url ? { native: copy.native as import('./contracts.js').NativeBinding<'bookmark'>,
    shared: copy.shared, purpose: binding.slot.copy.purpose, title: copy.written.title, url: copy.written.url, parentId: copy.written.parentId } : null;
}
