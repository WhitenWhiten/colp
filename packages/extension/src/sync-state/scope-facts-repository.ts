import { validateScopeCommandPlan } from './scope-command-record.js';
export { validateScopeCommandPlan } from './scope-command-record.js';
import { readScopeCommandRecord, writeScopeCommandRecord } from './scope-command-evidence.js';
import { mergeRemoteObservation } from './remote-observation.js';
import {
  SyncStateError, type JsonObject, type LocalExclusionSourceKind, type MappingInput,
  type MountPauseBaseline, type MountPauseCompleteness, type RemoteObservationKind,
  type RemoteObservationRecord,
  type ScopeCommandPlanRecord, type SyncScope, type UnknownRecord,
} from './types.js';
import { boundedString, clone, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';
import { constraintError } from './errors.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateMapping, validateMappingRecord } from './mapping-repository.js';
import { validateLocalSyncExclusion, type LocalSyncExclusionRecord } from './remote-delete-repository.js';
import type { SyncStoreRuntime } from './runtime.js';

const OBSERVATION_KINDS: readonly RemoteObservationKind[] = ['content', 'placement', 'tombstone'];

export function createScopeFactsRepository(ctx: SyncStoreRuntime) {
  const keyFor = (scope: SyncScope) => scopeKey(validateScope(scope));

  async function putRemoteObservation(scope: SyncScope, row: Omit<RemoteObservationRecord, 'scopeKey'>):
    Promise<RemoteObservationRecord> {
    ctx.assertWritable(); const key = keyFor(scope);
    const record = validateRemoteObservation(key, { ...row, scopeKey: key }, ctx.maxRecordBytes);
    const db = await ctx.writableDatabase();
    try {
      await runTransaction(db, [STORES.scopes, STORES.remoteObservations], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key);
        const observations = tx.objectStore(STORES.remoteObservations);
        const prior = await requestValue(observations.get([key, record.colpId])) as RemoteObservationRecord | undefined;
        observations.put(mergeRemoteObservation(prior, record));
      });
    } catch (error) { throw constraintError(error); }
    return clone(record);
  }

  async function getRemoteObservation(scope: SyncScope, colpId: string): Promise<RemoteObservationRecord | null> {
    const key = keyFor(scope); const id = boundedString(colpId, 'colpId');
    const db = await ctx.open(); const tx = db.transaction(STORES.remoteObservations, 'readonly');
    const done = transactionDone(tx);
    const raw = await requestValue(tx.objectStore(STORES.remoteObservations).get([key, id]));
    await done; return raw ? clone(validateRemoteObservation(key, raw, ctx.maxRecordBytes)) : null;
  }

  async function listRemoteObservations(scope: SyncScope): Promise<RemoteObservationRecord[]> {
    const key = keyFor(scope); const db = await ctx.open();
    const tx = db.transaction(STORES.remoteObservations, 'readonly'); const done = transactionDone(tx);
    const rows = await cursorPage<UnknownRecord>(tx.objectStore(STORES.remoteObservations),
      scopeRowsRange(key), 20_000);
    await done; return rows.map((row) => clone(validateRemoteObservation(key, row, ctx.maxRecordBytes)));
  }

  async function deleteRemoteObservations(scope: SyncScope, colpIds: readonly string[]): Promise<void> {
    ctx.assertWritable(); const key = keyFor(scope);
    const ids = [...new Set(colpIds.map((id) => boundedString(id, 'colpId')))];
    if (!ids.length) return;
    const db = await ctx.writableDatabase();
    try {
      await runTransaction(db, [STORES.scopes, STORES.remoteObservations], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key);
        const observations = tx.objectStore(STORES.remoteObservations);
        for (const colpId of ids) observations.delete([key, colpId]);
      });
    } catch (error) { throw constraintError(error); }
  }

  async function putScopeCommandPlan(scope: SyncScope, row: Omit<ScopeCommandPlanRecord, 'scopeKey'>):
    Promise<ScopeCommandPlanRecord> {
    ctx.assertWritable(); const key = keyFor(scope);
    const record = validateScopeCommandPlan(key, { ...row, scopeKey: key }, Number.MAX_SAFE_INTEGER);
    const db = await ctx.writableDatabase();
    try {
      await runTransaction(db, [STORES.scopes, STORES.scopeCommandPlans, STORES.metadata], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key);
        await writeScopeCommandRecord(tx, key, record, ctx.maxRecordBytes);
      });
    } catch (error) { throw constraintError(error); }
    return clone(record);
  }

  async function getScopeCommandPlan(scope: SyncScope, commandId: string): Promise<ScopeCommandPlanRecord | null> {
    const key = keyFor(scope); const id = boundedString(commandId, 'commandId');
    const db = await ctx.open(); const tx = db.transaction([STORES.scopeCommandPlans, STORES.metadata], 'readonly');
    const done = transactionDone(tx);
    const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, id]));
    const record = raw ? await readScopeCommandRecord(tx, key, raw, ctx.maxRecordBytes) : null;
    await done; return record ? clone(record) : null;
  }

  async function listScopeCommandPlans(scope: SyncScope): Promise<ScopeCommandPlanRecord[]> {
    const key = keyFor(scope); const db = await ctx.open();
    const tx = db.transaction([STORES.scopeCommandPlans, STORES.metadata], 'readonly'); const done = transactionDone(tx);
    const raw = await requestValue<unknown[]>(tx.objectStore(STORES.scopeCommandPlans).getAll(scopeRowsRange(key)));
    const records = await Promise.all(raw.map(row => readScopeCommandRecord(tx, key, row, ctx.maxRecordBytes)));
    await done; return records.map(clone);
  }

  async function beginScopeCommandPlan(scope: SyncScope, row: Omit<ScopeCommandPlanRecord, 'scopeKey'>):
    Promise<ScopeCommandPlanRecord> {
    ctx.assertWritable(); const key = keyFor(scope);
    const record = validateScopeCommandPlan(key, { ...row, scopeKey: key }, Number.MAX_SAFE_INTEGER);
    const db = await ctx.writableDatabase();
    let saved = record;
    try {
      await runTransaction(db, [STORES.scopes, STORES.scopeCommandPlans, STORES.metadata], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key);
        const store = tx.objectStore(STORES.scopeCommandPlans);
        const prior = await requestValue(store.get([key, record.commandId])) as ScopeCommandPlanRecord | undefined;
        if (prior) {
          const existing = await readScopeCommandRecord(tx, key, prior, ctx.maxRecordBytes);
          const inflight = existing.phase !== 'active' && existing.phase !== 'failed';
          if (inflight && existing.kind === record.kind && existing.confirmationVersion === record.confirmationVersion) {
            saved = existing; return;
          }
          if (inflight) throw new SyncStateError('command_in_flight');
        }
        await writeScopeCommandRecord(tx, key, record, ctx.maxRecordBytes);
      });
    } catch (error) { throw constraintError(error); }
    return clone(saved);
  }

  async function commitRangeExitFacts(scope: SyncScope, input: {
    readonly observation: Omit<RemoteObservationRecord, 'scopeKey'>;
    readonly exclusion: Omit<LocalSyncExclusionRecord, 'scopeKey'>;
    readonly dropMappingNativeId: string;
    readonly command?: Omit<ScopeCommandPlanRecord, 'scopeKey'>;
    readonly retainedMapping?: MappingInput;
  }): Promise<void> {
    ctx.assertWritable(); const key = keyFor(scope);
    if (input.exclusion.sourceKind !== 'range_exit') throw new SyncStateError('exclusion_source_invalid');
    const observation = validateRemoteObservation(key, { ...input.observation, scopeKey: key }, ctx.maxRecordBytes);
    const exclusion = validateLocalSyncExclusion(key, { ...input.exclusion, scopeKey: key }, ctx.maxRecordBytes);
    const command = input.command
      ? validateScopeCommandPlan(key, { ...input.command, scopeKey: key }, ctx.maxRecordBytes) : null;
    const retained = input.retainedMapping
      ? validateMapping(key, input.retainedMapping, ctx.maxRecordBytes) : null;
    const nativeId = boundedString(input.dropMappingNativeId, 'dropMappingNativeId');
    const db = await ctx.writableDatabase();
    const stores = [STORES.scopes, STORES.remoteObservations, STORES.localSyncExclusions, STORES.mappings,
      STORES.scopeCommandPlans];
    try {
      await runTransaction(db, stores, 'readwrite', async (tx) => {
        await requireActiveScope(tx, key);
        tx.objectStore(STORES.remoteObservations).put(observation);
        tx.objectStore(STORES.localSyncExclusions).put(exclusion);
        tx.objectStore(STORES.mappings).delete([key, nativeId]);
        if (retained) tx.objectStore(STORES.mappings).put(retained);
        if (command) tx.objectStore(STORES.scopeCommandPlans).put(command);
      });
    } catch (error) { throw constraintError(error); }
  }

  /** Replace a proven tombstoned live identity and its exclusion atomically. */
  async function commitTombstoneMappingRepair(scope: SyncScope, input: {
    readonly nativeId: string; readonly colpId: string;
    readonly exclusion?: Omit<LocalSyncExclusionRecord, 'scopeKey'>;
  }): Promise<boolean> {
    ctx.assertWritable(); const key = keyFor(scope);
    const nativeId = boundedString(input.nativeId, 'nativeId');
    const colpId = boundedString(input.colpId, 'colpId');
    const exclusion = input.exclusion
      ? validateLocalSyncExclusion(key, { ...input.exclusion, scopeKey: key }, ctx.maxRecordBytes) : null;
    if (exclusion && (exclusion.nativeId !== nativeId || exclusion.priorColpId !== colpId
        || exclusion.generation !== scope.generation || exclusion.sourceKind !== 'remote_delete')) {
      throw new SyncStateError('exclusion_source_invalid');
    }
    const db = await ctx.writableDatabase(); let repaired = false;
    try {
      await runTransaction(db, [STORES.scopes, STORES.mappings, STORES.remoteObservations,
        STORES.localSyncExclusions], 'readwrite', async tx => {
        await requireActiveScope(tx, key);
        const observation = await requestValue(tx.objectStore(STORES.remoteObservations).get([key, colpId]));
        if (!observation || validateRemoteObservation(key, observation, ctx.maxRecordBytes).kind !== 'tombstone') return;
        const mappings = tx.objectStore(STORES.mappings);
        const raw = await requestValue(mappings.get([key, nativeId]));
        if (!raw) return;
        const current = validateMappingRecord(key, raw, ctx.maxRecordBytes);
        if (current.colpId !== colpId) return;
        const virtualId = `unmounted:${colpId}`;
        const occupant = await requestValue(mappings.get([key, virtualId]));
        if (occupant && validateMappingRecord(key, occupant, ctx.maxRecordBytes).colpId !== colpId) {
          throw new SyncStateError('constraint');
        }
        const { scopeKey: _key, parentNativeId: _parent, ...rest } = current;
        mappings.delete([key, nativeId]);
        mappings.put(validateMapping(key, { ...rest, nativeId: virtualId,
          ...(current.parentColpId ? { parentNativeId: `unmounted:${current.parentColpId}` } : {}) }, ctx.maxRecordBytes));
        if (exclusion) tx.objectStore(STORES.localSyncExclusions).put(exclusion);
        repaired = true;
      });
    } catch (error) { throw constraintError(error); }
    return repaired;
  }

  return {
    putRemoteObservation, getRemoteObservation, listRemoteObservations, deleteRemoteObservations,
    putScopeCommandPlan, getScopeCommandPlan, listScopeCommandPlans, beginScopeCommandPlan, commitRangeExitFacts, commitTombstoneMappingRepair,
  };
}

