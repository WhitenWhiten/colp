import { managedLibraryKey, type ManagedLibrary } from './copy-identity.js';
import { managedSlotKey } from './managed-saves.js';
import type { ManagedBinding, ManagedSlot } from './managed-client.js';
import { get, put, sourceKey, type SourceDatabase } from './source-db.js';
export const sharedBindingKey = (library: ManagedLibrary, slot: ManagedSlot) => sourceKey('sharedBinding', managedLibraryKey(library), managedSlotKey(library.collectionId, slot));
/** A positive cache. Missing pages never delete associations or prove source absence. */
export function createSharedCatalog(db: SourceDatabase, ports: {
  list(library: ManagedLibrary, after: string | null): Promise<{ bindings: ManagedBinding[]; nextCursor: string | null }>;
  schedule(at: number): void; now?(): number;
}) {
  const now = ports.now ?? Date.now;
  return {
    read: (library: ManagedLibrary, slot: ManagedSlot) => db.read<ManagedBinding>('meta', sharedBindingKey(library, slot)),
    async refresh(library: ManagedLibrary) {
      const key = sourceKey('sharedCatalog', managedLibraryKey(library));
      const progress = await db.read<{ cursor: string | null; dueAt: number }>('meta', key);
      if (progress && progress.dueAt > now()) { ports.schedule(progress.dueAt); return; }
      ports.schedule(now() + 30000);
      const page = await ports.list(library, progress?.cursor ?? null);
      if (!Array.isArray(page.bindings) || page.bindings.length > 100 || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor === progress?.cursor)) throw Error('sourceSyncInvalid');
      await db.transaction(['meta'], 'readwrite', async tx => {
        for (const binding of page.bindings) {
          if (binding.collectionId !== library.collectionId || !binding.node?.nodeId || !['active', 'detached', 'suppressed'].includes(binding.state)) throw Error('sourceSyncInvalid');
          const bindingKey = sharedBindingKey(library, binding.slot), old = await get<ManagedBinding>(tx, 'meta', bindingKey);
          if (!old || (old.controlRevision ?? 0) <= (binding.controlRevision ?? 0)) put(tx, 'meta', bindingKey, binding);
        }
        put(tx, 'meta', key, { cursor: page.nextCursor, dueAt: now() + (page.nextCursor ? 50 : 30000) });
      });
      ports.schedule(now() + (page.nextCursor ? 50 : 30000));
    },
  };
}
