import { canonicalJson } from './codec.js';
import { requestValue, scopeRowsRange } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { SyncStateError, type IntentRecord, type MappingInput, type MountBindingRecord,
  type JsonObject, type QueueOperation, type ScopeRecord } from './types.js';

/** Child create intents keep their own receipt; this exact owner tuple links
 * their wait to the containing Pull event without borrowing its API evidence. */
export function materializationChildEventId(intent: IntentRecord): string | undefined {
  return !intent.eventId && intent.substep === 'range-materialize' && intent.liveWorkKind === 'create'
    && intent.commandId?.startsWith('rx:') && intent.colpId
    && intent.intentId === `intent:${intent.operationId}:range:${intent.colpId}` ? intent.operationId : undefined;
}

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

/** Only a currently started, uniquely correlated child may observe onCreated.
 * This is a candidate for a later user decision, never api_return evidence. */
export async function observeMaterializationCandidate(tx: IDBTransaction, key: string,
  correlationId: string, evidence: JsonObject): Promise<boolean> {
  if (typeof evidence.nativeId !== 'string' || evidence.eventDigest !== correlationId) return false;
  const store = tx.objectStore(STORES.intents);
  const rows = await requestValue<IntentRecord[]>(store.index(INDEXES.intentByLiveWork)
    .getAll(IDBKeyRange.bound([key, 'create'], [key, 'create', []])));
  const candidates = rows.filter(row => materializationChildEventId(row)
    && row.replayState === 'started' && row.state === 'browser_call_started' && row.expiresAt > Date.now()
    && row.anchors?.rangeCorrelationId === correlationId
    && !(Array.isArray(row.anchors.beforeNativeIds) && row.anchors.beforeNativeIds.includes(evidence.nativeId!)));
  if (candidates.length !== 1) return false;
  const intent = candidates[0]!, eventId = materializationChildEventId(intent)!;
  const root = await requestValue<IntentRecord | undefined>(store.get([key, `intent:${eventId}`]));
  const event = await requestValue<{ state: string; intentId: string } | undefined>(
    tx.objectStore(STORES.pullEvents).get([key, eventId]));
  if (!root || root.generation !== intent.generation || root.eventId !== eventId
      || root.anchors?.rangeAction !== 'materialize_independent' || root.anchors.subtreeCommandId !== intent.commandId
      || !Array.isArray(root.anchors.nodes) || !root.anchors.nodes.some(node => node && typeof node === 'object'
        && !Array.isArray(node) && node.colpId === intent.colpId)
      || !event || event.intentId !== root.intentId || !['browser_call_started', 'native_event_observed'].includes(event.state)
      || intent.nativeEventEvidence && canonicalJson(intent.nativeEventEvidence) !== canonicalJson(evidence)) return false;
  store.put({ ...intent, state: 'native_event_observed', apiPhase: 'native_event_observed', nativeEventEvidence: evidence });
  return true;
}
