import { captureStore } from './capture.js';
import { currentCaptureScope, assertCaptureOwner } from './capture-native.js';
import { currentSyncScope } from './scope.js';
import { syncState } from './runtime.js';
import { createClassificationProductClient } from '../classification-product-client.js';
export function validCaptureLinks(value: unknown): value is { kind: 'known.capture.links'; captureId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.kind === 'known.capture.links' && Object.keys(raw).length === 2 && typeof raw.captureId === 'string' && /^[0-9a-f-]{36}$/u.test(raw.captureId);
}
export async function captureLinks(captureId: string) {
  const scope = await currentCaptureScope(), task = await captureStore.getForOwner(scope, captureId);
  if (!task) throw new Error('capture_not_found');
  let item: string | null = null, chargeId: string | null = null, nodeId = task.nodeId;
  const bound = scope.collectionId === task.scope.collectionId && task.scope.collectionId !== null;
  if (bound) {
    const sync = await currentSyncScope().catch(() => null);
    if (sync) {
      const mapping = task.nativeId ? await syncState.getMappingByNativeId(sync, task.nativeId) : null;
      nodeId ??= mapping?.colpId ?? null;
      const deletes = await syncState.listRemoteDeleteDecisions(sync, ['pending', 'applying', 'restoring']);
      const deletion = deletes.find(value => value.targetId === nodeId || task.nativeId && value.nativeIds.includes(task.nativeId));
      if (deletion) item = deletion.decisionId;
      else if (nodeId) item = (await syncState.listApplyIntents(sync)).find(value => value.colpId === nodeId && ['native_result_unknown', 'waiting_dependency'].includes(value.waitReason ?? ''))?.intentId ?? null;
    }
  }
  if (scope.accountId && task.scope.collectionId && task.automatic && navigator.onLine !== false) {
    try {
      const decision = await createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: scope.accountId,
        assertCurrent: () => assertCaptureOwner(scope) }).findCaptureDecision(task.scope.collectionId, task.captureId);
      chargeId = decision?.creditChargeId ?? null;
    } catch { /* No charge is guessed while the authoritative receipt is unavailable. */ }
  }
  await assertCaptureOwner(scope);
  return { ok: true, item, nodeId, chargeId, bound };
}
