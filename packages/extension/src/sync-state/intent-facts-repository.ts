import { putPullIssueFact } from './pull-issue-repository.js';
import {
  SyncStateError, type IntentLiveWorkKind, type IntentRecord, type IntentReplayState, type JsonObject,
  type NativeResultConfirmation, type PersistedNativeCallResult, type PullApplyState, type SyncScope,
} from './types.js';
import { boundedString, canonicalJson, clone } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateIntent } from './pull-validate.js';
import type { SyncStoreRuntime } from './runtime.js';
import { assertMaterializationWaitAuthority, MATERIALIZATION_WAIT_STORES,
  type MaterializationWaitAuthority } from './materialization-wait-authority.js';

export interface ApplyIntentFactsPatch {
  readonly expectedMaterialization?: MaterializationWaitAuthority;
  readonly nativeWaitDecision?: import('./types.js').NativeWaitDecision;
  readonly nativeEventEvidence?: JsonObject | null;
  readonly state?: PullApplyState;
  readonly apiPhase?: PullApplyState;
  readonly nativeResult?: PersistedNativeCallResult;
  readonly replayState?: IntentReplayState;
  readonly waitReason?: string | null;
  readonly apiResultEvidence?: JsonObject | null;
  readonly nativeResultConfirmation?: NativeResultConfirmation | null;
  readonly repairJobId?: string | null;
  readonly commandId?: string;
  readonly colpId?: string;
  readonly substep?: string;
  readonly liveWorkKind?: IntentLiveWorkKind;
  readonly generation?: number;
  readonly nativeParentId?: string | null;
  readonly anchors?: JsonObject;
  readonly eventState?: PullApplyState;
  readonly expectedWaitRef?: string;
  readonly expectedGeneration?: number;
  readonly expectedNativeResult?: PersistedNativeCallResult;
}

