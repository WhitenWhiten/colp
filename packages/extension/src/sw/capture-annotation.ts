import { createBookmarkAnnotationStore } from '../bookmark-annotation-store.js';
import type { CaptureTask } from '../capture/contracts.js';
import type { PinResponse } from '../bookmark-pin-messages.js';

/**
 * Keeps the popup's tags and note for a bookmark this capture created. The popup may be long gone, so the worker does it
 * from the stored task. A save that resolved to an existing bookmark never writes: the popup edits those itself. A row that
 * edited after admission is left alone. An empty sync observation does not block the original input.
 */
export async function persistCaptureAnnotation(task: CaptureTask,
  pin: (bookmark: chrome.bookmarks.BookmarkTreeNode) => Promise<PinResponse> = async () => ({ ok: false, error: 'pin_failed' })): Promise<boolean> {
  if (!task.annotation || task.disposition !== 'new' || task.save !== 'local-saved') return true;
  if (!task.nativeId) return false;
  const store = createBookmarkAnnotationStore();
  try {
    const [bookmark] = await chrome.bookmarks.get(task.nativeId);
    if (!bookmark || bookmark.url === undefined) return false;
    await store.save(bookmark, task.annotation, { preserveTags: true, captureCreatedAt: task.createdAt });
    // A folder that cannot take pins keeps the save unpinned; only a failure to record the pin retries.
    if (!task.annotation.pinned) return true;
    const pinned = await pin(bookmark);
    return pinned.ok || pinned.error === 'not_available';
  } catch { return false; }
  finally { store.close(); }
}
