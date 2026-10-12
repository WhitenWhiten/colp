import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { assertPersonalCapture } from '../bookmark-subscriptions/capture-boundary.js';
import { createClassificationProductClient, ClassificationProductError } from '../classification-product-client.js';
import { currentCaptureScope, assertCaptureScope } from './capture-native.js';
import { captureStore } from './capture.js';
let pending: Promise<void> | undefined;

export function flushCaptureFeedback(): Promise<void> {
  if (pending) return pending;
  pending = flush().finally(() => { pending = undefined; }); return pending;
}
async function flush(): Promise<void> {
  if (navigator.onLine === false) return;
  const scope = await currentCaptureScope();
  if (!scope.accountId) return;
  let activeTask:import('../capture/contracts.js').CaptureTask|undefined;
  const client = createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: scope.accountId,
    assertCurrent: () => assertCaptureScope(scope),dispatch:send=>withSubscriptionRead(async()=>{if(!activeTask)throw new Error('capture_unavailable');await assertPersonalCapture(activeTask);return send();}) });
  for (const item of await captureStore.pendingFeedback(scope)) {
    const task = await captureStore.get(item.scope, item.captureId);
    if (!task || !item.scope.collectionId || item.kind === 'correction_applied') continue; // Corrections are authored in the canonical server transaction.
    const event = await captureStore.prepareFeedback(item, task.feedbackServerRevision ?? task.automatic?.decision?.feedbackRevision ?? 0);
    if (event.kind === 'correction_applied') continue;
    activeTask=task;try {await assertPersonalCapture(task);
      const receipt = await client.captureFeedback(item.scope.collectionId, event.decisionId, {
        eventId: event.eventId, kind: event.kind, nodeRevision: event.nodeRevision, occurredAt: new Date(event.occurredAt).toISOString(),
        learningEligible: event.learningEligible, evidenceGeneration: event.evidenceGeneration ?? 0,
      }, event.expectedServerRevision!);
      await assertCaptureScope(scope); await captureStore.settleFeedback(event, { revision: receipt.revision });
    } catch (error) {
      if (error instanceof ClassificationProductError && [400, 404, 409, 412].includes(error.status)) {
        await captureStore.settleFeedback(event, { error: error.status === 412 ? 'feedback_conflict' : 'feedback_needs_attention' });
        continue;
      }
      // Unknown responses retain the exact event and CAS revision; no new signal on a retry.
      return;
    }
  }
}
