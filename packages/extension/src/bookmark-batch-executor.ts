import { digestJson, validateOperation } from './bookmark-event-codec.js';
import {
  itemPostDigest, itemPreDigest, previewBatch, toCommitItems, type BatchBookmarkApi, type BatchChromeNode,
  type BatchPreview,
} from './bookmark-batch-plan.js';
import { lookupBookmark } from './bookmark-api-error.js';
import { kns09Paused } from './kns-09-release.js';
import { backupLocalDelete, restoreLocalDelete } from './bookmark-local-delete.js';
import { assertDeleteSubtree } from './bookmark-batch-delete-boundary.js';
import { withReceiptOutcome } from './sync-state/open-issue-facts.js';
import { batchTargetIndex, batchUndoPosition, matchesBatchInput, matchesBatchOutput } from './bookmark-batch-position.js';
import {
  type BatchItemRecord, type BatchKind, type BatchPlanRecord,
} from './sync-state/batch-repository.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';
import { batchContext, type BatchOwner, type BatchContext } from './bookmark-batch-context.js';

export { BOOKMARK_UNDO_WINDOW_MS as BATCH_UNDO_WINDOW_MS } from './bookmark-undo.js';
import { BOOKMARK_UNDO_WINDOW_MS as BATCH_UNDO_WINDOW_MS } from './bookmark-undo.js';
type Store = ReturnType<typeof createSyncStateStore>;

export interface BatchView {
  readonly planId: string; readonly commandId: string; readonly kind: BatchKind;
  readonly state: BatchPlanRecord['state']; readonly digest: string; readonly reused: boolean;
  readonly requiresSecondConfirm: boolean; readonly undoExpiresAt?: number;
  readonly items: readonly BatchItemRecord[];
  readonly applied: number; readonly failed: number; readonly changed: number; readonly undone: number;
}

export async function confirmBatch(input: BatchOwner & {
  readonly api: BatchBookmarkApi;
  readonly commandId: string; readonly kind: BatchKind; readonly nativeIds: readonly string[];
  readonly previewDigest: string; readonly secondConfirm?: boolean;
  readonly targetParentId?: string; readonly titles?: Readonly<Record<string, string>>;
  readonly now?: () => number; readonly uuid?: () => string;
}): Promise<BatchView> {
  const context = batchContext(input);
  if (await kns09Paused('ui')) throw Object.assign(new Error('sync_paused'), { code: 'sync_paused' });
  const now = input.now ?? Date.now; const uuid = input.uuid ?? (() => crypto.randomUUID());
  const existing = await context.journal.readBatchPlan(input.commandId);
  if (existing) {
    if (existing.plan.digest !== input.previewDigest || existing.plan.kind !== input.kind) {
      throw Object.assign(new Error('batch_command_conflict'), { code: 'batch_command_conflict' });
    }
    if (existing.plan.state === 'active') await executePlan(context, input.api, existing.plan.planId, now);
    return viewOf(context, existing.plan.planId, true);
  }
  const preview = await previewBatch({
    ...input, api: input.api, kind: input.kind,
    nativeIds: input.nativeIds, targetParentId: input.targetParentId, titles: input.titles,
  });
  if (preview.digest !== input.previewDigest) {
    throw Object.assign(new Error('stale_revision'), { code: 'stale_revision' });
  }
  if (preview.items.length === 0) {
    throw Object.assign(new Error('empty_batch'), { code: 'empty_batch' });
  }
  if (preview.blocked.length === preview.items.length) {
    throw Object.assign(new Error(preview.blocked[0]?.blocked ?? 'empty_batch'), {
      code: preview.blocked[0]?.blocked ?? 'empty_batch',
    });
  }
  if (preview.requiresSecondConfirm && input.secondConfirm !== true) {
    throw Object.assign(new Error('confirm_required'), { code: 'confirm_required' });
  }
  const createdAt = now();
  const committed = await context.journal.commitBatchPlan({
    plan: {
      planId: input.commandId, commandId: input.commandId, kind: input.kind, digest: preview.digest,
      treeDigest: preview.treeDigest, boundaryVersion: preview.boundaryVersion, itemCount: 1,
      requiresSecondConfirm: preview.requiresSecondConfirm, createdAt, updatedAt: createdAt,
      ...(input.targetParentId ? { targetParentNativeId: input.targetParentId } : {}),
    },
    items: toCommitItems(preview, { uuid }, 'local' in input),
  });
  await executePlan(context, input.api, committed.plan.planId, now);
  return viewOf(context, committed.plan.planId, committed.reused);
}

