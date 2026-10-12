export const BOOKMARK_ANNOTATION_NOTICE = 'known.bookmarkAnnotation.changed';
export function validBookmarkAnnotationNotice(value: unknown): value is { kind: typeof BOOKMARK_ANNOTATION_NOTICE; nativeId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.kind === BOOKMARK_ANNOTATION_NOTICE && typeof row.nativeId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/u.test(row.nativeId) && Object.keys(row).length === 2;
}
let workerListener: ((nativeId: string) => void) | undefined;
/** A runtime message never reaches its own sender, so the worker hears its own edits (pins, restores) here. */
export function listenToWorkerAnnotationChanges(listener: (nativeId: string) => void): void { workerListener = listener; }
export async function notifyBookmarkAnnotationChanged(nativeId: string): Promise<void> {
  workerListener?.(nativeId);
  try { if (typeof chrome !== 'undefined') await chrome.runtime.sendMessage({ kind: BOOKMARK_ANNOTATION_NOTICE, nativeId }); }
  catch { /* The next ordinary sync wake finds the persisted dirty value. */ }
}