export function validateMountPauseBaseline(input: unknown): MountPauseBaseline {
  const row = strictObject(clone(input), ['generation', 'boundaryVersion', 'lastAppliedCursor', 'completeness'],
    'mount pause baseline');
  const completeness = String(row.completeness) as MountPauseCompleteness;
  if (completeness !== 'complete' && completeness !== 'unknown') throw new SyncStateError('pause_baseline_invalid');
  return {
    generation: safeInteger(row.generation, 'generation', 1),
    boundaryVersion: boundedString(row.boundaryVersion, 'boundaryVersion', 64),
    lastAppliedCursor: row.lastAppliedCursor === null ? null
      : boundedString(row.lastAppliedCursor, 'lastAppliedCursor'),
    completeness,
  };
}

export function validateRemoteObservation(key: string, input: unknown, maxBytes: number): RemoteObservationRecord {
  const row = strictObject(clone(input), ['scopeKey', 'colpId', 'remoteRevision', 'cursor', 'kind', 'payload',
    'sourceDigest', 'observedAt', 'pauseGeneration', 'pauseBoundaryVersion', 'pauseCursor'], 'remote observation',
    ['scopeKey', 'pauseGeneration', 'pauseBoundaryVersion', 'pauseCursor']);
  if (row.scopeKey !== undefined && row.scopeKey !== key) throw new SyncStateError('observation_scope_invalid');
  const kind = String(row.kind) as RemoteObservationKind;
  if (!OBSERVATION_KINDS.includes(kind)) throw new SyncStateError('observation_kind_invalid');
  const payload = validateJson(row.payload, 'observation.payload');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SyncStateError('observation_payload_invalid');
  }
  const record: RemoteObservationRecord = {
    scopeKey: key, colpId: boundedString(row.colpId, 'colpId'),
    remoteRevision: boundedString(row.remoteRevision, 'remoteRevision'),
    cursor: boundedString(row.cursor, 'cursor'), kind,
    payload: payload as JsonObject,
    sourceDigest: boundedString(row.sourceDigest, 'sourceDigest'),
    observedAt: safeInteger(row.observedAt, 'observedAt', 1),
    ...observationPauseFields(row),
  };
  validateRecord(record, maxBytes); return record;
}

function observationPauseFields(row: UnknownRecord): Pick<RemoteObservationRecord,
  'pauseGeneration' | 'pauseBoundaryVersion' | 'pauseCursor'> | Record<string, never> {
  const present = row.pauseGeneration !== undefined || row.pauseBoundaryVersion !== undefined
    || Object.prototype.hasOwnProperty.call(row, 'pauseCursor');
  if (!present) return {};
  if (row.pauseGeneration === undefined || row.pauseBoundaryVersion === undefined
      || !Object.prototype.hasOwnProperty.call(row, 'pauseCursor')) {
    throw new SyncStateError('observation_pause_invalid');
  }
  return {
    pauseGeneration: safeInteger(row.pauseGeneration, 'pauseGeneration', 1),
    pauseBoundaryVersion: boundedString(row.pauseBoundaryVersion, 'pauseBoundaryVersion', 64),
    pauseCursor: row.pauseCursor === null ? null : boundedString(row.pauseCursor, 'pauseCursor'),
  };
}


export function exclusionSourceKind(record: { readonly sourceKind?: LocalExclusionSourceKind }):
  LocalExclusionSourceKind {
  return record.sourceKind ?? 'remote_delete';
}
