import {
  DEFAULT_BOOKMARK_PREFERENCES, type BookmarkPreferences,
} from './bookmark-preferences.js';
import type { BookmarkPreferencesResponse } from './types.js';

/** Reads only local preference state; native saves never wait on Product HTTP. */
export async function readEffectiveBookmarkPreferences(): Promise<BookmarkPreferences> {
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' }) as
      BookmarkPreferencesResponse | undefined;
    return response?.ok ? response.preferences : DEFAULT_BOOKMARK_PREFERENCES;
  } catch {
    return DEFAULT_BOOKMARK_PREFERENCES;
  }
}
