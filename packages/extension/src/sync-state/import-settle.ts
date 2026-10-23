import {
  type ImportNodeRecord, type ImportPlanRecord, type JsonObject,
} from './types.js';
import { cursorPage, requestValue, scopeRowsRange } from './idb.js';
import { STORES } from './schema.js';

export async function settleImportNode(tx: IDBTransaction, key: string, opId: string, outcome: 'terminal' | 'deferred' | 'blocked',
  result?: JsonObject) {
  if (outcome === 'deferred') return; const store = tx.objectStore(STORES.importNodes);
  const nodes = await cursorPage<ImportNodeRecord>(store, scopeRowsRange(key), 20_000);
  const node = nodes.find((item) => item.opId === opId); if (!node) return;
  const nestedResult = Array.isArray(result?.results) && result.results.length === 1 && result.results[0]
    && typeof result.results[0] === 'object' && !Array.isArray(result.results[0]) ? result.results[0] as JsonObject : null;
  const operationResult = nestedResult ?? result ?? null;
  const authoritativeTarget = operationResult && typeof operationResult.targetId === 'string'
    && typeof operationResult.revision === 'string'
    ? { colpId: operationResult.targetId, revision: operationResult.revision } : undefined;
  if (operationResult?.status === 'conflicted' || operationResult?.status === 'conflict') {
    store.put({ ...node, status: 'recoverable', recovery: 'conflict' });
    const plans = tx.objectStore(STORES.importPlans); const plan = await requestValue(plans.get([key, node.planId])) as
      ImportPlanRecord | undefined; if (plan) plans.put({ ...plan, state: 'attention', updatedAt: Date.now() }); return;
  }
  if (outcome === 'terminal') store.put({ ...node, status: 'terminal', recovery: undefined,
    ...(authoritativeTarget ? { authoritativeTarget } : {}) });
}
export async function unavailableImportOpIds(tx: IDBTransaction, key: string) {
  const plans = await cursorPage<ImportPlanRecord>(tx.objectStore(STORES.importPlans), scopeRowsRange(key), 100);
  const unavailablePlans = new Set(plans.filter((plan) => plan.state === 'paused' || plan.state === 'attention')
    .map((plan) => plan.planId));
  if (unavailablePlans.size === 0) return new Set<string>();
  const nodes = await cursorPage<ImportNodeRecord>(tx.objectStore(STORES.importNodes), scopeRowsRange(key), 20_000);
  return new Set(nodes.filter((node) => unavailablePlans.has(node.planId)).map((node) => node.opId));
}
