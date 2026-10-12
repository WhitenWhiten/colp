import type { BookmarkInsertPosition } from './bookmark-preferences.js';

export const POPUP_DRAFT_CACHE = 'known.popup.draft.v1';

/**
 * Unsaved popup edits for one page. The popup window closes on any focus
 * loss, so edits are staged in chrome.storage.session as the user types:
 * reopening the popup on the same tab restores them, and a browser restart
 * clears them (session storage is per browser process by design).
 */
export interface PopupDraft {
  /** The tab URL the draft belongs to; a draft never leaks across pages. */
  readonly url: string;
  readonly title: string;
  readonly editedUrl: string;
  readonly newFolderName: string;
  readonly insertPosition?: BookmarkInsertPosition;
  /** Tags and note typed so far (including a tag still in the text box). */
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly updatedAt: number;
}

export function parsePopupDraft(value: unknown, forUrl?: string): PopupDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== 'string' || record.url.length === 0) return undefined;
  if (typeof record.title !== 'string' || typeof record.editedUrl !== 'string') return undefined;
  if (typeof record.newFolderName !== 'string') return undefined;
  if (record.insertPosition !== undefined && record.insertPosition !== 'top' && record.insertPosition !== 'bottom') return undefined;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return undefined;
  if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.length > 64
    || record.tags.some((tag) => typeof tag !== 'string' || tag.length > 256))) return undefined;
  if (record.note !== undefined && (typeof record.note !== 'string' || record.note.length > 32_768)) return undefined;
  if (forUrl !== undefined && record.url !== forUrl) return undefined;
  return {
    url: record.url, title: record.title, editedUrl: record.editedUrl,
    newFolderName: record.newFolderName, updatedAt: record.updatedAt,
    ...(record.insertPosition === undefined ? {} : { insertPosition: record.insertPosition }),
    ...(record.tags === undefined ? {} : { tags: record.tags as string[] }),
    ...(record.note === undefined ? {} : { note: record.note }),
  };
}

export async function readPopupDraft(forUrl?: string): Promise<PopupDraft | undefined> {
  try {
    const stored = await chrome.storage.session.get(POPUP_DRAFT_CACHE);
    return parsePopupDraft(stored[POPUP_DRAFT_CACHE], forUrl);
  } catch {
    return undefined;
  }
}

export async function writePopupDraft(draft: Omit<PopupDraft, 'updatedAt'>): Promise<void> {
  try {
    await chrome.storage.session.set({ [POPUP_DRAFT_CACHE]: { ...draft, updatedAt: Date.now() } });
  } catch { /* Draft persistence is best-effort; typing must never fail. */ }
}

export async function clearPopupDraft(): Promise<void> {
  try {
    await chrome.storage.session.remove(POPUP_DRAFT_CACHE);
  } catch { /* Nothing to recover: the draft simply stays until session end. */ }
}