export function createIntentFactsRepository(ctx: SyncStoreRuntime) {
  const open = () => ctx.open();
  const writableDatabase = () => ctx.writableDatabase();
  const assertWritable = () => ctx.assertWritable();

  async function listApplyIntents(input: SyncScope): Promise<IntentRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.intents, 'readonly'); const completion = transactionDone(tx);
    const values = await cursorPage<IntentRecord>(tx.objectStore(STORES.intents), scopeRowsRange(key), 20_000);
    await completion; return clone(values);
  }

  async function persistApplyIntentFacts(input: SyncScope, intentId: string,
    patch: ApplyIntentFactsPatch): Promise<IntentRecord> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const id = boundedString(intentId, 'intentId');
    const db = await writableDatabase();
    let saved: IntentRecord | undefined;
    await runTransaction(db, [STORES.scopes, STORES.intents, STORES.pullEvents, STORES.diagnostics,
      ...(patch.expectedMaterialization ? MATERIALIZATION_WAIT_STORES : [])], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const intents = tx.objectStore(STORES.intents);
      const intent = await requestValue(intents.get([key, id])) as IntentRecord | undefined;
      if (!intent) throw new SyncStateError('intent_not_found');
      if (patch.expectedWaitRef !== undefined
          && intent.nativeResultConfirmation?.code !== patch.expectedWaitRef) {
        throw new SyncStateError('stale_ref');
      }
      if (patch.expectedWaitRef !== undefined && intent.nativeWaitDecision?.action === 'cancel') {
        throw new SyncStateError('native_result_cas');
      }
      if (patch.expectedGeneration !== undefined && intent.generation !== patch.expectedGeneration) {
        throw new SyncStateError('generation_mismatch');
      }
      if (patch.expectedNativeResult !== undefined && intent.nativeResult !== patch.expectedNativeResult) {
        throw new SyncStateError('native_result_cas');
      }
      if (patch.expectedMaterialization) await assertMaterializationWaitAuthority(tx, key, patch.expectedMaterialization);
      const { scopeKey: _scopeKey, ...row } = intent;
      const merged = {
        ...row,
        ...(patch.nativeWaitDecision === undefined ? {} : { nativeWaitDecision: patch.nativeWaitDecision }),
        ...(patch.nativeEventEvidence === undefined ? {} : { nativeEventEvidence: patch.nativeEventEvidence }),
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(patch.apiPhase === undefined ? {} : { apiPhase: patch.apiPhase }),
        ...(patch.nativeResult === undefined ? {} : { nativeResult: patch.nativeResult }),
        ...(patch.replayState === undefined ? {} : { replayState: patch.replayState }),
        ...(patch.apiResultEvidence === undefined ? {} : { apiResultEvidence: patch.apiResultEvidence }),
        ...(patch.commandId === undefined ? {} : { commandId: patch.commandId }),
        ...(patch.colpId === undefined ? {} : { colpId: patch.colpId }),
        ...(patch.substep === undefined ? {} : { substep: patch.substep }),
        ...(patch.liveWorkKind === undefined ? {} : { liveWorkKind: patch.liveWorkKind }),
        ...(patch.generation === undefined ? {} : { generation: patch.generation }),
        ...(patch.nativeParentId === undefined ? {} : { nativeParentId: patch.nativeParentId }),
        ...(patch.anchors === undefined ? {} : { anchors: patch.anchors }),
      };
      const next = { ...merged } as Record<string, unknown>;
      if (patch.waitReason === null) delete next.waitReason;
      else if (patch.waitReason !== undefined) next.waitReason = patch.waitReason;
      if (patch.nativeResultConfirmation === null) delete next.nativeResultConfirmation;
      else if (patch.nativeResultConfirmation !== undefined) {
        next.nativeResultConfirmation = patch.nativeResultConfirmation;
      }
      if (patch.repairJobId === null) delete next.repairJobId;
      else if (patch.repairJobId !== undefined) next.repairJobId = patch.repairJobId;
      if (patch.eventState === 'awaiting_confirmation' && ['result_unknown', 'waiting_dependency'].includes(String(next.nativeResult))) {
        // A parked invocation no longer owns event correlation for independent
        // creates with identical content. Preserve its original evidence key.
        next.suspendedCorrelationId ??= intent.correlationId;
        next.correlationId = `native-wait:${id}`;
      }
      const record = validateIntent(key, next, ctx.maxRecordBytes);
      intents.put(record); saved = record;
      const eventId = record.eventId ?? patch.expectedMaterialization?.rootIntent.eventId;
      if (patch.nativeWaitDecision?.action === 'cancel' && record.nativeResult === 'result_unknown' && record.colpId && eventId) {
        // Declining placement closes the prompt, never the unknown invocation.
        // Keep the node protected and visible until explicit replica repair.
        await putPullIssueFact(tx, key, { code: 'native_result_unknown', nodeId: record.colpId,
          eventId, now: Date.now() });
      }
      if (patch.eventState !== undefined && eventId) {
        const events = tx.objectStore(STORES.pullEvents);
        const event = await requestValue(events.get([key, eventId])) as Record<string, unknown> | undefined;
        if (event) events.put({ ...event, state: patch.eventState,
          ...(patch.eventState === 'awaiting_confirmation' && ['result_unknown', 'waiting_dependency'].includes(String(record.nativeResult))
            ? { deferredNativeIntentId: id } : {}) });
      }
    });
    if (!saved) throw new SyncStateError('intent_not_found');
    return saved;
  }

  /** Replace placement and independently captured content after a proven non-call.
   * A started phase can retain nativeResult=not_started, so compare both rows
   * and the entire earlier intent inside the same write transaction. */
  async function refreshUnstartedMovePreimage(input: SyncScope, expected: IntentRecord,
    nativePreimage: JsonObject, capturedContent: JsonObject = {}): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.intents, STORES.pullEvents], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const intents = tx.objectStore(STORES.intents);
      const intent = await requestValue(intents.get([key, boundedString(expected.intentId, 'intentId')])) as IntentRecord | undefined;
      const event = intent?.eventId ? await requestValue<{
        readonly state?: string; readonly intentId?: string;
      } | undefined>(tx.objectStore(STORES.pullEvents).get([key, intent.eventId])) : undefined;
      if (!intent || !event || event.intentId !== intent.intentId || event.state !== 'intent_prepared'
          || intent.state !== 'intent_prepared' || intent.apiPhase !== 'intent_prepared'
          || intent.nativeResult !== 'not_started' || intent.replayState !== 'not_started'
          || intent.generation !== input.generation || intent.expected.kind !== 'move'
          || intent.anchors?.rangeAction !== 'native_move' || intent.anchors.chromeMutation !== true
          || intent.nativeTargetId !== nativePreimage.id || intent.expected.nativeId !== nativePreimage.id
          || intent.apiResultEvidence || intent.nativeEventEvidence || intent.nativeResultConfirmation
          || intent.nativeWaitDecision || intent.waitReason || canonicalJson(intent) !== canonicalJson(expected)) {
        throw new SyncStateError('native_result_cas');
      }
      const prior = intent.anchors.nativePreimage;
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new SyncStateError('native_result_cas');
      const { parentId: _oldParent, index: _oldIndex, ...oldIdentity } = prior;
      const { parentId: _parent, index: _index, ...identity } = nativePreimage;
      const admittedContent = Object.fromEntries(['title', 'url'].flatMap(field =>
        typeof capturedContent[field] === 'string' ? [[field, capturedContent[field]]] : []));
      if (canonicalJson({ ...oldIdentity, ...admittedContent }) !== canonicalJson(identity)) {
        throw new SyncStateError('native_result_cas');
      }
      const { scopeKey: _key, ...row } = intent;
      intents.put(validateIntent(key, { ...row, anchors: { ...intent.anchors, nativePreimage } }, ctx.maxRecordBytes));
    });
  }

  async function listNativeWaitIntents(input: SyncScope): Promise<IntentRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.intents, 'readonly'); const done = transactionDone(tx);
    const intents = tx.objectStore(STORES.intents); const rows = new Map<string, IntentRecord>();
    for (const result of ['result_unknown', 'waiting_dependency']) {
      for (const intent of await requestValue<IntentRecord[]>(intents.index(INDEXES.intentByNativeResult).getAll(IDBKeyRange.bound([key, result], [key, result, []])))) rows.set(intent.intentId, intent);
    }
    for (const intent of await requestValue<IntentRecord[]>(intents.index(INDEXES.intentByWaitReason).getAll(IDBKeyRange.bound([key, 'native_result_unknown'], [key, 'native_result_unknown', []])))) rows.set(intent.intentId, intent);
    await done; return clone([...rows.values()]);
  }
  return { listApplyIntents, listNativeWaitIntents, persistApplyIntentFacts, refreshUnstartedMovePreimage };
}
