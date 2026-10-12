import { readEffectiveBookmarkPreferences } from './bookmark-preferences-read.js';
import { savePagesThroughNativeIngress } from './save-entry.js';
import { createFaviconSidecarStore } from './favicon-sidecar-store.js';
import { createFolderDescriptionStore, validateFolderDescription } from './folder-description-store.js';
import { notifyFolderDescriptionChanged } from './folder-description-native.js';

export async function createManagerNode(api: Parameters<typeof savePagesThroughNativeIngress>[0]['bookmarks'],
  parentId: string, title: string, url?: string, description?: string): Promise<void> {
  if (!url) {
    validateFolderDescription(description?.trim() || null);
    const created = await api.create({ parentId, title });
    if (description?.trim()) {
      const store = createFolderDescriptionStore();
      try { await store.save(created, description.trim()); } finally { store.close(); }
      void notifyFolderDescriptionChanged(created.id);
    }
    return;
  }
  const preferences = await readEffectiveBookmarkPreferences();
  // The worker resolves the authenticated scope. A stale collection cache in
  // this page must never attach a new intent to a previous account.
  let collectionId: string | undefined;
  try {
    const context = await chrome.runtime.sendMessage({ kind: 'known.favicon.save-context-local' }) as
      { readonly ok?: boolean; readonly collectionId?: string } | undefined;
    if (context?.ok && typeof context.collectionId === 'string' && context.collectionId) {
      collectionId = context.collectionId;
    }
  } catch { /* Unconnected manager saves still work locally. */ }
  let sidecar: ReturnType<typeof createFaviconSidecarStore>;
  try { sidecar = createFaviconSidecarStore(); }
  catch { sidecar = { close() {}, put: async () => undefined } as never; }
  try {
    await savePagesThroughNativeIngress({
      pages: [{ title, url }], parentNativeId: parentId,
      insertPosition: preferences.bookmarkInsertPosition, foldersFirst: preferences.foldersFirst, collectionId, bookmarks: api, sidecar,
    });
  } finally { sidecar.close(); }
}
