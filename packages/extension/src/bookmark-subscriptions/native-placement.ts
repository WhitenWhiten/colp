/** Projection positions are final indices; Chromium move indices identify an
 * insertion slot before the source is removed from its current parent. */
export function moveDestination(
  current: Pick<chrome.bookmarks.BookmarkTreeNode, 'parentId' | 'index'>,
  parentId: string,
  finalIndex: number,
): { parentId: string; index: number } {
  if (!Number.isInteger(finalIndex) || finalIndex < 0) throw new Error('native_position_invalid');
  const sameParent = current.parentId === parentId;
  if (sameParent && current.index === undefined) throw new Error('native_identity_uncertain');
  return { parentId, index: finalIndex + (sameParent && current.index! < finalIndex ? 1 : 0) };
}