export async function resumeBatchPlans(input: BatchOwner & {
  readonly api: BatchBookmarkApi;
  readonly now?: () => number;
}): Promise<readonly BatchView[]> {
  const context = batchContext(input);
  const now = input.now ?? Date.now;
  const plans = await context.journal.listBatchPlans();
  const live = plans.filter((plan) => plan.state === 'active' || plan.state === 'undoing');
  const views: BatchView[] = [];
  for (const plan of live) {
    if (plan.state === 'undoing') await undoPlan(context, input.api, plan.planId, now);
    else await executePlan(context, input.api, plan.planId, now);
    views.push(await viewOf(context, plan.planId, true));
  }
  return views;
}

export async function undoBatch(input: BatchOwner & {
  readonly api: BatchBookmarkApi;
  readonly planId: string; readonly commandId: string; readonly now?: () => number;
}): Promise<BatchView> {
  const context = batchContext(input);
  if (await kns09Paused('ui')) throw Object.assign(new Error('sync_paused'), { code: 'sync_paused' });
  const now = input.now ?? Date.now;
  const recorded = await context.journal.readBatchPlan(input.planId);
  if (!recorded) throw Object.assign(new Error('batch_plan_not_found'), { code: 'batch_plan_not_found' });
  if (recorded.plan.commandId !== input.commandId) {
    throw Object.assign(new Error('batch_command_conflict'), { code: 'batch_command_conflict' });
  }
  if (recorded.plan.state === 'undone' || recorded.plan.state === 'undoing') {
    if (recorded.plan.state === 'undoing') await undoPlan(context, input.api, recorded.plan.planId, now);
    return viewOf(context, recorded.plan.planId, true);
  }
  if (recorded.plan.state !== 'completed' && recorded.plan.state !== 'partial') {
    throw Object.assign(new Error('batch_not_undoable'), { code: 'batch_not_undoable' });
  }
  if (recorded.plan.undoExpiresAt !== undefined && now() > recorded.plan.undoExpiresAt) {
    throw Object.assign(new Error('undo_expired'), { code: 'undo_expired' });
  }
  await context.journal.settleBatchPlan({
    planId: recorded.plan.planId, expectedCasVersion: recorded.plan.casVersion, state: 'undoing', now: now(),
  });
  await undoPlan(context, input.api, recorded.plan.planId, now);
  return viewOf(context, recorded.plan.planId, false);
}

export async function statusBatch(owner: BatchOwner, planId?: string): Promise<BatchView> {
  const context = batchContext(owner);
  if (planId) return viewOf(context, planId, false);
  const plans = await context.journal.listBatchPlans();
  const latest = plans[0];
  if (!latest) throw Object.assign(new Error('batch_plan_not_found'), { code: 'batch_plan_not_found' });
  return viewOf(context, latest.planId, false);
}

export async function previewOrThrow(input: BatchOwner & {
  readonly api: BatchBookmarkApi;
  readonly kind: BatchKind; readonly nativeIds: readonly string[];
  readonly targetParentId?: string; readonly titles?: Readonly<Record<string, string>>;
}): Promise<BatchPreview> {
  return previewBatch(input);
}

