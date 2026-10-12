import { digestJson } from '../bookmark-event-codec.js';
import { boundedString, clone, safeInteger, strictObject, validateRecord } from './codec.js';
import { cursorPage, requestValue, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
export interface BatchJournalRuntime {
  readonly maxRecordBytes: number;
  readonly guardStores: readonly string[];
  assertWritable(): void;
  open(): Promise<IDBDatabase>;
  writableDatabase(): Promise<IDBDatabase>;
  requirePartition(tx: IDBTransaction, key: string): Promise<void>;
}
import { INDEXES, STORES } from './schema.js';
import { SyncStateError } from './types.js';

export const MAX_BATCH_ITEMS = 500;
export type BatchKind = 'move' | 'rename' | 'delete';
export type BatchPlanState = 'active' | 'completed' | 'partial' | 'undoing' | 'undone' | 'attention';
export type BatchItemState = 'pending' | 'executing' | 'applied' | 'failed' | 'changed' | 'skipped'
  | 'undoing' | 'undone';

export interface BatchPlanRecord {
  readonly scopeKey: string; readonly planId: string; readonly commandId: string; readonly kind: BatchKind;
  readonly digest: string; readonly treeDigest: string; readonly boundaryVersion: string;
  readonly state: BatchPlanState; readonly casVersion: number; readonly itemCount: number;
  readonly requiresSecondConfirm: boolean; readonly createdAt: number; readonly updatedAt: number;
  readonly undoExpiresAt?: number; readonly targetParentNativeId?: string;
}
export interface BatchItemRecord {
  readonly scopeKey: string; readonly planId: string; readonly itemId: string; readonly order: number;
  readonly nativeId: string; readonly nodeKind: 'folder' | 'bookmark'; readonly title: string;
  readonly parentNativeId: string; readonly index: number; readonly preDigest: string;
  readonly operationId: string; readonly reversalId: string; readonly state: BatchItemState;
  readonly casVersion: number; readonly colpId?: string; readonly url?: string; readonly parentColpId?: string;
  readonly targetParentNativeId?: string; readonly targetParentColpId?: string; readonly targetIndex?: number;
  readonly newTitle?: string; readonly postDigest?: string; readonly mappingRevision?: string; readonly error?: string;
  readonly subtreeDigest?: string;
  readonly postIndex?: number;
}

const PLAN_STATES: readonly BatchPlanState[] = [
  'active', 'completed', 'partial', 'undoing', 'undone', 'attention',
];
const ITEM_STATES: readonly BatchItemState[] = [
  'pending', 'executing', 'applied', 'failed', 'changed', 'skipped', 'undoing', 'undone',
];
const KINDS: readonly BatchKind[] = ['move', 'rename', 'delete'];
const LIVE: ReadonlySet<BatchPlanState> = new Set(['active', 'undoing']);

export function createBatchJournal(ctx: BatchJournalRuntime) {

  async function commitBatchPlan(partition: string, input: {
    readonly plan: Omit<BatchPlanRecord, 'scopeKey' | 'casVersion' | 'state'> & { readonly state?: BatchPlanState };
    readonly items: readonly Omit<BatchItemRecord, 'scopeKey' | 'casVersion' | 'state' | 'planId'>[];
  }): Promise<{ readonly plan: BatchPlanRecord; readonly items: readonly BatchItemRecord[]; readonly reused: boolean }> {
    ctx.assertWritable(); const key = partition;
    if (input.items.length === 0) throw new SyncStateError('batch_empty');
    if (input.items.length > MAX_BATCH_ITEMS) throw new SyncStateError('batch_too_large');
    const planId = boundedString(input.plan.planId, 'planId');
    const draftedItems = input.items.map((item, order) => readItem({
      ...item, scopeKey: key, planId, order, state: 'pending', casVersion: 1,
    }, key, ctx.maxRecordBytes));
    const digest = boundedString(input.plan.digest, 'digest');
    const drafted = readPlan({
      ...input.plan, scopeKey: key, planId, digest, state: input.plan.state ?? 'active', casVersion: 1,
      itemCount: draftedItems.length,
    }, key, ctx.maxRecordBytes);
    let reused = false; let plan = drafted; let items = draftedItems;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [...ctx.guardStores, STORES.batchPlans, STORES.batchItems], 'readwrite', async (tx) => {
      await ctx.requirePartition(tx, key);
      const plans = tx.objectStore(STORES.batchPlans);
      const prior = await requestValue(plans.get([key, planId]));
      if (prior) {
        plan = readPlan(prior, key, ctx.maxRecordBytes);
        if (plan.digest !== digest || plan.kind !== drafted.kind || plan.commandId !== drafted.commandId) {
          throw new SyncStateError('batch_command_conflict');
        }
        items = await loadItems(tx, key, planId, ctx.maxRecordBytes);
        reused = true; return;
      }
      const existing = (await cursorPage<BatchPlanRecord>(plans, scopeRowsRange(key), 1_001))
        .map((row) => readPlan(row, key, ctx.maxRecordBytes));
      if (existing.some((row) => LIVE.has(row.state))) throw new SyncStateError('batch_in_progress');
      plans.add(drafted);
      for (const item of draftedItems) tx.objectStore(STORES.batchItems).add(item);
    });
    return { plan: clone(plan), items: items.map((item) => clone(item)), reused };
  }

  async function listBatchPlans(partition: string): Promise<BatchPlanRecord[]> {
    const key = partition; const db = await ctx.open();
    const tx = db.transaction(STORES.batchPlans, 'readonly'); const done = transactionDone(tx);
    const rows = await cursorPage<BatchPlanRecord>(tx.objectStore(STORES.batchPlans), scopeRowsRange(key), 1_001);
    await done;
    return rows.map((row) => readPlan(row, key, ctx.maxRecordBytes))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.planId.localeCompare(right.planId));
  }

  async function readBatchPlan(partition: string, planId: string): Promise<{
    readonly plan: BatchPlanRecord; readonly items: readonly BatchItemRecord[];
  } | null> {
    const key = partition; boundedString(planId, 'planId');
    const db = await ctx.open(); const tx = db.transaction([STORES.batchPlans, STORES.batchItems], 'readonly');
    const done = transactionDone(tx);
    const raw = await requestValue(tx.objectStore(STORES.batchPlans).get([key, planId]));
    const items = raw ? await loadItems(tx, key, planId, ctx.maxRecordBytes) : [];
    await done; if (!raw) return null;
    return { plan: readPlan(raw, key, ctx.maxRecordBytes), items };
  }

  async function settleBatchItem(partition: string, input: {
    readonly planId: string; readonly itemId: string; readonly expectedCasVersion: number;
    readonly expectedState: BatchItemState; readonly state: BatchItemState; readonly now: number;
    readonly postDigest?: string; readonly error?: string;
    readonly postIndex?: number;
  }): Promise<BatchItemRecord> {
    ctx.assertWritable(); const key = partition; let result!: BatchItemRecord;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [...ctx.guardStores, STORES.batchPlans, STORES.batchItems], 'readwrite', async (tx) => {
      await ctx.requirePartition(tx, key);
      const items = tx.objectStore(STORES.batchItems);
      const prior = readItem(await requestValue(items.get([key, input.planId, input.itemId])),
        key, ctx.maxRecordBytes);
      if (prior.casVersion !== input.expectedCasVersion || prior.state !== input.expectedState) {
        throw new SyncStateError('batch_item_stale');
      }
      if (!itemTransition(prior.state, input.state)) throw new SyncStateError('batch_item_transition_invalid');
      const { error: _error, ...rest } = prior;
      result = readItem({
        ...rest, state: input.state, casVersion: prior.casVersion + 1,
        ...(input.postDigest ? { postDigest: input.postDigest } : prior.postDigest ? { postDigest: prior.postDigest } : {}),
        ...(input.error ? { error: input.error } : {}),
        ...(input.postIndex === undefined ? {} : { postIndex: input.postIndex }),
      }, key, ctx.maxRecordBytes);
      items.put(result);
      const plans = tx.objectStore(STORES.batchPlans);
      const plan = readPlan(await requestValue(plans.get([key, input.planId])), key, ctx.maxRecordBytes);
      plans.put(readPlan({ ...plan, updatedAt: input.now, casVersion: plan.casVersion + 1 }, key, ctx.maxRecordBytes));
    });
    return clone(result);
  }

  async function settleBatchPlan(partition: string, input: {
    readonly planId: string; readonly expectedCasVersion: number; readonly state: BatchPlanState;
    readonly now: number; readonly undoExpiresAt?: number;
  }): Promise<BatchPlanRecord> {
    ctx.assertWritable(); const key = partition; let result!: BatchPlanRecord;
    const db = await ctx.writableDatabase();
    await runTransaction(db, [...ctx.guardStores, STORES.batchPlans], 'readwrite', async (tx) => {
      await ctx.requirePartition(tx, key);
      const plans = tx.objectStore(STORES.batchPlans);
      const prior = readPlan(await requestValue(plans.get([key, input.planId])), key, ctx.maxRecordBytes);
      if (prior.casVersion !== input.expectedCasVersion) throw new SyncStateError('batch_plan_stale');
      if (prior.state === input.state) { result = prior; return; }
      if (!planTransition(prior.state, input.state)) throw new SyncStateError('batch_plan_transition_invalid');
      result = readPlan({
        ...prior, state: input.state, casVersion: prior.casVersion + 1, updatedAt: input.now,
        ...(input.undoExpiresAt === undefined ? {} : { undoExpiresAt: input.undoExpiresAt }),
      }, key, ctx.maxRecordBytes);
      plans.put(result);
    });
    return clone(result);
  }

  return { commitBatchPlan, listBatchPlans, readBatchPlan, settleBatchItem, settleBatchPlan };
}

