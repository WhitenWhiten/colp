import { classifyBookmarkApiFailure } from '../bookmark-api-error.js';
import { personalBookmarks } from '../bookmark-subscriptions/guards.js';
export function nativeChromeFacts() {
  return {
    getChildren: (id: string) => chrome.bookmarks.getChildren(id),
    removeNative: async (id: string, tree: boolean) => tree ? personalBookmarks.removeTree(id) : personalBookmarks.remove(id),
    moveNative: async (id: string, placement: { parentId: string; index: number }) => personalBookmarks.move(id, placement),
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
    updateNative: async (nativeId: string, changes: { title?: string; url?: string }) => {
      await personalBookmarks.update(nativeId, changes);
    },
    createNative: (input: { parentId?: string; index?: number; title?: string; url?: string }) =>
      personalBookmarks.create(input),
  };
}