async function executePlan(context: BatchContext, api: BatchBookmarkApi, planId: string,
  now: () => number): Promise<void> {
  const recorded = await context.journal.readBatchPlan(planId);
  if (!recorded || recorded.plan.state !== 'active') return;
  const items = [...recorded.items];
  for (const [index, item] of items.entries()) {
    if (item.state !== 'pending' && item.state !== 'executing') continue;
    const settled = await runItem(context, api, recorded.plan, item, items, now);
    if (settled) items[index] = settled;
  }
  await finishPlan(context, planId, now, false);
}

async function runItem(context: BatchContext, api: BatchBookmarkApi, plan: BatchPlanRecord,
  item: BatchItemRecord, items: readonly BatchItemRecord[], now: () => number): Promise<BatchItemRecord | undefined> {
  const started = item.state === 'executing' ? item : await context.journal.settleBatchItem({
    planId: plan.planId, itemId: item.itemId, expectedCasVersion: item.casVersion,
    expectedState: item.state, state: 'executing', now: now(),
  });
  try {
    const read = await readNode(api, item.nativeId);
    if (read.state === 'failed') {
      return settleItem(context, plan, item, started, now, 'failed', read.code);
    }
    if (read.state === 'present' && !matchesBatchInput(read.node, item, items, plan.kind)) {
      return settleItem(context, plan, item, started, now, 'changed', 'changed');
    }
    if (plan.kind === 'delete') {
      // Only a verified Chromium not_found proves the target was already gone.
      if (read.state === 'not_found') return settleDeleted(context, plan, item, started, now);
      return await runDeleteItem(context, api, plan, item, items, started, read.node, now);
    }
    if (read.state === 'not_found') return settleItem(context, plan, item, started, now, 'failed', 'missing');
    if (plan.kind === 'rename') return await runRenameItem(context, api, plan, item, started, now);
    return await runMoveItem(context, api, plan, item, items, started, read.node, now);
  } catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message) ? error.message
      : 'chrome_mutation_failed';
    return context.journal.settleBatchItem({
      planId: plan.planId, itemId: item.itemId, expectedCasVersion: started.casVersion,
      expectedState: 'executing', state: code === 'changed' ? 'changed' : 'failed', now: now(), error: code,
    }).catch(() => undefined);
  }
}

async function runDeleteItem(context: BatchContext, api: BatchBookmarkApi, plan: BatchPlanRecord,
  item: BatchItemRecord, items: readonly BatchItemRecord[], started: BatchItemRecord,
  live: BatchChromeNode, now: () => number): Promise<BatchItemRecord> {
  if (!item.colpId) await backupLocalDelete(api, item, now());
  if (item.nodeKind === 'folder') await assertDeleteSubtree(api, item.nativeId, item.subtreeDigest);
  const beforeRead = await readNode(api, item.nativeId);
  if (beforeRead.state === 'failed') throw new Error(beforeRead.code);
  const beforeDelete = beforeRead.state === 'present' ? beforeRead.node : undefined;
  if (!beforeDelete || !matchesBatchInput(beforeDelete, item, items, plan.kind)) throw new Error('changed');
  if (item.nodeKind === 'folder') await api.removeTree(item.nativeId); else await api.remove(item.nativeId);
  return settleItem(context, plan, item, started, now, 'applied', undefined,
    live.index ?? 0, deletedPostDigest(item));
}

async function runRenameItem(context: BatchContext, api: BatchBookmarkApi, plan: BatchPlanRecord,
  item: BatchItemRecord, started: BatchItemRecord, now: () => number): Promise<BatchItemRecord> {
  const next = await api.update(item.nativeId, { title: item.newTitle ?? item.title });
  return settleItem(context, plan, item, started, now, 'applied', undefined, next.index ?? 0,
    itemPreDigest(next));
}

async function runMoveItem(context: BatchContext, api: BatchBookmarkApi, plan: BatchPlanRecord,
  item: BatchItemRecord, items: readonly BatchItemRecord[], started: BatchItemRecord,
  live: BatchChromeNode, now: () => number): Promise<BatchItemRecord> {
  const parentId = item.targetParentNativeId ?? live.parentId;
  if (!parentId) throw new Error('move_target_required');
  const next = await api.move(item.nativeId, {
    parentId, ...(item.targetIndex === undefined ? {} : { index: batchTargetIndex(items) }),
  });
  return settleItem(context, plan, item, started, now, 'applied', undefined, next.index ?? 0,
    itemPreDigest(next));
}

