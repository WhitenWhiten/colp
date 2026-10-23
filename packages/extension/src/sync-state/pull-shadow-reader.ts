import { pendingPullMapping } from '../pull-mapping-view.js';
import { boundedString } from './codec.js';
import { requestValue, transactionDone } from './idb.js';
import { orderEventsByPageChain } from './pull-workset.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { SyncStoreRuntime } from './runtime.js';
import { SyncStateError, type MappingInput, type SyncScope, type UnknownRecord } from './types.js';

/** Committed shadow payloads are immutable until their event leaves this state. */
export function createPullShadowReader(ctx: SyncStoreRuntime,
  validate: (key: string, value: unknown, maxBytes: number) => MappingInput) {
  let cached: { db: IDBDatabase; key: string; events: ReadonlyMap<string, UnknownRecord> } | undefined;
  return async function getCurrentPullMapping(input: SyncScope, colpId: string): Promise<MappingInput | null> {
    const key = scopeKey(validateScope(input)); boundedString(colpId, 'colpId'); const db = await ctx.open();
    const prior = cached?.db === db && cached.key === key ? cached.events : new Map<string, UnknownRecord>();
    const tx = db.transaction([STORES.pullEvents, STORES.pullPages, STORES.mappings], 'readonly');
    const done = transactionDone(tx); const events = tx.objectStore(STORES.pullEvents);
    const keys = await requestValue(events.index(INDEXES.pullEventByState)
      .getAllKeys(IDBKeyRange.bound([key, 'authority_committed'], [key, 'authority_committed', []])));
    const current = new Map<string, UnknownRecord>();
    for (const primary of keys) {
      const eventId = String((primary as IDBValidKey[])[1]); const known = prior.get(eventId);
      if (known) { current.set(eventId, known); continue; }
      const event = await requestValue<UnknownRecord>(events.get(primary));
      // Retain only projection facts; immutable operation/effect payloads do not
      // need another transfer for every parent or anchor lookup on this page.
      current.set(eventId, { eventId, pageId: event.pageId, ordinal: event.ordinal,
        pendingMappings: event.pendingMappings ?? [], pendingDeleteNativeIds: event.pendingDeleteNativeIds ?? [],
        pendingRangeExit: { unbindNativeIds: (event.pendingRangeExit as UnknownRecord | undefined)?.unbindNativeIds ?? [] } });
    }
    const pages = await Promise.all([...new Set([...current.values()].map(event => String(event.pageId)))].map(pageId =>
      requestValue<UnknownRecord>(tx.objectStore(STORES.pullPages).get([key, pageId]))));
    const shadow = pendingPullMapping(orderEventsByPageChain([...current.values()], pages.filter(Boolean)), colpId);
    const raw = shadow.mapping ?? await requestValue<MappingInput | undefined>(tx.objectStore(STORES.mappings)
      .index(INDEXES.mappingByColpId).get([key, colpId]));
    await done; cached = { db, key, events: current };
    if (!raw || !shadow.mapping && shadow.deleted.has(raw.nativeId)) return null;
    const stored = raw as MappingInput & { scopeKey?: string };
    if (stored.scopeKey !== undefined && stored.scopeKey !== key) throw new SyncStateError('mapping_scope_invalid');
    return validate(key, { ...stored, scopeKey: key }, ctx.maxRecordBytes);
  };
}
