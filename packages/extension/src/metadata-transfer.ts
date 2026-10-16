import { annotatedBookmarksFromTree, readNativeBookmarkAnnotations } from './bookmark-annotation-native.js';
import { createBookmarkAnnotationStore } from './bookmark-annotation-store.js';
import { readNativeFolderDescriptions, descriptionFoldersFromTree } from './folder-description-native.js';
import { createFolderDescriptionStore } from './folder-description-store.js';
import { exclusionIds } from './bookmark-subscriptions/guards.js';
import { supportedBookmarkTree } from './bookmark-folder-policy.js';
import type { FolderTreeNode } from './save-folder.js';
import { createDialog, dialogButton } from './dialog.js';
import { el } from './library-dom.js';
import { t } from './i18n.js';

async function personalTree(): Promise<FolderTreeNode[]> {
  if (typeof chrome.bookmarks?.getTree !== 'function') return [];
  const excluded = await exclusionIds();
  const filter = (nodes: readonly FolderTreeNode[]): FolderTreeNode[] => nodes.filter(node => !node.unmodifiable && !excluded.has(node.id))
    .map(node => ({ ...node, children: filter(node.children ?? []) }));
  return filter(supportedBookmarkTree(await chrome.bookmarks.getTree()));
}

export async function metadataCounts() {
  const tree = await personalTree();
  if (!tree.length) return { tags: 0, notes: 0, descriptions: 0 };
  const [annotations, descriptions] = await Promise.all([readNativeBookmarkAnnotations(tree), readNativeFolderDescriptions(tree)]);
  return { tags: [...annotations.values()].reduce((count, row) => count + row.tags.length, 0),
    notes: [...annotations.values()].filter(row => row.note !== null).length,
    descriptions: [...descriptions.values()].filter(value => value !== null).length };
}
export function metadataCountsCopy(counts: Awaited<ReturnType<typeof metadataCounts>>) {
  return t('metadata_transferCounts', 'This browser: $1 tag assignments, $2 notes, $3 folder descriptions.', counts.tags, counts.notes, counts.descriptions);
}

/** Explicit copying drops old authority, never values; the first-bind merge handles the destination. */
export async function releaseMetadataBindings() {
  const tree = await personalTree(), annotations = createBookmarkAnnotationStore(), descriptions = createFolderDescriptionStore();
  try {
    await annotations.releaseBindings(annotatedBookmarksFromTree(tree));
    await descriptions.releaseBindings([...descriptionFoldersFromTree(tree).values()]);
  } finally { annotations.close(); descriptions.close(); }
}

export async function confirmMetadataTransfer(): Promise<boolean | undefined> {
  const counts = await metadataCounts();
  // Consent also governs values created later, so an empty browser is not a reason
  // to skip this choice. Cancellation remains distinct from explicitly staying local.
  // With nothing to copy yet, the same choice is about the tags, notes and descriptions added from now on.
  const empty = counts.tags + counts.notes + counts.descriptions === 0;
  const { dialog, body, actions } = createDialog(t('metadata_transferTitle', 'Connect browser metadata'));
  body.append(...empty
    ? [el('p', t('metadata_libraryEmptyHint', 'Tags, notes and folder descriptions you add in this browser can sync with your bookmark library, or stay on this browser only. You can change this later in Sync.'))]
    : [el('p', metadataCountsCopy(counts)), el('p', t('metadata_libraryCopyHint', 'Copy these values into your bookmark library when their folders are synced. Tags will merge; differing notes and descriptions will need review. Keeping them local preserves their current bindings.'))]);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const keep = dialogButton(t('metadata_keepLocal', 'Keep metadata local'), 'secondary');
  const copy = dialogButton(empty ? t('metadata_syncWithLibrary', 'Sync with library') : t('metadata_copyToLibrary', 'Copy metadata to library'), 'primary');
  actions.append(cancel, keep, copy); document.body.append(dialog); dialog.showModal();
  return new Promise(resolve => {
    let choice: boolean | undefined;
    cancel.onclick = () => dialog.close(); keep.onclick = () => { choice = false; dialog.close(); }; copy.onclick = () => { choice = true; dialog.close(); };
    dialog.addEventListener('close', () => { dialog.remove(); resolve(choice); }, { once: true });
  });
}
