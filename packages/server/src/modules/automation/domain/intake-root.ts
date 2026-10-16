import { isBrowserFolderRole } from '../../../generated/browser-folder-roles.js';

export function isIntakeRootFolder(folder: { isRoot: boolean; folderRole: string | null } | undefined): boolean {
  return !!folder && (folder.isRoot || isBrowserFolderRole(folder.folderRole));
}

/**
 * Only call with a snapshot captured by canonical locked planning. Being under an
 * intake root describes location, not consent to make another automated move.
 */
export function isIntakeRootSnapshot(
  snapshot: { parentId: string | null; parentIsIntakeRoot?: boolean } | null | undefined,
  rootNodeId: string,
): boolean {
  return !!snapshot && (snapshot.parentId === rootNodeId || snapshot.parentIsIntakeRoot === true);
}
