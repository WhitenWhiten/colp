import type { ProjectionIntentRecord } from '../recovery-overlay.js';
import { boundedString, clone } from './codec.js';
import { requestValue, requireActiveScope, runTransaction, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type SyncScope, type UnknownRecord } from './types.js';
import { readProjectionIntent } from './pull-validate.js';
import type { SyncStoreRuntime } from './runtime.js';

export function createProjectionRepository(ctx: SyncStoreRuntime) {
  const { open, writableDatabase, assertWritable } = ctx;
  async function replaceProjectionIntents(input: SyncScope, intents: readonly ProjectionIntentRecord[]): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input));
    // Validate before opening the write transaction so malformed projection
    // records (including unknown states) can never reach IndexedDB.
    const checked = intents.map((intent) => readProjectionIntent(intent as unknown as UnknownRecord));
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const store = tx.objectStore(STORES.diagnostics);
      const prior = await requestValue(store.index(INDEXES.diagnosticByScope).getAll(
        IDBKeyRange.bound([key, `projection-intent:${key}:`], [key, `projection-intent:${key}:\uffff`]))) as UnknownRecord[];
      for (const value of prior) {
        if (value.kind === 'projection_intent' && value.state !== 'terminal') store.delete(String(value.id));
      }
      for (const intent of checked) {
        // A completed plan may be superseded by another desired state for the
        // same Node. Unrelated terminal observations remain occupancy evidence.
        const { kind: intentKind, ...fields } = intent;
        store.put({
          id: `projection-intent:${key}:${intent.intentId}`, scopeKey: key, kind: 'projection_intent',
          intentKind, ...fields,
        });
      }
    });
  }

  async function listProjectionIntents(input: SyncScope): Promise<ProjectionIntentRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.diagnostics, 'readonly'); const completion = transactionDone(tx);
    const values = await requestValue(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope).getAll(
      IDBKeyRange.bound([key, `projection-intent:${key}:`], [key, `projection-intent:${key}:\uffff`]))) as UnknownRecord[];
    await completion;
    return values.filter((value) => value.kind === 'projection_intent').map((value) => clone(readProjectionIntent(value)));
  }

  async function settleProjectionIntent(input: SyncScope, intentId: string, update: {
    readonly state: ProjectionIntentRecord['state']; readonly observedNativeId?: string;
    readonly suppression?: string; readonly parentNativeId?: string;
  }): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); boundedString(intentId, 'intentId');
    if (!['pending', 'executing', 'terminal', 'ambiguous', 'recovery'].includes(update.state)) {
      throw new SyncStateError('projection_intent_invalid');
    }
    if (update.suppression !== undefined) boundedString(update.suppression, 'suppression');
    if (update.parentNativeId !== undefined) boundedString(update.parentNativeId, 'parentNativeId');
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const store = tx.objectStore(STORES.diagnostics);
      const id = `projection-intent:${key}:${intentId}`;
      const current = await requestValue(store.get(id)) as UnknownRecord | undefined;
      if (!current || current.kind !== 'projection_intent') throw new SyncStateError('intent_not_found');
      store.put({
        ...current, state: update.state,
        ...(update.observedNativeId === undefined ? {} : { observedNativeId: update.observedNativeId }),
        ...(update.suppression === undefined ? {} : { suppression: update.suppression }),
        ...(update.parentNativeId === undefined ? {} : { parentNativeId: update.parentNativeId }),
      });
    });
  }

  return { replaceProjectionIntents, listProjectionIntents, settleProjectionIntent };
}