export function batchPlanDigest(input: {
  readonly kind: BatchKind; readonly treeDigest: string; readonly boundaryVersion: string;
  readonly targetParentNativeId?: string;
  readonly items: readonly Pick<BatchItemRecord, 'nativeId' | 'colpId' | 'parentNativeId' | 'index'
    | 'preDigest' | 'mappingRevision' | 'newTitle' | 'targetParentNativeId' | 'targetIndex' | 'subtreeDigest'>[];
}): string {
  return digestJson({
    kind: input.kind, treeDigest: input.treeDigest, boundaryVersion: input.boundaryVersion,
    targetParentNativeId: input.targetParentNativeId ?? null,
    items: input.items.map((item) => ({
      nativeId: item.nativeId, colpId: item.colpId ?? null, parentNativeId: item.parentNativeId,
      index: item.index, preDigest: item.preDigest, mappingRevision: item.mappingRevision ?? null,
      newTitle: item.newTitle ?? null, targetParentNativeId: item.targetParentNativeId ?? null,
      targetIndex: item.targetIndex ?? null,
      ...(item.subtreeDigest ? { subtreeDigest: item.subtreeDigest } : {}),
    })),
  });
}

async function loadItems(tx: IDBTransaction, key: string, planId: string, maxBytes: number) {
  const rows = await cursorPage<BatchItemRecord>(tx.objectStore(STORES.batchItems).index(INDEXES.batchItemByPlanOrder),
    IDBKeyRange.bound([key, planId, 0], [key, planId, Number.MAX_SAFE_INTEGER]), MAX_BATCH_ITEMS + 1);
  return rows.map((row) => readItem(row, key, maxBytes));
}