function settleDeleted(context: BatchContext, plan: BatchPlanRecord, item: BatchItemRecord,
  started: BatchItemRecord, now: () => number): Promise<BatchItemRecord> {
  return settleItem(context, plan, item, started, now, 'applied', undefined, undefined, deletedPostDigest(item));
}

function deletedPostDigest(item: BatchItemRecord): string {
  return itemPostDigest({ nativeId: item.nativeId, title: item.title, url: item.url,
    parentId: item.parentNativeId, index: item.index, kind: item.nodeKind, deleted: true });
}

function settleItem(context: BatchContext, plan: BatchPlanRecord, item: BatchItemRecord,
  started: BatchItemRecord, now: () => number, state: 'applied' | 'failed' | 'changed',
  error: string | undefined, postIndex?: number, postDigest?: string): Promise<BatchItemRecord> {
  return context.journal.settleBatchItem({
    planId: plan.planId, itemId: item.itemId, expectedCasVersion: started.casVersion,
    expectedState: 'executing', state, now: now(), ...(error ? { error } : {}),
    ...(postIndex === undefined ? {} : { postIndex }), ...(postDigest === undefined ? {} : { postDigest }),
  });
}

async function undoPlan(context: BatchContext, api: BatchBookmarkApi, planId: string,
  now: () => number): Promise<void> {
  const recorded = await context.journal.readBatchPlan(planId);
  if (!recorded) return;
  const items = [...recorded.items];
  for (const item of [...items].reverse()) {
    if (item.state === 'undone') continue;
    if (item.state !== 'applied' && item.state !== 'undoing') continue;
    const started = item.state === 'undoing' ? item : await context.journal.settleBatchItem({
      planId, itemId: item.itemId, expectedCasVersion: item.casVersion, expectedState: 'applied',
      state: 'undoing', now: now(),
    });
    try {
      if (recorded.plan.kind === 'delete' && !item.colpId) await restoreLocalDelete(api, item);
      else if (recorded.plan.kind === 'delete') {
        const cloud = context.cloud; if (!cloud) throw new Error('local_batch_cloud_identity');
        await undoDelete(cloud.store, cloud.scope, item, now);
      }
      else await undoChrome(api, recorded.plan.kind, started, items);
      items[item.order] = await context.journal.settleBatchItem({
        planId, itemId: item.itemId, expectedCasVersion: started.casVersion, expectedState: 'undoing',
        state: 'undone', now: now(),
      });
    } catch (error) {
      const code = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message) ? error.message
        : 'undo_failed';
      // `delete_not_committed` is the one code whose un-doability is a property
      // of the data (the delete is still in flight, so a later undo pass can
      // retry it), not of this attempt. Every other code — including
      // `delete_row_not_found`, which means the lookup itself failed — must
      // settle the item so the UI can show that the undo did not happen.
      if (code === 'delete_not_committed') continue;
      const state = code === 'changed' ? 'changed' as const : 'failed' as const;
      const settled = await context.journal.settleBatchItem({
        planId, itemId: item.itemId, expectedCasVersion: started.casVersion, expectedState: 'undoing',
        state, now: now(), error: code,
      }).catch(() => undefined);
      if (settled) items[item.order] = settled;
    }
  }
  await finishPlan(context, planId, now, true);
}

async function undoChrome(api: BatchBookmarkApi, kind: BatchKind, item: BatchItemRecord, items: readonly BatchItemRecord[]): Promise<void> {
  const read = await readNode(api, item.nativeId);
  if (read.state === 'failed') throw new Error(read.code);
  if (read.state === 'not_found') throw new Error('changed');
  const live = read.node;
  if (!matchesBatchOutput(live, item, items, kind)) throw new Error('changed');
  if (kind === 'rename') {
    await api.update(item.nativeId, { title: item.title });
    return;
  }
  await api.move(item.nativeId, batchUndoPosition(item, items, kind));
}

