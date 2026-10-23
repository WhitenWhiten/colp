import { boundedString, clone, validateRecord } from './codec.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, transactionDone } from './idb.js';
import { validateIntent } from './pull-validate.js';
import { STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import { SyncStateError, type IntentRecord, type JsonObject, type SyncScope } from './types.js';
import type { SyncStoreRuntime } from './runtime.js';

export type DeleteMemberResult = 'not_started' | 'applied' | 'absent' | 'retained' | 'protected' | 'failed';
export interface DeleteMemberRecord {
  readonly scopeKey: string;
  readonly intentId: string;
  readonly colpId: string;
  readonly nativeId: string;
  readonly result: DeleteMemberResult;
  readonly preimage?: JsonObject;
}
const RESULTS = new Set(['not_started', 'applied', 'absent', 'retained', 'protected', 'failed']);
export const terminalDeleteResult = (result: string) => ['applied', 'absent', 'retained', 'protected'].includes(result);
export const deleteMemberRange = (key: string, id: string) => IDBKeyRange.bound([key, id], [key, id, []]);

/** Members and preimages have independent byte budgets; the intent holds only aggregate evidence. */
export function createDeleteMemberRepository(ctx: SyncStoreRuntime) {
  async function prepareDeleteMembers(input: SyncScope, intentId: string,
    members: readonly { colpId: string; nativeId: string }[]): Promise<DeleteMemberRecord[]> {
    const key = scopeKey(validateScope(input)), id = boundedString(intentId, 'intentId');
    let saved: DeleteMemberRecord[] = [];
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.intents, STORES.deleteMembers], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const intents = tx.objectStore(STORES.intents), rows = tx.objectStore(STORES.deleteMembers);
      const intent = await requestValue(intents.get([key, id])) as IntentRecord | undefined;
      if (!intent) throw new SyncStateError('intent_not_found');
      if (intent.anchors?.deleteJournal) {
        saved = await cursorPage(rows, deleteMemberRange(key, id), Number.MAX_SAFE_INTEGER);
        if (saved.length !== (intent.anchors.deleteJournal as JsonObject).memberCount) throw new SyncStateError('delete_journal_invalid');
        return;
      }
      // Adopt partially executed pre-v22 deletes atomically, preserving every receipt/preimage.
      const legacy = intent.anchors?.deleteMemberSet;
      const source = Array.isArray(legacy) && legacy.length ? legacy : members;
      const results = intent.anchors?.deleteMemberResults as JsonObject | undefined;
      const images = intent.anchors?.deletePreimages as JsonObject | undefined;
      const colpIds = new Set<string>(), nativeIds = new Set<string>();
      for (const value of source) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncStateError('delete_journal_invalid');
        const colpId = boundedString(value.colpId, 'colpId'), nativeId = boundedString(value.nativeId, 'nativeId');
        if (colpIds.has(colpId) || nativeIds.has(nativeId)) throw new SyncStateError('delete_journal_invalid');
        colpIds.add(colpId); nativeIds.add(nativeId);
        const result = results?.[colpId] ?? 'not_started';
        if (typeof result !== 'string' || !RESULTS.has(result)) throw new SyncStateError('delete_journal_invalid');
        const row: DeleteMemberRecord = { scopeKey: key, intentId: id, colpId, nativeId, result: result as DeleteMemberResult,
          ...(images?.[colpId] ? { preimage: images[colpId] as JsonObject } : {}) };
        validateRecord(row, ctx.maxRecordBytes); rows.add(row); saved.push(row);
      }
      const { deleteMemberSet: _set, deleteMemberResults: _results, deletePreimages: _images, ...anchors } = intent.anchors ?? {};
      const { scopeKey: _key, ...rest } = intent;
      intents.put(validateIntent(key, { ...rest, liveWorkKind: 'delete', anchors: { ...anchors, deleteJournal: {
        memberCount: saved.length, terminalCount: saved.filter(row => terminalDeleteResult(row.result)).length,
        failedCount: saved.filter(row => row.result === 'failed').length,
      } } }, ctx.maxRecordBytes));
    });
    return clone(saved);
  }

  async function listDeleteMembers(input: SyncScope, intentId: string): Promise<DeleteMemberRecord[]> {
    const key = scopeKey(validateScope(input)), id = boundedString(intentId, 'intentId');
    const tx = (await ctx.open()).transaction(STORES.deleteMembers, 'readonly'), done = transactionDone(tx);
    const rows = await cursorPage<DeleteMemberRecord>(tx.objectStore(STORES.deleteMembers), deleteMemberRange(key, id), Number.MAX_SAFE_INTEGER);
    await done; return rows;
  }

  async function saveDeleteMember(input: SyncScope, intentId: string, colpId: string,
    patch: { readonly result?: DeleteMemberResult; readonly preimage?: JsonObject }): Promise<void> {
    const key = scopeKey(validateScope(input)), id = boundedString(intentId, 'intentId');
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.intents, STORES.deleteMembers], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const intents = tx.objectStore(STORES.intents), rows = tx.objectStore(STORES.deleteMembers);
      const intent = await requestValue(intents.get([key, id])) as IntentRecord | undefined;
      const row = await requestValue(rows.get([key, id, boundedString(colpId, 'colpId')])) as DeleteMemberRecord | undefined;
      if (!intent || !row || !intent.anchors?.deleteJournal) throw new SyncStateError('delete_journal_invalid');
      const next = { ...row, ...clone(patch) };
      if (!RESULTS.has(next.result)) throw new SyncStateError('delete_journal_invalid');
      validateRecord(next, ctx.maxRecordBytes); rows.put(next);
      const counts = intent.anchors.deleteJournal as JsonObject;
      const terminalCount = Number(counts.terminalCount) + Number(terminalDeleteResult(next.result)) - Number(terminalDeleteResult(row.result));
      const failedCount = Number(counts.failedCount) + Number(next.result === 'failed') - Number(row.result === 'failed');
      const done = terminalCount === counts.memberCount;
      const { scopeKey: _key, ...rest } = intent;
      intents.put(validateIntent(key, { ...rest, anchors: { ...intent.anchors,
        deleteJournal: { ...counts, terminalCount, failedCount } },
        nativeResult: failedCount ? 'failed' : done ? 'applied_with_evidence' : 'not_started',
        replayState: done ? 'awaiting_receipt' : 'started',
      }, ctx.maxRecordBytes));
    });
  }
  return { prepareDeleteMembers, listDeleteMembers, saveDeleteMember };
}
