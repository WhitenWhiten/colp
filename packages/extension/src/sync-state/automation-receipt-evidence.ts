import type { CanonicalCreate } from '../automation/receipt-sync.js';
import { RECEIPT_MAX_AGE_MS } from '../automation/receipt-limits.js';
import { liveCreateNativeId, plannedCreateNativeId } from '../bookmark-event-codec.js';
import { boundedString, clone } from './codec.js';
import { requestValue, transactionDone } from './idb.js';
import { removeRetentionMark, retainedLongEnough } from './history-retention-io.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { SyncStoreRuntime } from './runtime.js';
import type { MappingInput, QueueOperation, ReceiptRecord, SyncScope, UnknownRecord } from './types.js';

export const CREATE_RECEIPT_SUMMARY = 'automation_create';
interface CreateSummary extends UnknownRecord {
  readonly scopeKey: string; readonly kind: typeof CREATE_RECEIPT_SUMMARY; readonly id: string;
  readonly sequence: number; readonly evidence: CanonicalCreate;
}

/** Called before removing source rows, in their transaction. One compact proof
 * per native bookmark survives its queue/event/receipt, including original tags.
 * An event owns its native id; planned creates can resolve it without an event. */
export async function retainAutomationCreate(tx: IDBTransaction, key: string, row: QueueOperation,
  receipt: ReceiptRecord | null, eventNativeId?: string): Promise<void> {
  if (row.payload.type !== 'create_node' || !receipt) return;
  const payload = row.payload.payload;
  const node = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.node : undefined;
  if (!node || typeof node !== 'object' || Array.isArray(node) || node.kind !== 'bookmark'
      || typeof node.title !== 'string' || typeof node.url !== 'string') return;
  const results = receipt.result?.results;
  const result = Array.isArray(results) ? results.find(result => result && typeof result === 'object'
    && !Array.isArray(result) && result.opId === row.opId && result.sequence === row.sequence) : undefined;
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || !['applied', 'rebased'].includes(String(result.status)) || typeof result.targetId !== 'string') return;
  const nativeId = liveCreateNativeId(eventNativeId ?? plannedCreateNativeId(row.opId));
  if (!nativeId) return;
  const summaries = tx.objectStore(STORES.compactSummaries);
  const prior = await requestValue(summaries.get([key, CREATE_RECEIPT_SUMMARY, nativeId])) as CreateSummary | undefined;
  if (prior && prior.sequence >= row.sequence) return;
  summaries.put({ scopeKey: key, kind: CREATE_RECEIPT_SUMMARY, id: nativeId, sequence: row.sequence,
    evidence: { nodeId: result.targetId, operationId: row.opId, title: node.title, url: node.url,
      tags: Array.isArray(node.tags) ? node.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      parentNodeId: payload && typeof payload === 'object' && !Array.isArray(payload)
        && typeof payload.parentId === 'string' ? payload.parentId : null } } satisfies CreateSummary);
  removeRetentionMark(tx, key, CREATE_RECEIPT_SUMMARY, nativeId);
}

export function createAutomationReceiptEvidenceRepository(ctx: SyncStoreRuntime) {
  return { async getRetainedCreateReceipt(input: SyncScope, nativeId: string): Promise<CanonicalCreate | null> {
    const key = scopeKey(validateScope(input)); boundedString(nativeId, 'nativeId');
    const tx = (await ctx.open()).transaction([STORES.compactSummaries, STORES.mappings, STORES.remoteObservations], 'readonly');
    const done = transactionDone(tx);
    const row = await requestValue(tx.objectStore(STORES.compactSummaries).get([key, CREATE_RECEIPT_SUMMARY, nativeId])) as CreateSummary | undefined;
    const mapping = await requestValue(tx.objectStore(STORES.mappings).get([key, nativeId])) as MappingInput | undefined;
    const observation = row && await requestValue(tx.objectStore(STORES.remoteObservations).get([key, row.evidence.nodeId])) as UnknownRecord | undefined;
    await done;
    if (!row || mapping && mapping.colpId !== row.evidence.nodeId || observation?.kind === 'tombstone') return null;
    return clone(row.evidence);
  } };
}

/** Live canonical identity protects the proof even if recovery rebound its
 * native id. Once unbound, retain the consumer's whole inclusive retry window. */
export async function retainCreateSummary(tx: IDBTransaction, key: string, row: UnknownRecord, now: number): Promise<boolean> {
  const proof = row as CreateSummary;
  if (await requestValue(tx.objectStore(STORES.mappings).index(INDEXES.mappingByColpId).getKey([key, proof.evidence.nodeId]))) {
    removeRetentionMark(tx, key, CREATE_RECEIPT_SUMMARY, proof.id); return true;
  }
  if (!await retainedLongEnough(tx, key, CREATE_RECEIPT_SUMMARY, proof.id, now, RECEIPT_MAX_AGE_MS + 1)) return true;
  removeRetentionMark(tx, key, CREATE_RECEIPT_SUMMARY, proof.id); return false;
}