async function undoDelete(store: Store, scope: SyncScope, item: BatchItemRecord, now: () => number): Promise<void> {
  if (!item.colpId || !item.mappingRevision) {
    throw new Error(item.colpId ? 'changed' : 'local_only_delete');
  }
  const deleted = await findCommittedDelete(store, scope, item);
  if (deleted.state === 'uncommitted') throw new Error('delete_not_committed');
  if (deleted.state === 'missing') throw new Error('delete_row_not_found');
  const receipt = await store.getQueueReceipt(scope, deleted.row.sequence);
  if (withReceiptOutcome(deleted.row, receipt ?? undefined).recovery?.resultStatus === 'rejected') {
    throw new Error('delete_rejected');
  }
  const results = receipt?.result && Array.isArray(receipt.result.results) ? receipt.result.results : [];
  const pushed = results[0] && typeof results[0] === 'object' && !Array.isArray(results[0])
    ? results[0] as { revision?: unknown } : undefined;
  const deleteRevision = typeof pushed?.revision === 'string' ? pushed.revision
    : typeof deleted.row.baseRevision === 'string' ? deleted.row.baseRevision : item.mappingRevision;
  await enqueueRestore(store, scope, item, deleteRevision, now());
}

/** A committed delete row, or the reason no restorable one exists. */
type CommittedDeleteLookup =
  | { readonly state: 'committed'; readonly row: QueueOperation }
  | { readonly state: 'uncommitted' }
  | { readonly state: 'missing' };

/**
 * The delete row that reversed this mapping, looked up by COLP target rather
 * than by a queue window. The queue is never pruned, so any bounded
 * `listQueue` page eventually stops containing the row and this undo used to
 * conclude "not committed" forever — invisibly, because `undoPlan` swallows
 * that code.
 *
 * `missing` means no delete row exists for the target at all (nothing was
 * committed remotely, so there is nothing to restore). `uncommitted` means the
 * row exists but cannot be reversed yet (still in flight, or the mapping moved
 * on since the batch preview).
 */
async function findCommittedDelete(store: Store, scope: SyncScope, item: BatchItemRecord): Promise<CommittedDeleteLookup> {
  // Every row that addresses this target. A window is truncated by
  // `operationRevision` BEFORE the delete-type and status filters below, so a
  // fixed page loses a busy target's delete row — 100 was such a window and
  // 1_000 only moved the threshold. The read is therefore paged to completion
  // rather than bounded once, and the queue's own 1_000-row ceiling is raised
  // only for this paging, which stops as soon as the target's rows are exhausted
  // (one target's rows are bounded by the operations ever issued against it).
  const rows = await store.listQueueByTarget(scope, item.colpId!);
  const deletes = rows.filter((row) => row.payload.type === 'delete_node' || row.payload.type === 'delete_subtree');
  if (deletes.length === 0) return { state: 'missing' };
  // Same revision tolerance the push worker uses to bind a mapping to its row:
  // the revision recorded at batch preview may be either the row's base or its
  // local operation revision.
  const matchesMapping = (row: QueueOperation) => row.baseRevision === item.mappingRevision
    || row.operationRevision === item.mappingRevision;
  const candidates = deletes.filter(matchesMapping);
  const pool = (candidates.length > 0 ? candidates : deletes).slice()
    .sort((left, right) => right.sequence - left.sequence);
  const committed = pool.find((row) => row.status === 'terminal' || row.status === 'rejected');
  if (!committed) return { state: 'uncommitted' };
  if (committed.status === 'rejected') throw new Error('delete_rejected');
  return { state: 'committed', row: committed };
}

