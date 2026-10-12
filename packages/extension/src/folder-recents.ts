/**
 * The folders this browser saved into last, newest first — the popup's
 * "Recent" shortcuts. Whether a folder syncs never decides whether it is
 * remembered. The explicit default (known.sync.folder.v1) is a separate
 * setting and always takes precedence when opening the popup.
 */
export const FOLDER_RECENTS = 'known.save.folder.recent.v1';
export const FOLDER_RECENTS_LIMIT = 5;

export function parseFolderRecents(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const ids = (value as Record<string, unknown>).ids;
  if (!Array.isArray(ids)) return [];
  const valid = ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128);
  return [...new Set(valid)].slice(0, FOLDER_RECENTS_LIMIT);
}

export async function readFolderRecents(): Promise<string[]> {
  try {
    return parseFolderRecents((await chrome.storage.local.get(FOLDER_RECENTS))[FOLDER_RECENTS]);
  } catch { return []; /* No memory yet reads the same as an empty one. */ }
}

export async function pushFolderRecent(folderNativeId: string): Promise<void> {
  const ids = [folderNativeId, ...(await readFolderRecents()).filter((id) => id !== folderNativeId)]
    .slice(0, FOLDER_RECENTS_LIMIT);
  try { await chrome.storage.local.set({ [FOLDER_RECENTS]: { ids } }); } catch { /* best-effort: the next save records again */ }
}
