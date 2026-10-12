import type { BookmarkFaviconObjectStore } from './favicon-store.js';
import type { CollectionsUnitOfWork, CollectionsWritePorts } from './ports.js';

type Orphan = {
  readonly objectId: string;
  readonly nodeId: string;
  readonly collectionId: string;
  readonly at: Date;
};

export interface FaviconCommandWriteContext {
  readonly store: BookmarkFaviconObjectStore;
  readonly orphanLedger: (input: Orphan) => Promise<void>;
}

/**
 * Database bytes share the command transaction. External PUTs are tracked so
 * a binding/receipt/commit failure can retire them after the transaction releases
 * its connection. A live binding protects against a commit acknowledgement failure.
 */
export async function executeFaviconCommand<T>(
  unitOfWork: CollectionsUnitOfWork,
  store: BookmarkFaviconObjectStore,
  target: { readonly collectionId: string; readonly nodeId: string },
  work: (ports: CollectionsWritePorts, context: FaviconCommandWriteContext) => Promise<T>,
  options: { readonly signal?: AbortSignal; readonly onCleanupFailure?: () => void } = {},
): Promise<T> {
  const orphans = new Map<string, Orphan>();
  try {
    return await unitOfWork.execute(async ports => {
      const writeStore = store.writeTransaction === 'required' ? ports.faviconStore : store;
      if (!writeStore || (store.writeTransaction === 'required' && writeStore.writeTransaction !== 'bound')) {
        throw new Error('Database favicon uploads require a transaction-bound object store');
      }
      const tracked: BookmarkFaviconObjectStore = {
        writeTransaction: writeStore.writeTransaction,
        get: (id, input) => writeStore.get(id, input),
        delete: id => writeStore.delete(id),
        async put(id, bytes, contentType) {
          if (writeStore.writeTransaction !== 'bound') {
            orphans.set(id, { ...target, objectId: id, at: new Date() });
          }
          await writeStore.put(id, bytes, contentType);
        },
      };
      return work(ports, {
        store: tracked,
        async orphanLedger(input) { orphans.set(input.objectId, input); },
      });
    }, { signal: options.signal });
  } catch (error) {
    for (const orphan of orphans.values()) {
      try {
        await unitOfWork.execute(async ports => {
          if (!ports.bookmarkIcons || !ports.faviconGc) throw new Error('Favicon cleanup ports are unavailable');
          const bound = await ports.bookmarkIcons.findByNodeId(orphan.nodeId);
          if (bound?.objectId === orphan.objectId) return;
          await ports.faviconGc.recordRetired({
            objectId: orphan.objectId, nodeId: orphan.nodeId, collectionId: orphan.collectionId,
            retiredAt: orphan.at, deletableAt: orphan.at,
          });
        });
      } catch {
        try { options.onCleanupFailure?.(); } catch { /* Telemetry cannot mask the command failure. */ }
      }
    }
    throw error;
  }
}
