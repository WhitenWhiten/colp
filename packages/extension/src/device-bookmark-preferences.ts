import { DEFAULT_BOOKMARK_PREFERENCES, type BookmarkPreferences } from './bookmark-preferences.js';

/** These affect this browser's native operations; account defaults never replace them implicitly. */
export const DEVICE_BOOKMARK_PREFERENCE_KEYS = [
  'bookmarkInsertPosition', 'foldersFirst', 'captureMode', 'resultPanelAutoDismissMs',
  'learnFromCorrections', 'resumeClassificationWhenOnline', 'aiTagMode',
] as const satisfies readonly (keyof BookmarkPreferences)[];

export function devicePreferencePatch(preferences: Partial<BookmarkPreferences>): Partial<BookmarkPreferences> {
  return Object.fromEntries(DEVICE_BOOKMARK_PREFERENCE_KEYS.filter(key => preferences[key] !== undefined)
    .map(key => [key, preferences[key]]));
}

export function effectiveDevicePreferences(account: BookmarkPreferences, device: BookmarkPreferences): BookmarkPreferences {
  return { ...account, ...devicePreferencePatch({ ...DEFAULT_BOOKMARK_PREFERENCES, ...device }) };
}

export function accountDefaultsDiffer(account: BookmarkPreferences, device: BookmarkPreferences): boolean {
  return DEVICE_BOOKMARK_PREFERENCE_KEYS.some(key => account[key] !== device[key]);
}
