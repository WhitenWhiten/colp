import { requestValue, runTransaction } from './idb.js';
import { STORES } from './schema.js';
import type { SyncStoreRuntime } from './runtime.js';

/** Tag confirmation records are retired: since 7b2c508c1 a chosen AI tag is the bookmark's own metadata.
 * The store stays in the schema so this database keeps its version; an update empties it. */
export function createClassificationRepository(ctx: SyncStoreRuntime) {
  return {
    async clearRetiredClassificationIntents(): Promise<void> {
      const db = await ctx.writableDatabase();
      await runTransaction(db, [STORES.classificationIntents], 'readwrite', async tx => {
        await requestValue(tx.objectStore(STORES.classificationIntents).clear());
      });
    },
  };
}
