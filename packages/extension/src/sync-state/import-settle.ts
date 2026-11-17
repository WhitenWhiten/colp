import {
  type ImportNodeRecord, type ImportPlanRecord, type JsonObject,
} from './types.js';
import { cursorPage, iterateCursor, requestValue, scopeRowsRange } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { asHeld } from './queue-hold.js';
import { validateQueueRecord } from './queue-validate.js';
import { IMPORT_HOLD } from './import-hold.js';

/** One page of import-node rows: plans are streamed page by page, so no plan size is truncated by a single scan. */
const IMPORT_NODE_PAGE = 1_000;
/** The bookmark event an import node is enqueued with names its plan: `import:<planId>:<sourceNodeId>`. */
const IMPORT_EVENT_PREFIX = 'import:';

export async function settleImportNode(tx: IDBTransaction, key: string, opId: string, outcome: 'terminal' | 'deferred' | 'blocked',
  result: JsonObject | undefined, maxRecordBytes: number) {
  if (outcome === 'deferred') return;
  const node = await findImportNode(tx, key, opId); if (!node) return;
  const store = tx.objectStore(STORES.importNodes);
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

/** Where one op's import node lives, when its enqueue event still says so. */
interface ImportLocator { readonly planId: string; readonly sourceNodeId?: string }

/**
 * Resolves the node for one op id (B5-2).
 *
 * Settlement used to scan the first rows of the whole scope, so after import plans outgrew that window every later
 * plan's nodes were silently never settled. Plans are never deleted, so the window only moves further away.
 *
 * The op's bookmark event carries the plan id and its id ends in the source node id, which makes the node a primary
 * key lookup. An event the history retention already pruned (or a transaction without the event store) falls back
 * to streaming the plan, and then the scope: correctness never depends on the event surviving, only the cost does.
 */
async function findImportNode(tx: IDBTransaction, key: string, opId: string): Promise<ImportNodeRecord | undefined> {
  const nodes = tx.objectStore(STORES.importNodes);
  const locator = await importLocator(tx, key, opId);
  if (locator === false) return undefined; // a live event proves this op is not an import create
  if (locator === undefined) {
    // No event to name the plan (history retention pruned it, or this transaction has no event store). An import
    // node cannot outlive every plan, so an installation that never imported anything still pays one row here.
    if (!await scopeHasImportPlans(tx, key)) return undefined;
    return scanImportNodes(nodes, scopeRowsRange(key), opId);
  }
  if (locator.sourceNodeId !== undefined) {
    const direct = await requestValue(nodes.get([key, locator.planId, locator.sourceNodeId])) as ImportNodeRecord | undefined;
    if (direct?.opId === opId) return direct;
  }
  return scanImportNodes(nodes.index(INDEXES.importNodeByPlanOrder),
    IDBKeyRange.bound([key, locator.planId, 0], [key, locator.planId, Number.MAX_SAFE_INTEGER]), opId);
}

/**
 * The plan and source node for an op, from the bookmark event an import enqueue always writes with it.
 * `false` means the event exists and names no import plan, so no import node can exist for the op.
 */
async function importLocator(tx: IDBTransaction, key: string, opId: string): Promise<ImportLocator | false | undefined> {
  if (!tx.objectStoreNames.contains(STORES.bookmarkEvents)) return undefined;
  const event = await requestValue(tx.objectStore(STORES.bookmarkEvents).index(INDEXES.eventByOperationOrdinal).get(
    IDBKeyRange.bound([key, opId, -Number.MAX_SAFE_INTEGER], [key, opId, Number.MAX_SAFE_INTEGER]))) as
    { readonly eventId?: unknown; readonly details?: unknown } | undefined;
  if (!event) return undefined;
  const details = event.details;
  const planId = details && typeof details === 'object' && !Array.isArray(details)
    ? (details as { readonly importPlanId?: unknown }).importPlanId : undefined;
  if (typeof planId !== 'string' || planId.length === 0) return false;
  const prefix = `${IMPORT_EVENT_PREFIX}${planId}:`;
  const sourceNodeId = typeof event.eventId === 'string' && event.eventId.startsWith(prefix)
    ? event.eventId.slice(prefix.length) : undefined;
  return { planId, ...(sourceNodeId !== undefined && sourceNodeId.length > 0 ? { sourceNodeId } : {}) };
}

/** Whether this scope ever committed an import plan. Plans are never deleted, so this answers "imported at all". */
async function scopeHasImportPlans(tx: IDBTransaction, key: string): Promise<boolean> {
  return (await cursorPage<ImportPlanRecord>(tx.objectStore(STORES.importPlans), scopeRowsRange(key), 1)).length > 0;
}

/** Streams a range until the op's node is found; the range bounds the work, not the number of rows read. */
async function scanImportNodes(source: IDBObjectStore | IDBIndex, range: IDBKeyRange,
  opId: string): Promise<ImportNodeRecord | undefined> {
  let found: ImportNodeRecord | undefined;
  await iterateCursor(source, range, (value) => {
    const node = value as ImportNodeRecord;
    if (node.opId !== opId) return true;
    found = node; return false;
  });
  return found;
}

/**
 * Every queued row of one import plan, streamed through its node records page by page. A plan larger than one page
 * must park (or resume) all of its rows, not the first window of them; each page is keyed off the previous page's
 * last order, so rows written while the pages are read are seen at most once.
 */
async function forEachPlanQueueRow(tx: IDBTransaction, key: string, planId: string,
  visit: (raw: unknown) => void): Promise<void> {
  const nodes = tx.objectStore(STORES.importNodes).index(INDEXES.importNodeByPlanOrder);
  const queue = tx.objectStore(STORES.queue); let after: number | undefined;
  for (;;) {
    const page = await cursorPage<ImportNodeRecord>(nodes, IDBKeyRange.bound(
      after === undefined ? [key, planId, 0] : [key, planId, after],
      [key, planId, Number.MAX_SAFE_INTEGER], after !== undefined, false), IMPORT_NODE_PAGE);
    for (const node of page) {
      const raw = await requestValue(queue.index(INDEXES.queueByOpId).get([key, node.opId]));
      if (raw !== undefined) visit(raw);
    }
    if (page.length < IMPORT_NODE_PAGE) return;
    after = page[page.length - 1]!.order;
  }
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
  await forEachPlanQueueRow(tx, key, planId, (raw) => {
    const row = validateQueueRecord(raw, maxRecordBytes);
    if (row.status !== 'pending' || row.attempt !== undefined) return;
    queue.put(asHeld(row, IMPORT_HOLD, maxRecordBytes)); held += 1;
  });
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
  await forEachPlanQueueRow(tx, key, planId, (raw) => {
    const row = validateQueueRecord(raw, maxRecordBytes);
    if (row.status !== 'set_aside' || row.recovery?.code !== IMPORT_HOLD) return;
    queue.put(validateQueueRecord({ ...row, status: 'pending', recovery: undefined,
      retry: { ...row.retry, notBefore: 0 } }, maxRecordBytes)); restored += 1;
  });
  return restored;
}
