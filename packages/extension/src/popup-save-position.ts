import type { BookmarkInsertPosition } from './bookmark-preferences.js';
import type { BookmarkPreferencesResponse } from './types.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences-read.js';

/**
 * The popup no longer carries a Top/Bottom control — the default lives in
 * Options → Saving. This binding only resolves the effective storage value
 * for the save path; `restore` still accepts a draft value so a popup that
 * closed mid-edit does not lose a remembered choice.
 */
export function bindPopupSavePosition() {
  let value: BookmarkInsertPosition = 'bottom';
  let touched = false;
  let requestVersion = 0;
  let localRead: Promise<void> | undefined;

  function set(next: BookmarkInsertPosition, userTouched: boolean): void {
    value = next;
    if (userTouched) touched = true;
  }

  async function refresh(): Promise<void> {
    const version = ++requestVersion;
    localRead = readEffectiveBookmarkPreferences().then(preferences => {
      if (version === requestVersion && !touched) set(preferences.bookmarkInsertPosition, false);
    });
    await localRead;
    if (version !== requestVersion) return;
    try {
      const response = await chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.get' }) as
        BookmarkPreferencesResponse | undefined;
      if (version !== requestVersion || touched || !response?.ok) return;
      set(response.preferences.bookmarkInsertPosition, false);
    } catch { /* The built-in bottom default remains locally usable. */ }
  }

  return Object.freeze({
    current: () => value,
    forSave: async () => {
      if (touched) return value;
      // Saving waits only for local initialization, never for the background GET.
      if (!localRead) void refresh();
      let pending: Promise<void> | undefined;
      do { pending = localRead; await pending; } while (pending !== localRead && !touched);
      return value;
    },
    draft: () => touched ? value : undefined,
    restore: (next: BookmarkInsertPosition | undefined) => { if (next) set(next, true); },
    refresh,
  });
}
