import {
  type ImportNodeRecord, type ImportPlanRecord, type JsonObject,
} from './types.js';
import { cursorPage, requestValue, scopeRowsRange } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { asHeld } from './queue-hold.js';
import { validateQueueRecord } from './queue-validate.js';
import { IMPORT_HOLD } from './import-hold.js';

export async function settleImportNode(tx: IDBTransaction, key: string, opId: string, outcome: 'terminal' | 'deferred' | 'blocked',
  result: JsonObject | undefined, maxRecordBytes: number) {
  if (outcome === 'deferred') return; const store = tx.objectStore(STORES.importNodes);
  const nodes = await cursorPage<ImportNodeRecord>(store, scopeRowsRange(key), 20_000);
  const node = nodes.find((item) => item.opId === opId); if (!node) return;
  const nestedResult = Array.isArray(result?.results) && result.results.length === 1 && result.results[0]
    && typeof result.results[0] === 'object' && !Array.isArray(result.results[0]) ? result.results[0] as JsonObject : null;
  const operationResult = nestedResult ?? result ?? null;
  const authoritativeTarget = operationResult && typeof operationResult.targetId === 'string'
    && typeof operationResult.revision === 'string'
    ? { colpId: operationResult.targetId, revision: operationResult.revision } : undefined;
  if (operationResult?.status === 'rejected' || operationResult?.status === 'conflicted' || operationResult?.status === 'conflict') {
    store.put({ ...node, status: 'recoverable', recovery: operationResult.status === 'rejected' ? 'push_rejected' : 'conflict' });
    const plans = tx.objectStore(STORES.importPlans); const plan = await requestValue(plans.get([key, node.planId])) as
      ImportPlanRecord | undefined;
    if (plan) {
      plans.put({ ...plan, state: 'attention', updatedAt: Date.now() });
      // A rejected/conflicted node moves the plan to attention here, outside
      // setImportPlanState: park the plan's other queued rows in the same
      // transaction so they cannot keep owning the head of the push lane.
      await holdImportPlanQueue(tx, key, node.planId, maxRecordBytes);
    }
    return;
  }
  if (outcome === 'terminal') store.put({ ...node, status: 'terminal', recovery: undefined,
    ...(authoritativeTarget ? { authoritativeTarget } : {}) });
}

/** The queued rows that belong to one import plan, resolved through its node records. */
async function importQueueRows(tx: IDBTransaction, key: string, planId: string): Promise<unknown[]> {
  const nodes = await cursorPage<ImportNodeRecord>(
    tx.objectStore(STORES.importNodes).index(INDEXES.importNodeByPlanOrder),
    IDBKeyRange.bound([key, planId, 0], [key, planId, Number.MAX_SAFE_INTEGER]), 20_000);
  const queue = tx.objectStore(STORES.queue); const rows: unknown[] = [];
  for (const node of nodes) {
    const raw = await requestValue(queue.index(INDEXES.queueByOpId).get([key, node.opId]));
    if (raw !== undefined) rows.push(raw);
  }
  return rows;
}

/**
 * Moves a paused or attention import plan's never-sent queue rows out of the push
 * lane. Their sequence slots cannot simply be skipped — the server expects every
 * slot in order — so leaving them pending either ignores the pause or blocks
 * every later local change behind them forever. `set_aside` removes them from
 * lane selection; the existing gap realign renumbers surviving work around them
 * when the lane advances.
 */
export async function holdImportPlanQueue(tx: IDBTransaction, key: string, planId: string,
  maxRecordBytes: number): Promise<number> {
  const queue = tx.objectStore(STORES.queue); let held = 0;
  for (const raw of await importQueueRows(tx, key, planId)) {
    const row = validateQueueRecord(raw, maxRecordBytes);
    if (row.status !== 'pending' || row.attempt !== undefined) continue;
    queue.put(asHeld(row, IMPORT_HOLD, maxRecordBytes)); held += 1;
  }
  return held;
}

/**
 * Puts the exact rows parked by {@link holdImportPlanQueue} back into the lane
 * when the plan is resumed. The rows keep their op ids, payload bytes and
 * idempotency identity; a realign may have moved them past surviving work while
 * they were parked, which is the only ordering change.
 */
export async function restoreImportPlanQueue(tx: IDBTransaction, key: string, planId: string,
  maxRecordBytes: number): Promise<number> {
  const queue = tx.objectStore(STORES.queue); let restored = 0;
  for (const raw of await importQueueRows(tx, key, planId)) {
    const row = validateQueueRecord(raw, maxRecordBytes);
    if (row.status !== 'set_aside' || row.recovery?.code !== IMPORT_HOLD) continue;
    queue.put(validateQueueRecord({ ...row, status: 'pending', recovery: undefined,
      retry: { ...row.retry, notBefore: 0 } }, maxRecordBytes)); restored += 1;
  }
  return restored;
}
