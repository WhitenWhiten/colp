import { confirmBatch, previewOrThrow, resumeBatchPlans, statusBatch, undoBatch } from '../bookmark-batch-executor.js';
import { kns09Paused } from '../kns-09-release.js';
import { localBookmarkBatchStore, recoverLegacyLocalBookmarkBatches } from '../bookmark-batch-local.js';
import type { BatchCloudOwner, BatchOwner } from '../bookmark-batch-context.js';
import type { BatchRequest, BatchResponse, PublicBatchItem, PublicBatchStatus } from '../types.js';
import { hasBookmarkPermission, safeError, syncState, workCoordinator } from './runtime.js';
import { currentSyncScope } from './scope.js';
import { personalBookmarks, assertPersonalTreeAllowed, assertPersonalNativeAllowed } from '../bookmark-subscriptions/guards.js';

export async function handleBatchRequest(message: BatchRequest): Promise<BatchResponse> {
  return workCoordinator.run('native-bookmark', () => executeBatchRequest(message));
}

async function optionalSyncOwner(): Promise<BatchCloudOwner | undefined> {
  try { return { store: syncState, scope: await currentSyncScope({ allowStopped: true }) }; }
  catch { return undefined; } // Account attachment never authorizes native editing.
}

async function ownerForBatch(message: BatchRequest): Promise<BatchOwner> {
  const local = (await localBookmarkBatchStore()).local;
  // Existing browser-only work is resolved before reading any account attachment.
  if ((message.kind === 'known.batch.undo' || message.kind === 'known.batch.status')
    && message.planId && await local.readBatchPlan(message.planId)) return { local };
  if (message.kind === 'known.batch.undo' || message.kind === 'known.batch.status') {
    await recoverLegacyLocalBookmarkBatches();
    if (message.planId && await local.readBatchPlan(message.planId)) return { local };
  }
  const cloud = await optionalSyncOwner();
  // Read old account-owned plans only for status/undo compatibility. Every new
  // native command has a profile-owned journal and a native delete backup.
  if (cloud && (message.kind === 'known.batch.status' || message.kind === 'known.batch.undo')) {
    if (message.planId && await cloud.store.readBatchPlan(cloud.scope, message.planId).catch(() => null)) return cloud;
    if (message.kind === 'known.batch.status' && !message.planId) {
      const localPlan = (await local.listBatchPlans())[0];
      const currentPlan = (await cloud.store.listBatchPlans(cloud.scope).catch(() => []))[0];
      if (currentPlan && (!localPlan || currentPlan.updatedAt > localPlan.updatedAt)) return cloud;
    }
  }
  return { local, cloud };
}

async function executeBatchRequest(message: BatchRequest): Promise<BatchResponse> {
  if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
  if (typeof chrome.bookmarks === 'undefined') return { ok: false, error: 'permission_required' };
  const api = { get: chrome.bookmarks.get.bind(chrome.bookmarks), getTree: chrome.bookmarks.getTree.bind(chrome.bookmarks),
    getSubTree: chrome.bookmarks.getSubTree?.bind(chrome.bookmarks), ...personalBookmarks };
  try {
    if (message.kind === 'known.batch.preview' || message.kind === 'known.batch.confirm') {
      for (const nativeId of message.nativeIds) await assertPersonalTreeAllowed(nativeId);
      if (message.targetParentId) await assertPersonalNativeAllowed(message.targetParentId);
    }
    const owner = await ownerForBatch(message);
    if ('local' in owner) await resumeBatchPlans({ ...owner, api });
    if (message.kind === 'known.batch.preview') {
      const preview = await previewOrThrow({
        ...owner, api, kind: message.operation, nativeIds: message.nativeIds,
        targetParentId: message.targetParentId, titles: message.titles,
      });
      return {
        ok: true, preview: {
          digest: preview.digest, basisDigest: preview.basisDigest, operation: preview.kind, requiresSecondConfirm: preview.requiresSecondConfirm,
          crossBoundary: preview.crossBoundary,
          items: preview.items.map((item) => ({
            nativeId: item.nativeId, title: item.title, nodeKind: item.nodeKind, state: item.blocked ?? 'ready',
            ...(item.blocked ? { blocked: item.blocked } : {}), ...(item.colpId ? { colpId: item.colpId } : {}),
          })),
        },
      };
    }
    if (message.kind === 'known.batch.status') {
      return { ok: true, status: publicStatus(await statusBatch(owner, message.planId)) };
    }
    if (await kns09Paused('ui')) return { ok: false, error: 'sync_paused' };
    if (message.kind === 'known.batch.confirm') {
      const view = await confirmBatch({
        ...owner, api, commandId: message.commandId, kind: message.operation,
        nativeIds: message.nativeIds, previewDigest: message.previewDigest,
        secondConfirm: message.secondConfirm, targetParentId: message.targetParentId, titles: message.titles,
      });
      return { ok: true, status: publicStatus(view) };
    }
    const view = await undoBatch({
      ...owner, api, planId: message.planId, commandId: message.commandId,
    });
    return { ok: true, status: publicStatus(view) };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

export async function resumeActiveBatchPlans(): Promise<void> {
  if (!await hasBookmarkPermission() || typeof chrome.bookmarks === 'undefined') return;
  await workCoordinator.run('native-bookmark', async () => {
    // Account availability cannot orphan already admitted browser-only work.
    const local = (await localBookmarkBatchStore()).local;
    const api = { get: chrome.bookmarks.get.bind(chrome.bookmarks), getTree: chrome.bookmarks.getTree.bind(chrome.bookmarks),
      getSubTree: chrome.bookmarks.getSubTree?.bind(chrome.bookmarks), ...personalBookmarks };
    await resumeBatchPlans({ local, api });
    await recoverLegacyLocalBookmarkBatches();
    await resumeBatchPlans({ local, api });
    const current = await optionalSyncOwner();
    if (current) await resumeBatchPlans({ ...current, api });
  }).catch(() => undefined); // Durable plans remain available when storage or authority cannot be read.
}

function publicStatus(view: Awaited<ReturnType<typeof statusBatch>>): PublicBatchStatus {
  return {
    planId: view.planId, commandId: view.commandId, operation: view.kind, state: view.state,
    reused: view.reused, applied: view.applied, failed: view.failed, changed: view.changed, undone: view.undone,
    ...(view.undoExpiresAt === undefined ? {} : { undoExpiresAt: view.undoExpiresAt }),
    items: view.items.map((item): PublicBatchItem => ({
      nativeId: item.nativeId, title: item.title, nodeKind: item.nodeKind, state: item.state,
      ...(item.colpId ? { colpId: item.colpId } : {}), ...(item.error ? { error: item.error } : {}),
    })),
  };
}
