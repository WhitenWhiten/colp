import {
  SyncStateError, type IntentLiveWorkKind, type IntentRecord, type IntentReplayState, type JsonObject,
  type NativeResultConfirmation, type PersistedNativeCallResult, type PullApplyState, type SyncScope,
} from './types.js';
import { boundedString, clone } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { validateIntent } from './pull-validate.js';
import type { SyncStoreRuntime } from './runtime.js';

export interface ApplyIntentFactsPatch {
  readonly nativeWaitDecision?: import('./types.js').NativeWaitDecision;
  readonly nativeEventEvidence?: JsonObject | null;
  readonly state?: PullApplyState;
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
    await runTransaction(db, [STORES.scopes, STORES.intents, STORES.pullEvents], 'readwrite', async (tx) => {
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
      const { scopeKey: _scopeKey, ...row } = intent;
      const merged = {
        ...row,
        ...(patch.nativeWaitDecision === undefined ? {} : { nativeWaitDecision: patch.nativeWaitDecision }),
        ...(patch.nativeEventEvidence === undefined ? {} : { nativeEventEvidence: patch.nativeEventEvidence }),
        ...(patch.state === undefined ? {} : { state: patch.state }),
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
      const record = validateIntent(key, next, ctx.maxRecordBytes);
      intents.put(record); saved = record;
      if (patch.eventState !== undefined && intent.eventId) {
        const events = tx.objectStore(STORES.pullEvents);
        const event = await requestValue(events.get([key, intent.eventId])) as Record<string, unknown> | undefined;
        if (event) events.put({ ...event, state: patch.eventState });
      }
    });
    if (!saved) throw new SyncStateError('intent_not_found');
    return saved;
  }

  return { listApplyIntents, persistApplyIntentFacts };
}