function planTransition(from: BatchPlanState, to: BatchPlanState): boolean {
  return from === 'active' ? ['completed', 'partial', 'attention', 'undoing'].includes(to)
    : from === 'completed' || from === 'partial' ? to === 'undoing' || to === 'attention'
      : from === 'undoing' ? ['undone', 'partial', 'attention'].includes(to)
        : from === 'attention' && (to === 'active' || to === 'undoing');
}

function itemTransition(from: BatchItemState, to: BatchItemState): boolean {
  if (from === to) return true;
  return from === 'pending' ? ['executing', 'skipped', 'changed', 'failed'].includes(to)
    : from === 'executing' ? ['applied', 'failed', 'changed', 'pending'].includes(to)
      : from === 'applied' ? ['undoing', 'changed'].includes(to)
        : from === 'undoing' ? ['undone', 'changed', 'failed', 'applied'].includes(to)
          : from === 'failed' && to === 'pending';
}

export function readPlan(input: unknown, key: string, maxBytes: number): BatchPlanRecord {
  const row = strictObject(input, [
    'scopeKey', 'planId', 'commandId', 'kind', 'digest', 'treeDigest', 'boundaryVersion', 'state',
    'casVersion', 'itemCount', 'requiresSecondConfirm', 'createdAt', 'updatedAt', 'undoExpiresAt',
    'targetParentNativeId',
  ], 'batch plan', ['undoExpiresAt', 'targetParentNativeId']);
  if (row.scopeKey !== key || !KINDS.includes(row.kind as BatchKind)
      || !PLAN_STATES.includes(row.state as BatchPlanState)
      || row.requiresSecondConfirm !== true && row.requiresSecondConfirm !== false) {
    throw new SyncStateError('batch_plan_invalid');
  }
  const plan: BatchPlanRecord = {
    scopeKey: key, planId: boundedString(row.planId, 'planId'), commandId: boundedString(row.commandId, 'commandId'),
    kind: row.kind as BatchKind, digest: boundedString(row.digest, 'digest'),
    treeDigest: boundedString(row.treeDigest, 'treeDigest'),
    boundaryVersion: boundedString(row.boundaryVersion, 'boundaryVersion', 128),
    state: row.state as BatchPlanState, casVersion: safeInteger(row.casVersion, 'casVersion', 1),
    itemCount: safeInteger(row.itemCount, 'itemCount', 1), requiresSecondConfirm: row.requiresSecondConfirm,
    createdAt: safeInteger(row.createdAt, 'createdAt', 1), updatedAt: safeInteger(row.updatedAt, 'updatedAt', 1),
    ...(row.undoExpiresAt === undefined ? {} : { undoExpiresAt: safeInteger(row.undoExpiresAt, 'undoExpiresAt', 1) }),
    ...(row.targetParentNativeId === undefined ? {}
      : { targetParentNativeId: boundedString(row.targetParentNativeId, 'targetParentNativeId') }),
  };
  validateRecord(plan, maxBytes); return plan;
}

