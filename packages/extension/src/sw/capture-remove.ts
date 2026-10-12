import type { CaptureTask } from '../capture/contracts.js';
import { transitionCapture } from '../capture/state.js';
import type { CaptureStore } from '../capture/store.js';
import { assertCaptureOwner, type currentCaptureScope } from './capture-native.js';
import { workCoordinator } from './runtime.js';

/**
 * The popup's Undo already removed the saved bookmark. This only ends the
 * capture as `cancelled`, the existing terminal disposition, so History stops
 * listing it as saved. A bookmark that still exists is refused, and repeating
 * the request is harmless.
 */
export async function cancelRemovedCapture(task: CaptureTask, ledger: CaptureStore, scope: Awaited<ReturnType<typeof currentCaptureScope>>): Promise<CaptureTask> {
  return workCoordinator.run('local-bookmark', async () => {
    const current = await ledger.getForOwner(scope, task.captureId) ?? task;
    if (current.disposition === 'cancelled') return current;
    if (current.disposition !== 'new' || current.save !== 'local-saved' || !current.nativeId) throw new Error('capture_remove_unavailable');
    if (await chrome.bookmarks.get(current.nativeId).then(nodes => nodes.length > 0, () => false)) throw new Error('capture_bookmark_still_present');
    const next = transitionCapture(current, { kind: 'cancelled' }, Date.now());
    await assertCaptureOwner(scope);
    await ledger.update(next, current.revision);
    return next;
  });
}
