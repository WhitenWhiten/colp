/** KNS-00 / KNS-06 Sync create folderRole allow-list (COLP folder-role-contract).
 * Special roots stay Collection-unique. `recovered` is unique per live parent. */
export const SYNC_CREATE_FOLDER_ROLE_ALLOW_LIST = Object.freeze([
  'bookmarks-bar',
  'other-bookmarks',
  'mobile-bookmarks',
  'custom',
  'recovered',
] as const);

export const SYNC_CREATE_FOLDER_ROLE_UNIQUE_LIVE = Object.freeze([
  'bookmarks-bar',
  'other-bookmarks',
  'mobile-bookmarks',
] as const);

/** Live parents that may own a `recovered` Folder: special or custom mounts. Collection root is also allowed. */
export const SYNC_RECOVERED_PARENT_ROLES = Object.freeze([
  'bookmarks-bar',
  'other-bookmarks',
  'mobile-bookmarks',
  'custom',
] as const);

export const SYNC_RECOVERED_UNIQUE_BY_PARENT = true as const;

export type SyncCreateFolderRoleAllowList = (typeof SYNC_CREATE_FOLDER_ROLE_ALLOW_LIST)[number];
export type SyncCreateFolderRoleUniqueLive = (typeof SYNC_CREATE_FOLDER_ROLE_UNIQUE_LIVE)[number];
export type SyncRecoveredParentRole = (typeof SYNC_RECOVERED_PARENT_ROLES)[number];

export function isSyncCreateFolderRoleAllowList(value: string): value is SyncCreateFolderRoleAllowList {
  return (SYNC_CREATE_FOLDER_ROLE_ALLOW_LIST as readonly string[]).includes(value);
}

export function isSyncCreateFolderRoleUniqueLive(value: string): value is SyncCreateFolderRoleUniqueLive {
  return (SYNC_CREATE_FOLDER_ROLE_UNIQUE_LIVE as readonly string[]).includes(value);
}

export function isAllowedRecoveredParent(input: {
  readonly isRoot: boolean;
  readonly nodeKind: string;
  readonly folderRole: string | null;
}): boolean {
  if (input.isRoot) return true;
  return input.nodeKind === 'folder'
    && (SYNC_RECOVERED_PARENT_ROLES as readonly string[]).includes(input.folderRole ?? '');
}
