/**
 * Know-N bookmark pin. A pinned bookmark carries exactly `{ "pinned": true }`
 * under this namespace; absence means unpinned. Keeping the value two-state
 * means the sync three-way merge can never report a field conflict for it.
 * Browsers keep pinned bookmarks between the folders and the other bookmarks;
 * the server stores the flag and leaves ordering to Position.
 */
export const BOOKMARK_PIN_EXTENSION = 'https://known.example/extensions/bookmark-pin-v1';

export function isBookmarkPinned(extensions: unknown): boolean {
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return false;
  const value = (extensions as Record<string, unknown>)[BOOKMARK_PIN_EXTENSION];
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).pinned === true;
}

/** Only bookmarks can be pinned, and only with the exact canonical value. */
export function validBookmarkPinExtension(kind: string, extensions: Readonly<Record<string, unknown>>): boolean {
  if (!Object.hasOwn(extensions, BOOKMARK_PIN_EXTENSION)) return true;
  const value = extensions[BOOKMARK_PIN_EXTENSION];
  return kind === 'bookmark' && isBookmarkPinned(extensions)
    && Object.keys(value as Record<string, unknown>).length === 1;
}
