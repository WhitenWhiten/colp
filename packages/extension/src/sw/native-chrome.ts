import { classifyBookmarkApiFailure } from '../bookmark-api-error.js';
import { personalBookmarks } from '../bookmark-subscriptions/guards.js';
import type { NativeWriteCheck } from '../native-call-result.js';
export function nativeChromeFacts() {
  return {
    getChildren: (id: string) => chrome.bookmarks.getChildren(id),
    removeNative: async (id: string, tree: boolean, beforeNative?: NativeWriteCheck) =>
      tree ? personalBookmarks.removeTree(id, beforeNative) : personalBookmarks.remove(id, beforeNative),
    moveNative: async (id: string, placement: { parentId: string; index: number }, beforeNative?: NativeWriteCheck) =>
      personalBookmarks.move(id, placement, beforeNative),
    getNative: async (nativeId: string) => {
      try {
        const rows = await chrome.bookmarks.get(nativeId);
        if (!rows.length) throw new Error('bookmark_lookup_empty');
        return rows[0];
      } catch (error) {
        if (classifyBookmarkApiFailure(error) === 'not_found') return undefined;
        throw error;
      }
    },
    updateNative: async (nativeId: string, changes: { title?: string; url?: string }, beforeNative?: NativeWriteCheck) => {
      await personalBookmarks.update(nativeId, changes, beforeNative);
    },
    createNative: (input: { parentId?: string; index?: number; title?: string; url?: string }, beforeNative?: NativeWriteCheck) =>
      personalBookmarks.create(input, beforeNative),
  };
}
