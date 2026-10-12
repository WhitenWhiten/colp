import type { NativeSavePage } from './save-entry.js';
import type { BookmarkInsertPosition } from './bookmark-preferences.js';
import type { CaptureTask } from './capture/contracts.js';
import type { BookmarkAnnotationInput } from './bookmark-annotation-store.js';
let command: { key: string; id: string } | undefined;

/** Returned only when the task says this bookmark is saved. Unknown, failed, and cancelled are not success. */
function confirmedPopupNativeId(task: CaptureTask): string | undefined {
  if (task.disposition === 'cancelled' || task.save === 'failed') return undefined;
  if (task.disposition === 'existing') {
    const nativeId = task.existence?.exact.length === 1 ? task.existence.exact[0]?.nativeId : undefined;
    return nativeId || undefined;
  }
  if (task.save !== 'local-saved' || task.disposition !== 'new') return undefined;
  return task.nativeId || undefined;
}

/** The worker owns native I/O and recovery, including when the popup disappears. */
export async function savePopupNativePage(page: NativeSavePage, parentNativeId?: string, collectionId?: string,
  insertPosition?: BookmarkInsertPosition, annotation?: BookmarkAnnotationInput) {
  const checkbox = document.getElementById('capture-save-another') as HTMLInputElement | null;
  const copy = checkbox?.checked === true && checkbox.dataset.url === page.url;
  const key = JSON.stringify([page.url, page.title, parentNativeId, copy, collectionId, insertPosition, annotation]);
  // Keep this id across a pre-call failure and an unknown result. A new id could create a second bookmark.
  if (command?.key !== key) command = { key, id: crypto.randomUUID() };
  let response = await chrome.runtime.sendMessage({ kind: 'known.capture.start', trigger: 'manual-popup', userGesture: true,
    commandId: command.id, url: page.url, title: page.title, ...(parentNativeId ? { parentNativeId } : {}),
    ...(collectionId ? { collectionId } : {}), ...(insertPosition ? { insertPosition } : {}), ...(annotation ? { annotation } : {}), saveAnother: copy, allowUnverifiedCloud: true }) as { ok: boolean; task?: CaptureTask; error?: string };
  if (!response?.ok || !response.task) throw new Error(response?.error ?? 'capture_unavailable');
  const captureId = response.task.captureId;
  for (let count = 0; count < 40; count++) {
    const task = response.task!;
    const nativeId = confirmedPopupNativeId(task);
    if (nativeId) return nativeId;
    if (task.disposition === 'cancelled') throw new Error('capture_cancelled');
    if (task.save === 'failed') throw new Error(task.reason ?? 'capture_failed');
    if (task.disposition === 'existing') throw new Error('capture_existing_locations');
    await new Promise(resolve => setTimeout(resolve, 250));
    response = await chrome.runtime.sendMessage({ kind: 'known.capture.get', captureId }) as typeof response;
    if (!response?.ok || !response.task) throw new Error('capture_result_unknown');
  }
  throw new Error('capture_result_unknown');
}