async function enqueueRestore(store: Store, scope: SyncScope, item: BatchItemRecord,
  deleteRevision: string | undefined, now: number): Promise<QueueOperation> {
  const opId = item.reversalId;
  const targetId = item.colpId;
  const baseRevision = deleteRevision ?? item.mappingRevision;
  if (!targetId || !baseRevision) throw new Error('local_only_delete');
  const existing = await store.getQueueByOpId(scope, opId);
  if (existing) return existing;
  return store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: opId, idempotencyKey: opId, digest: 'sha256:pending', endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: {
      type: 'restore_node', opId, targetId, baseRevision, occurredAt: new Date(now).toISOString(),
      dependencies: [], payload: { reason: 'bookmark_batch_undo' },
    },
  }, { validateOperation, digestOperation: digestJson });
}

async function finishPlan(context: BatchContext, planId: string, now: () => number, undoing: boolean) {
  const recorded = await context.journal.readBatchPlan(planId);
  if (!recorded) return;
  const items = recorded.items;
  const next = undoing
    ? items.every((item) => item.state === 'undone' || item.state === 'changed' || item.state === 'skipped'
      || item.state === 'failed')
      ? items.some((item) => item.state === 'undone') && items.some((item) => item.state === 'changed'
        || item.state === 'failed') ? 'partial' : items.every((item) => item.state === 'undone')
          ? 'undone' : 'partial'
      : recorded.plan.state
    : items.every((item) => item.state === 'applied') ? 'completed'
      : items.some((item) => item.state === 'applied') ? 'partial'
        : items.some((item) => item.state === 'pending' || item.state === 'executing') ? 'active'
          : 'attention';
  if (next === recorded.plan.state) return;
  await context.journal.settleBatchPlan({
    planId, expectedCasVersion: recorded.plan.casVersion, state: next, now: now(),
    ...(next === 'completed' || next === 'partial' ? { undoExpiresAt: now() + BATCH_UNDO_WINDOW_MS } : {}),
  }).catch(() => undefined);
}

async function viewOf(context: BatchContext, planId: string, reused: boolean): Promise<BatchView> {
  const recorded = await context.journal.readBatchPlan(planId);
  if (!recorded) throw Object.assign(new Error('batch_plan_not_found'), { code: 'batch_plan_not_found' });
  const items = recorded.items;
  return {
    planId: recorded.plan.planId, commandId: recorded.plan.commandId, kind: recorded.plan.kind,
    state: recorded.plan.state, digest: recorded.plan.digest, reused,
    requiresSecondConfirm: recorded.plan.requiresSecondConfirm, undoExpiresAt: recorded.plan.undoExpiresAt,
    items, applied: items.filter((item) => item.state === 'applied').length,
    failed: items.filter((item) => item.state === 'failed').length,
    changed: items.filter((item) => item.state === 'changed').length,
    undone: items.filter((item) => item.state === 'undone').length,
  };
}

type BatchNodeRead =
  | { readonly state: 'present'; readonly node: BatchChromeNode }
  | { readonly state: 'not_found' }
  | { readonly state: 'failed'; readonly code: 'bookmark_permission_denied' | 'bookmark_managed_not_writable'
      | 'bookmark_lookup_failed' };

/**
 * A node read where absence is evidence and failure is not. Chromium rejects a
 * missing id; an API failure (permission revoked, managed tree) must never be
 * mistaken for a deletion that already happened.
 */
async function readNode(api: BatchBookmarkApi, id: string): Promise<BatchNodeRead> {
  const looked = await lookupBookmark((nativeId) => api.get(nativeId), id);
  if (looked.class === 'present') {
    const node = looked.nodes[0];
    return node ? { state: 'present', node: node as BatchChromeNode }
      : { state: 'failed', code: 'bookmark_lookup_failed' };
  }
  if (looked.class === 'not_found') return { state: 'not_found' };
  if (looked.class === 'permission_denied') return { state: 'failed', code: 'bookmark_permission_denied' };
  if (looked.class === 'managed_not_writable') return { state: 'failed', code: 'bookmark_managed_not_writable' };
  return { state: 'failed', code: 'bookmark_lookup_failed' };
}
