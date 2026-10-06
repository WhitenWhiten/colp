/**
 * Frozen Sync create folderRole allow-list.
 * Backend uniqueness is implemented; this module is the shared spelling.
 */

export const SYNC_CREATE_FOLDER_ROLE_ALLOW_LIST = Object.freeze([
  'bookmarks-bar',
  'other-bookmarks',
  'mobile-bookmarks',
  'custom',
  'recovered',
] as const);

export const SYNC_CREATE_FOLDER_ROLE_CAPABILITY_GATED = Object.freeze([
  'managed-bookmarks',
] as const);

export const SYNC_CREATE_FOLDER_ROLE_FORBIDDEN = Object.freeze([
  'root',
  'archive',
  'inbox',
] as const);

export const SYNC_CREATE_FOLDER_ROLE_UNIQUE_LIVE = Object.freeze([
  'bookmarks-bar',
  'other-bookmarks',
  'mobile-bookmarks',
] as const);

/** `recovered` is unique per live parent (owning mount or Collection-root fallback), not Collection-wide. */
export const SYNC_RECOVERED_UNIQUE_BY_PARENT = true as const;

export type SyncCreateFolderRoleAllowList = (typeof SYNC_CREATE_FOLDER_ROLE_ALLOW_LIST)[number];
