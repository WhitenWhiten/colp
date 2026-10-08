import type { OrganizePlannerInput } from './organize-planner.js';
import { isInboxFolderTitle } from './organize-planner-tokens.js';

export type OrganizeInboxSelectionInput = Pick<
  OrganizePlannerInput,
  'rootId' | 'folders' | 'bookmarks'
>;

export function selectOrganizeSource(
  input: OrganizeInboxSelectionInput,
): OrganizePlannerInput {
  const inboxFolderIds = input.folders
    .filter(
      (folder) =>
        folder.parentId === input.rootId && isInboxFolderTitle(folder.title),
    )
    .map((folder) => folder.id);
  const inboxFolderIdSet = new Set(inboxFolderIds);
  const bookmarks = input.bookmarks.filter((bookmark) =>
    inboxFolderIdSet.has(bookmark.parentId),
  );

  return {
    rootId: input.rootId,
    folders: input.folders,
    bookmarks,
    inboxFolderIds,
  };
}
