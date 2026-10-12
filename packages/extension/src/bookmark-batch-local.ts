import { createLocalBatchStore } from './bookmark-batch-local-store.js';
import { migrateLegacyLocalBatches } from './bookmark-batch-local-migration.js';

let ready: Promise<ReturnType<typeof createLocalBatchStore>> | undefined;
let migration: Promise<void> | undefined;
/** One profile-owned journal; account state and sync-store health never authorize its writes. */
export function localBookmarkBatchStore(): Promise<ReturnType<typeof createLocalBatchStore>> {
  return ready ??= Promise.resolve(createLocalBatchStore());
}

/** Compatibility reads stay out of the admission path for new native commands. */
export async function recoverLegacyLocalBookmarkBatches(): Promise<void> {
  const store = await localBookmarkBatchStore();
  await (migration ??= migrateLegacyLocalBatches(store, indexedDB).catch(() => { migration = undefined; }));
}
