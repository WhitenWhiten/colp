import { managedLibraryKey, type ManagedLibrary, type ManagedContent } from './copy-identity.js';
import { managedSlotKey } from './managed-saves.js';
import type { ManagedBinding, ManagedSlot } from './managed-client.js';
import { get, put, sourceKey, sourcePrefixRange, type SourceDatabase } from './source-db.js';
import { cursorPage } from '../sync-state/idb.js';
export const sharedBindingKey = (library: ManagedLibrary, slot: ManagedSlot) => sourceKey('sharedBinding', managedLibraryKey(library), managedSlotKey(library.collectionId, slot));
const contentParts = (library: ManagedLibrary, content: ManagedContent) => ['sharedContent', managedLibraryKey(library), content.site, content.identityVersion, content.accountId, content.itemId] as const;
/** A positive cache. Missing pages never delete associations or prove source absence. */
export function createSharedCatalog(db: SourceDatabase, ports: {
  list(library: ManagedLibrary, after: string | null): Promise<{ bindings: ManagedBinding[]; nextCursor: string | null }>;
  schedule(at: number): void; now?(): number;
}) {
  const now = ports.now ?? Date.now;
  return {
    read: (library: ManagedLibrary, slot: ManagedSlot) => db.read<ManagedBinding>('meta', sharedBindingKey(library, slot)),
    async content(library: ManagedLibrary, content: ManagedContent) {
      const values = await db.transaction(['meta'], 'readonly', tx => cursorPage<ManagedBinding>(tx.objectStore('meta'), sourcePrefixRange(...contentParts(library, content)), 1001));
      if (values.length > 1000) throw Error('capacity'); return values;
    },
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
          if (!old || (old.controlRevision ?? 0) <= (binding.controlRevision ?? 0)) {
            put(tx, 'meta', bindingKey, binding);
            if (binding.slot.kind === 'bookmark') put(tx, 'meta', sourceKey(...contentParts(library, binding.slot.copy.content), managedSlotKey(library.collectionId, binding.slot)), binding);
          }
        }
        put(tx, 'meta', key, { cursor: page.nextCursor, dueAt: now() + (page.nextCursor ? 50 : 30000) });
      });
      ports.schedule(now() + (page.nextCursor ? 50 : 30000));
    },
  };
}
