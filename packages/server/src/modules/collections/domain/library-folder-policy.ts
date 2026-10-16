import { isBrowserFolderRole } from '../../../generated/browser-folder-roles.js';
export { BROWSER_FOLDER_ROLES as LIBRARY_BROWSER_FOLDER_ROLES, REQUIRED_BROWSER_FOLDER_ROLES as LIBRARY_REQUIRED_FOLDER_ROLES,
  isBrowserFolderRole as isLibraryBrowserFolder } from '../../../generated/browser-folder-roles.js';
export type LibraryFolderOperation = 'create_child' | 'update_content' | 'rename' | 'move' | 'delete';

/** Product and MCP policy. Canonical sync admission intentionally remains independent. */
export function libraryFolderAllows(isLibrary: boolean | undefined, role: string | null | undefined,
  operation: LibraryFolderOperation): boolean {
  return !isLibrary || !isBrowserFolderRole(role) || operation === 'create_child' || operation === 'update_content';
}
