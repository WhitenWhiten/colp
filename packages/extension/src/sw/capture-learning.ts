import { currentCaptureScope, assertCaptureOwner } from './capture-native.js';
import { captureControlKey, updateCaptureControl } from '../capture/control.js';
import { createClassificationProductClient } from '../classification-product-client.js';
type Request = { kind: 'known.capture.learning' } | { kind: 'known.capture.learning.clear'; generation: number };
export function validCaptureLearning(value: unknown): value is Request {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.kind === 'known.capture.learning' && Object.keys(raw).length === 1
    || raw.kind === 'known.capture.learning.clear' && Object.keys(raw).length === 2
      && Number.isSafeInteger(raw.generation) && Number(raw.generation) >= 0;
}
const active = new Map<string, Promise<unknown>>();
export async function handleCaptureLearning(request: Request) {
  const scope = await currentCaptureScope();
  if (!scope.accountId) throw new Error('sign_in_required');
  const key = `${captureControlKey(scope)}.clear`, client = createClassificationProductClient({ serverOrigin: scope.serverOrigin,
    expectedAuthUserId: scope.accountId, assertCurrent: () => assertCaptureOwner(scope) });
  const run = async () => {
    if (request.kind === 'known.capture.learning.clear') {
      const saved = (await chrome.storage.local.get(key))[key] as { commandId: string; generation: number } | undefined;
      const intent = saved ?? { commandId: crypto.randomUUID(), generation: request.generation };
      await chrome.storage.local.set({ [key]: intent });
      try {
        const result = await client.clearCaptureLearning(intent.commandId, intent.generation);
        await assertCaptureOwner(scope);
        await updateCaptureControl(scope, prior => ({ ...prior, evidenceGeneration: result.generation }));
        await chrome.storage.local.remove(key);
      } catch (error) {
        // A verified CAS rejection never committed; unknown outcomes keep the exact intent for replay.
        if (error instanceof Error && 'status' in error && error.status === 412) await chrome.storage.local.remove(key);
        throw error;
      }
    }
    const view = await client.captureLearning(); await assertCaptureOwner(scope);
    await updateCaptureControl(scope, prior => ({ ...prior, evidenceGeneration: view.generation }));
    return { ok: true, view, pendingClear: Boolean((await chrome.storage.local.get(key))[key]) };
  };
  const previous = active.get(key) ?? Promise.resolve(), result = previous.then(run, run);
  active.set(key, result);
  try { return await result; } finally { if (active.get(key) === result) active.delete(key); }
}
