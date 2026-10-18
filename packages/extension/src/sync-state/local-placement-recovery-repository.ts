import { digestJson } from '../bookmark-event-codec.js';
import { requestValue, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { validateEngineState } from './pull-validate.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope, validateScopeRecord } from './scope-key.js';
import type { SyncStoreRuntime } from './runtime.js';
import type { DurableSyncEngineState, JsonObject, MappingInput, ScopeRecord, SyncScope, UnknownRecord } from './types.js';

const ERROR = 'recovery_identity_unproven';
const TABLES = [STORES.scopes, STORES.engine, STORES.mappings, STORES.diagnostics, STORES.queue,
  STORES.pullPages, STORES.pullEvents, STORES.intents, STORES.recovery, STORES.ackIntents, STORES.cursors];

export function createLocalPlacementRecoveryRepository(ctx: SyncStoreRuntime) {
  async function evidence(tx: IDBTransaction, key: string) {
    const [scope, engine, cursor, diagnostic] = await Promise.all([
      requestValue<ScopeRecord | undefined>(tx.objectStore(STORES.scopes).get(key)),
      requestValue<DurableSyncEngineState | undefined>(tx.objectStore(STORES.engine).get(key)),
      requestValue<UnknownRecord | undefined>(tx.objectStore(STORES.cursors).get(key)),
      requestValue<UnknownRecord | undefined>(tx.objectStore(STORES.diagnostics)
        .get(`bookmark_create_placement:${key}:identity_unproven:none`)),
    ]);
    if (!scope || !engine || !engine.recoveryFrozen || engine.phase !== 'recovery' || engine.lastError !== ERROR
        || engine.localProjectionOwner !== undefined || !['active', 'recovery_required'].includes(scope.lifecycle)
        || scope.metadata?.recoveryCode !== undefined && scope.metadata.recoveryCode !== ERROR
        || !engine.lastPublishedCursor || engine.lastPublishedCursor !== engine.lastAckedCursor
        || engine.lastPublishedCursor !== (cursor?.cursor ?? scope.checkpoint?.cursor)) return null;
    const details = diagnostic?.details as UnknownRecord | undefined;
    if (typeof details?.nativeId !== 'string' || details.candidateCount !== 1) return null;
    const nativeId = details.nativeId;
    const diagnostics = tx.objectStore(STORES.diagnostics);
    if (await requestValue(diagnostics.get(`local_placement_recovery:${key}:local_only_save:${nativeId}`))) return null;
    const rows = (name: string) => requestValue<UnknownRecord[]>(tx.objectStore(name).getAll(scopeRowsRange(key)));
    const [mappings, queue, pages, events, intents, staging, acks, projections] = await Promise.all([
      rows(STORES.mappings), rows(STORES.queue), rows(STORES.pullPages), rows(STORES.pullEvents),
      rows(STORES.intents), rows(STORES.recovery), rows(STORES.ackIntents),
      requestValue<UnknownRecord[]>(diagnostics.index(INDEXES.diagnosticByScope).getAll(
        IDBKeyRange.bound([key, `projection-intent:${key}:`], [key, `projection-intent:${key}:\uffff`]))),
    ]);
    // This migration only releases a settled replica, never an unknown browser
    // result, unacknowledged cursor, or request whose commit is still uncertain.
    if (staging.length || queue.some(row => !['terminal', 'rejected'].includes(String(row.status)))
        || pages.some(row => row.state !== 'page_complete') || events.some(row => row.state !== 'page_complete')
        || intents.some(row => row.state !== 'page_complete' || row.nativeResult === 'result_unknown'
          || row.nativeResult === 'unknown' || row.waitReason)
        || projections.some(row => row.state !== 'terminal') || acks.some(row => row.state !== 'complete')
        || !acks.some(row => row.kind === 'bootstrap' && row.state === 'complete')) return null;
    return { scope, engine, nativeId, mappings: mappings as unknown as MappingInput[],
      mappingDigest: digestJson(mappings as JsonObject[]) };
  }

  async function getLocalPlacementRecovery(input: SyncScope) {
    const key = scopeKey(validateScope(input)); const db = await ctx.open();
    const tx = db.transaction(TABLES, 'readonly'); const done = transactionDone(tx);
    const result = await evidence(tx, key); await done;
    return result;
  }

  async function resumeLocalPlacementRecovery(input: SyncScope, proof: {
    readonly engineRevision: number; readonly nativeId: string; readonly mappingDigest: string; readonly now: number;
  }): Promise<boolean> {
    const key = scopeKey(validateScope(input)); const db = await ctx.writableDatabase(); let resumed = false;
    await runTransaction(db, TABLES, 'readwrite', async tx => {
      const current = await evidence(tx, key);
      if (!current || current.engine.revision !== proof.engineRevision || current.nativeId !== proof.nativeId
          || current.mappingDigest !== proof.mappingDigest) return;
      const { recoveryCode: _code, ...metadata } = current.scope.metadata ?? {};
      tx.objectStore(STORES.scopes).put(validateScopeRecord({ ...current.scope, lifecycle: 'active', metadata }, ctx.maxRecordBytes));
      const { lastError: _error, localProjectionOwner: _owner, connectivityConfirmationRevision: _confirmation,
        ...engine } = current.engine;
      tx.objectStore(STORES.engine).put(validateEngineState({ ...engine, phase: 'session',
        // Hand the freeze to ordinary authority recovery. It requires both
        // flags until the renewed Session is adopted, then releases the freeze.
        revision: engine.revision + 1, updatedAt: proof.now, recoveryFrozen: true,
        authorityRefreshRequired: true, notBefore: 0, networkBackoffCount: 0 }));
      tx.objectStore(STORES.diagnostics).put({
        id: `local_placement_recovery:${key}:local_only_save:${proof.nativeId}`, scopeKey: key,
        kind: 'local_placement_recovery', code: 'local_only_save', nativeId: proof.nativeId,
        details: { engineRevision: proof.engineRevision, recoveredAt: proof.now },
      });
      resumed = true;
    });
    return resumed;
  }
  async function resumeMappedIdentityRecovery(input: SyncScope, proof: {
    readonly engineRevision: number; readonly mappingDigest: string; readonly nativeIds: readonly string[]; readonly now: number;
  }): Promise<boolean> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input)); let resumed = false;
    await runTransaction(await ctx.writableDatabase(), TABLES, 'readwrite', async tx => {
      const scope = await requestValue<ScopeRecord | undefined>(tx.objectStore(STORES.scopes).get(key));
      const engine = await requestValue<DurableSyncEngineState | undefined>(tx.objectStore(STORES.engine).get(key));
      if (!scope || !engine?.recoveryFrozen || engine.revision !== proof.engineRevision || engine.lastError !== ERROR
          || engine.localProjectionOwner !== undefined
          || scope.metadata?.recoveryCode !== undefined && scope.metadata.recoveryCode !== ERROR) return;
      const mappings = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.mappings).getAll(scopeRowsRange(key)));
      if (!proof.nativeIds.length || digestJson(mappings as JsonObject[]) !== proof.mappingDigest) return;
      for (const nativeId of proof.nativeIds) {
        if (!mappings.some(row => row.nativeId === nativeId)
            || !await requestValue(tx.objectStore(STORES.diagnostics).get(`local-issue:${key}:${ERROR}:${nativeId}`))) return;
      }
      const { recoveryCode: _code, ...metadata } = scope.metadata ?? {};
      tx.objectStore(STORES.scopes).put(validateScopeRecord({ ...scope, metadata }, ctx.maxRecordBytes));
      const { lastError: _error, ...prior } = engine;
      tx.objectStore(STORES.engine).put(validateEngineState({ ...prior, revision: engine.revision + 1,
        phase: 'recovery', recoveryFrozen: true, authorityRefreshRequired: true, updatedAt: proof.now, notBefore: 0 }));
      resumed = true;
    });
    return resumed;
  }
  return { getLocalPlacementRecovery, resumeLocalPlacementRecovery, resumeMappedIdentityRecovery };
}
