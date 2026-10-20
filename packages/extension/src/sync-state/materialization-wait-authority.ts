import { canonicalJson } from './codec.js';
import { requestValue, scopeRowsRange } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { SyncStateError, type IntentRecord, type MappingInput, type MountBindingRecord,
  type QueueOperation, type ScopeRecord } from './types.js';

/** Ephemeral CAS input. No mapping is published by a wait confirmation: the
 * original Pull page remains the sole owner of the old-to-new identity handoff. */
export interface MaterializationWaitAuthority {
  readonly scope: ScopeRecord;
  readonly intent: IntentRecord;
  readonly rootIntent: IntentRecord;
  readonly event: Readonly<Record<string, unknown>>;
  readonly mappings: readonly (MappingInput & { readonly scopeKey: string })[];
  readonly mounts: readonly MountBindingRecord[];
  readonly exclusionNativeIds: readonly string[];
  readonly sourceColpIds: readonly string[];
  readonly candidateNativeId?: string;
}

export const MATERIALIZATION_WAIT_STORES = [STORES.mappings, STORES.mounts, STORES.localSyncExclusions, STORES.queue];

/** Re-read the identities after all asynchronous native reads, in the same
 * transaction that consumes the exact wait. A failed CAS leaves it unknown. */
export async function assertMaterializationWaitAuthority(tx: IDBTransaction, key: string,
  expected: MaterializationWaitAuthority): Promise<void> {
  const read = (store: string, id: IDBValidKey) => requestValue(tx.objectStore(store).get(id));
  const same = (actual: unknown, wanted: unknown) => {
    if (canonicalJson(actual) !== canonicalJson(wanted)) throw new SyncStateError('native_result_cas');
  };
  same(await read(STORES.scopes, key), expected.scope);
  same(await read(STORES.intents, [key, expected.intent.intentId]), expected.intent);
  same(await read(STORES.intents, [key, expected.rootIntent.intentId]), expected.rootIntent);
  same(await read(STORES.pullEvents, [key, String(expected.event.eventId)]), expected.event);
  const mounts = await requestValue<MountBindingRecord[]>(tx.objectStore(STORES.mounts).getAll(scopeRowsRange(key)));
  same(mounts.sort((a, b) => a.mountId.localeCompare(b.mountId)),
    [...expected.mounts].sort((a, b) => a.mountId.localeCompare(b.mountId)));
  const mappings = tx.objectStore(STORES.mappings);
  for (const mapping of expected.mappings) {
    same(await requestValue(mappings.get([key, mapping.nativeId])), mapping);
    same(await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, mapping.colpId])), mapping);
  }
  if (expected.candidateNativeId && await requestValue(mappings.get([key, expected.candidateNativeId]))) {
    throw new SyncStateError('native_result_cas');
  }
  for (const nativeId of expected.exclusionNativeIds) {
    if (await read(STORES.localSyncExclusions, [key, nativeId])) throw new SyncStateError('native_result_cas');
  }
  for (const colpId of expected.sourceColpIds) {
    const rows = await requestValue<QueueOperation[]>(tx.objectStore(STORES.queue).index(INDEXES.queueByTargetRevision)
      .getAll(IDBKeyRange.bound([key, colpId], [key, colpId, []])));
    if (rows.some(row => row.status !== 'terminal' && row.status !== 'rejected')) {
      throw new SyncStateError('native_result_cas');
    }
  }
}