export function readItem(input: unknown, key: string, maxBytes: number): BatchItemRecord {
  const row = strictObject(input, [
    'scopeKey', 'planId', 'itemId', 'order', 'nativeId', 'nodeKind', 'title', 'parentNativeId', 'index',
    'preDigest', 'operationId', 'reversalId', 'state', 'casVersion', 'colpId', 'url', 'parentColpId',
    'targetParentNativeId', 'targetParentColpId', 'targetIndex', 'newTitle', 'postDigest', 'mappingRevision',
    'error', 'subtreeDigest', 'postIndex',
  ], 'batch item', [
    'colpId', 'url', 'parentColpId', 'targetParentNativeId', 'targetParentColpId', 'targetIndex', 'newTitle',
    'postDigest', 'mappingRevision', 'error', 'subtreeDigest', 'postIndex',
  ]);
  if (row.scopeKey !== key || (row.nodeKind !== 'folder' && row.nodeKind !== 'bookmark')
      || !ITEM_STATES.includes(row.state as BatchItemState)) {
    throw new SyncStateError('batch_item_invalid');
  }
  const item: BatchItemRecord = {
    scopeKey: key, planId: boundedString(row.planId, 'planId'), itemId: boundedString(row.itemId, 'itemId'),
    order: safeInteger(row.order, 'order'), nativeId: boundedString(row.nativeId, 'nativeId'),
    nodeKind: row.nodeKind, title: boundedString(row.title || 'Untitled', 'title', 512),
    parentNativeId: boundedString(row.parentNativeId, 'parentNativeId'),
    index: safeInteger(row.index, 'index'), preDigest: boundedString(row.preDigest, 'preDigest'),
    operationId: boundedString(row.operationId, 'operationId'),
    reversalId: boundedString(row.reversalId, 'reversalId'), state: row.state as BatchItemState,
    casVersion: safeInteger(row.casVersion, 'casVersion', 1),
    ...(row.colpId === undefined ? {} : { colpId: boundedString(row.colpId, 'colpId') }),
    ...(row.url === undefined ? {} : { url: boundedString(row.url, 'url', 8_192) }),
    ...(row.parentColpId === undefined ? {} : { parentColpId: boundedString(row.parentColpId, 'parentColpId') }),
    ...(row.targetParentNativeId === undefined ? {}
      : { targetParentNativeId: boundedString(row.targetParentNativeId, 'targetParentNativeId') }),
    ...(row.targetParentColpId === undefined ? {}
      : { targetParentColpId: boundedString(row.targetParentColpId, 'targetParentColpId') }),
    ...(row.targetIndex === undefined ? {} : { targetIndex: safeInteger(row.targetIndex, 'targetIndex') }),
    ...(row.newTitle === undefined ? {} : { newTitle: boundedString(row.newTitle, 'newTitle', 512) }),
    ...(row.postDigest === undefined ? {} : { postDigest: boundedString(row.postDigest, 'postDigest') }),
    ...(row.mappingRevision === undefined ? {}
      : { mappingRevision: boundedString(row.mappingRevision, 'mappingRevision') }),
    ...(row.error === undefined ? {} : { error: boundedString(row.error, 'error', 128) }),
    ...(row.subtreeDigest === undefined ? {} : { subtreeDigest: boundedString(row.subtreeDigest, 'subtreeDigest', 128) }),
    ...(row.postIndex === undefined ? {} : { postIndex: safeInteger(row.postIndex, 'postIndex') }),
  };
  validateRecord(item, maxBytes); return item;
}
