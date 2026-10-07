import {
  COLLECTION_VERSION_RESTORE_RECEIPT_FIFO_LIMIT,
  CollectionVersionRestoreReceiptConflictError,
  type CollectionVersionRestoreReceiptRow,
  type CollectionVersionRestoreReceiptStore,
} from '../../src/modules/collections/index.js';

export function createMemoryCollectionVersionRestoreReceiptStore(
  options: { readonly fifoLimit?: number } = {},
): CollectionVersionRestoreReceiptStore & { readonly rows: CollectionVersionRestoreReceiptRow[] } {
  const fifoLimit = options.fifoLimit ?? COLLECTION_VERSION_RESTORE_RECEIPT_FIFO_LIMIT;
  const rows: CollectionVersionRestoreReceiptRow[] = [];
  return {
    rows,
    async getByCommandId(accountId, commandId) {
      return rows.find((row) => row.accountId === accountId && row.commandId === commandId) ?? null;
    },
    async persist(row) {
      if (rows.some((existing) => existing.commandId === row.commandId)) {
        throw new CollectionVersionRestoreReceiptConflictError();
      }
      rows.push(row);
      const forCollection = rows
        .filter((item) => item.collectionId === row.collectionId)
        .sort((left, right) => {
          const time = left.createdAt.getTime() - right.createdAt.getTime();
          if (time !== 0) return time;
          return left.commandId < right.commandId ? -1 : 1;
        });
      const extra = forCollection.length - fifoLimit;
      if (extra <= 0) return;
      const victims = new Set(forCollection.slice(0, extra).map((item) => item.commandId));
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (victims.has(rows[index]!.commandId)) rows.splice(index, 1);
      }
    },
  };
}
