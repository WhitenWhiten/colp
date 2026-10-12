import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { assertPersonalCapture } from '../bookmark-subscriptions/capture-boundary.js';
import { createClassificationProductClient, ClassificationProductError } from '../classification-product-client.js';
import { captureStore } from './capture.js';
import { currentCaptureScope, assertCaptureScope, nativeCaptureLocation } from './capture-native.js';
import { captureIsInSyncRange } from './capture-privacy.js';
import { captureDeviceId } from './capture-history.js';
let uploading: Promise<void> | undefined;
export function flushCaptureReports(): Promise<void> {
  uploading ??= flush().finally(() => { uploading = undefined; }); return uploading;
}
async function flush() {
  const scope = await currentCaptureScope();
  await captureStore.prune(scope, Date.now());
  if (!scope.accountId || navigator.onLine === false) return;
  let activeTask:import('../capture/contracts.js').CaptureTask|undefined;
  const client = createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: scope.accountId,
    assertCurrent: () => assertCaptureScope(scope), dispatch: send => withSubscriptionRead(async () => {
      if (!activeTask) throw new Error('capture_unavailable');
      const latest = await captureStore.get(activeTask.scope, activeTask.captureId);
      if (!latest || latest.revision !== activeTask.revision || latest.sync === 'local-only'
        || !await captureIsInSyncRange(latest)) throw new Error('capture_report_not_authorized');
      if (latest.nativeId) {
        const location = await nativeCaptureLocation(latest.nativeId, latest.scope);
        if (JSON.stringify(location) !== JSON.stringify(activeTask.localLocation)) throw new Error('capture_report_location_changed');
      }
      await assertCaptureScope(scope);
      return send();
    }) }), deviceId = await captureDeviceId();
  let before: readonly [number, string] | undefined;
  for (;;) {
    const page = await captureStore.listForOwner(scope, before);
    for (let item of page) {
      // Local-only captures keep their page data on this browser.
      if (!item.scope.collectionId || item.sync === 'local-only' || (item.reportedRevision ?? -1) >= item.revision
        || item.reportFailure?.revision === item.revision) continue;
      if (!await captureIsInSyncRange(item)) continue;
      if (item.nativeId) {
        const location = await nativeCaptureLocation(item.nativeId, item.scope).catch(() => null);
        if (!location) continue;
        if (JSON.stringify(location) !== JSON.stringify(item.localLocation)) {
          const next = { ...item, localLocation: location, revision: item.revision + 1, updatedAt: Date.now() };
          await assertCaptureScope(scope); await captureStore.update(next, item.revision); item = next;
        }
      }
      const task = await captureStore.prepareReport(item);
      const nodeId = task.nodeId ?? task.localLocation?.nodeId;
      activeTask=task;try {await assertPersonalCapture(task);
        const result = await client.reportCapture({ captureId: task.captureId, deviceId: task.deviceId ?? deviceId,
          collectionId: task.scope.collectionId!, nodeId: nodeId && !nodeId.startsWith('pending-') ? nodeId : null,
          revision: task.revision, startedAt: new Date(task.createdAt).toISOString(), title: task.title, url: task.url,
          localPath: [...task.localLocation?.path ?? []], source: task.source, disposition: task.disposition, save: task.save,
          automaticIntent: task.automaticIntent, sync: task.sync, reason: task.reason,
          ...(task.savedAt === undefined ? {} : { savedAt: new Date(task.savedAt).toISOString() }),
          ...(task.classificationAppliedAt === undefined ? {} : { classificationAppliedAt: new Date(task.classificationAppliedAt).toISOString() }),
        }, task.reportIntent!.commandId);
        await assertCaptureScope(scope); await captureStore.reported(task, result.revision);
      } catch (error) {
        if (error instanceof ClassificationProductError && [400, 403, 404, 409].includes(error.status)) {
          await captureStore.reportFailure(task, error.code); continue;
        }
        return;
      }
    }
    const last = page.at(-1); if (!last || page.length < 50) break; before = [last.createdAt, last.captureId];
  }
}
