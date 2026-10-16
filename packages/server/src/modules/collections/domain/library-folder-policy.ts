export const LIBRARY_REQUIRED_FOLDER_ROLES = ['bookmarks-bar', 'other-bookmarks'] as const;
export const LIBRARY_BROWSER_FOLDER_ROLES = [...LIBRARY_REQUIRED_FOLDER_ROLES, 'mobile-bookmarks'] as const;
export type LibraryFolderOperation = 'create_child' | 'update_content' | 'rename' | 'move' | 'delete';

export function isLibraryBrowserFolder(role: string | null | undefined): boolean {
  return LIBRARY_BROWSER_FOLDER_ROLES.some(candidate => candidate === role);
}

/** Product and MCP policy. Canonical sync admission intentionally remains independent. */
export function libraryFolderAllows(isLibrary: boolean | undefined, role: string | null | undefined,
  operation: LibraryFolderOperation): boolean {
  return !isLibrary || !isLibraryBrowserFolder(role) || operation === 'create_child' || operation === 'update_content';
}
