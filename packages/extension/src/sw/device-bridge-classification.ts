import type { BrowserRequest } from '../automation/device-bridge.js';
import { deviceResultPage } from '../automation/device-bridge-result.js';
import { captureStore } from './capture.js';
import type { CaptureScope, CaptureTask } from '../capture/contracts.js';
import { currentCaptureScope } from './capture-native.js';
import { retryLocalCaptureClassification } from './capture-local.js';
import { runLocalClassification } from './classification-local.js';
import { classificationDocument } from '../classification-intent.js';
import { readClassificationContext } from '../classification-local-context.js';
import { workCoordinator } from './runtime.js';
import type { SyncScope } from '../sync-state-store.js';

function captureView(task: CaptureTask) {
  return { id: task.captureId, title: task.title, url: task.url, revision: task.revision, createdAt: task.createdAt,
    state: task.classification, reason: task.reason, saveState: task.save, nativeId: task.nativeId,
    local: !!task.local, retryable: !!task.local && !task.manualFence && task.disposition === 'new' && task.save === 'local-saved'
      && ['manual', 'failed', 'waiting'].includes(task.classification),
    suggestedFolder: task.local?.folderNativeId ?? null };
}

async function scopeFor(sync: SyncScope): Promise<CaptureScope> {
  const scope = await currentCaptureScope();
  if (scope.accountId !== sync.accountId || scope.serverOrigin !== sync.serverOrigin || scope.collectionId !== sync.collectionId)
    throw Error('device_scope_changed');
  return scope;
}
async function capture(request: BrowserRequest, scope: CaptureScope) {
  const task = await captureStore.getForOwner(scope, request.input.captureId ?? '');
  if (!task || task.planned || task.scope.collectionId !== scope.collectionId) throw Error('capture_not_found');
  return task;
}

export async function handleCaptureBridge(request: BrowserRequest, sync: SyncScope, authorize: () => Promise<void>): Promise<unknown> {
  await authorize(); const scope = await scopeFor(sync);
  if (request.operation === 'classification.captures.list') {
    let before: [number, string] | undefined;
    if (request.input.cursor) {
      let cursor: unknown; try { cursor = JSON.parse(request.input.cursor); } catch { throw Error('invalid_cursor'); }
      if (!Array.isArray(cursor) || cursor.length !== 5 || cursor[0] !== scope.serverOrigin || cursor[1] !== scope.accountId
        || cursor[2] !== scope.collectionId || !Number.isFinite(cursor[3]) || typeof cursor[4] !== 'string') throw Error('invalid_cursor');
      before = [cursor[3], cursor[4]];
    }
    const tasks = await captureStore.listForOwner(scope, before, 20);
    const visible = tasks.filter(task => !task.planned && task.scope.collectionId === scope.collectionId);
    const cursorFor = (task: { createdAt: number; id: string }) => JSON.stringify([scope.serverOrigin, scope.accountId, scope.collectionId, task.createdAt, task.id]);
    const last = tasks.at(-1);
    return deviceResultPage(request.id, visible.map(captureView), { context: await readClassificationContext() }, {
      cursorFor, tailCursor: tasks.length === 20 && last ? cursorFor(captureView(last)) : null,
    });
  }
  if (request.operation === 'classification.preview') {
    const task = request.input.captureId ? await capture(request, scope) : undefined;
    const bookmark = task ?? request.input.bookmark; if (!bookmark) throw Error('classification_input_required');
    return workCoordinator.run('local-classification', async context => {
      await authorize(); await scopeFor(sync);
      const reply = await runLocalClassification({ document: classificationDocument(bookmark, { folder: true, tags: request.input.tags === true }),
        commandId: `bridge:${request.id}`, generation: context.generation, signal: context.signal,
        excludeBookmarkId: task?.nativeId ?? undefined, assertCurrent: authorize });
      if (!reply.ok) throw Error(reply.error);
      return { ...reply, context: await readClassificationContext() };
    });
  }
  const task = await capture(request, scope);
  if (request.operation === 'classification.captures.get') return { capture: captureView(task), context: await readClassificationContext() };
  if (request.operation === 'classification.captures.retry') {
    if (!Number.isSafeInteger(request.input.baseRevision)) throw Error('capture_revision_required');
    const result = await retryLocalCaptureClassification(task, captureStore, request.input.baseRevision!, async () => {
      await authorize(); await scopeFor(sync);
    });
    return { capture: captureView(result) };
  }
  throw Error('device_operation_unsupported');
}
