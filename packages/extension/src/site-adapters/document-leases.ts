import { legacySite } from './registry.js';
import type { SourceContext } from './ledger-types.js';

export function documentLeaseKey(context: Pick<SourceContext, 'installationId' | 'documentId'>): string {
  return JSON.stringify([context.installationId ?? legacySite.adapterId, context.documentId]);
}

/** Rekey existing leases atomically; their active/expired state and original authority remain intact. */
export function migrateDocumentLeases(store: IDBObjectStore): void {
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result; if (!cursor) return;
    const row = cursor.value as { context?: SourceContext };
    if (row.context && typeof row.context.documentId === 'string') {
      const key = documentLeaseKey(row.context);
      if (cursor.key !== key) { store.add(row, key); cursor.delete(); }
    }
    cursor.continue();
  };
}
