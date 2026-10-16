// Generated from packages/node/src/sync/browser-folder-roles.ts; do not edit.
/** Browser roles supported by sync, distinct from the two roots created for a new library. */
export const REQUIRED_BROWSER_FOLDER_ROLES = ['bookmarks-bar', 'other-bookmarks'] as const;
export const BROWSER_FOLDER_ROLES = [...REQUIRED_BROWSER_FOLDER_ROLES, 'mobile-bookmarks'] as const;
export type BrowserFolderRole = (typeof BROWSER_FOLDER_ROLES)[number];

export function isBrowserFolderRole(role: string | null | undefined): role is BrowserFolderRole {
  return BROWSER_FOLDER_ROLES.some(candidate => candidate === role);
}
