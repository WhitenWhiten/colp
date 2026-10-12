import { personalBookmarks } from '../bookmark-subscriptions/guards.js';
export function nativeChromeFacts() {
  return {
    getChildren: (id: string) => chrome.bookmarks.getChildren(id),
    removeNative: async (id: string, tree: boolean) => tree ? personalBookmarks.removeTree(id) : personalBookmarks.remove(id),
    moveNative: async (id: string, placement: { parentId: string; index: number }) => personalBookmarks.move(id, placement),
    getNative: async (nativeId: string) => (await chrome.bookmarks.get(nativeId).catch(() => []))[0],
    updateNative: async (nativeId: string, changes: { title?: string; url?: string }) => {
      await personalBookmarks.update(nativeId, changes);
    },
    createNative: (input: { parentId?: string; index?: number; title?: string; url?: string }) =>
      personalBookmarks.create(input),
  };
}
