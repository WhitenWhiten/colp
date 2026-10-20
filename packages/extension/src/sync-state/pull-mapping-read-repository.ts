import { boundedString, clone } from './codec.js';
import { requestValue, transactionDone } from './idb.js';
import { validateMappingRecord } from './mapping-repository.js';
import { readOrderedPullEventsInTransaction } from './pull-workset.js';
import type { SyncStoreRuntime } from './runtime.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { MappingInput, SyncScope, UnknownRecord } from './types.js';

/** Fresh page-local shadows and durable fallback; never Ack or cursor authority. */
export function createPullMappingReadRepository(ctx: SyncStoreRuntime) {
  async function getCurrentPullMapping(input: SyncScope, colpId: string): Promise<MappingInput | null> {
    const key = scopeKey(validateScope(input)); const target = boundedString(colpId, 'colpId');
    const db = await ctx.open();
    const tx = db.transaction([STORES.pullEvents, STORES.pullPages, STORES.mappings], 'readonly');
    const completion = transactionDone(tx);
    try {
      // These facts must share one snapshot: publishing a page deletes its
      // shadows and installs their mappings in the same write transaction.
      const [events, rawDurable] = await Promise.all([
        readOrderedPullEventsInTransaction(tx, key, ['authority_committed']),
        requestValue(tx.objectStore(STORES.mappings).index(INDEXES.mappingByColpId).get([key, target])),
      ]);
      await completion;
      const deleted = new Set<string>();
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        const mapping = ((event.pendingMappings as MappingInput[] | undefined) ?? [])
          .find(candidate => candidate.colpId === target);
        // A single commit deletes/unbinds before putting its replacement.
        if (mapping && !deleted.has(mapping.nativeId)) return clone(mapping);
        addDeletedNativeIds(event, deleted);
      }
      // Preserve the durable codec boundary, but do not validate an unrelated
      // durable row when the pending mapping already supplies the result.
      const durable = rawDurable ? validateMappingRecord(key, rawDurable, ctx.maxRecordBytes) : null;
      return durable && !deleted.has(durable.nativeId) ? clone(durable) : null;
    } catch (error) {
      await completion.catch(() => undefined);
      throw error;
    }
  }
  return { getCurrentPullMapping };
}

function addDeletedNativeIds(event: UnknownRecord, deleted: Set<string>): void {
  for (const nativeId of (event.pendingDeleteNativeIds as string[] | undefined) ?? []) deleted.add(nativeId);
  const exit = event.pendingRangeExit as { readonly unbindNativeIds?: string[] } | undefined;
  for (const nativeId of exit?.unbindNativeIds ?? []) deleted.add(nativeId);
}
