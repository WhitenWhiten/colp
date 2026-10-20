import { folderRoleForBrowserRoot, type NormalizedBookmarkRoot, type SpecialFolderRole } from './chrome-bookmark-tree.js';
import { t } from './i18n.js';

export interface ExistingBrowserMount {
  readonly nativeRootId: string;
  readonly rootRole?: SpecialFolderRole;
  readonly customSourceKey?: string;
}

/**
 * A canonical role has one owner, while Chrome can expose several native roots
 * of that type. Preserve the previous owner even when it is temporarily absent
 * or detached. Storage changes and selection order cannot transfer identity.
 * Additional roots use ordinary, independently bound custom mounts.
 */
export function browserRoleOwners(roots: readonly NormalizedBookmarkRoot[],
  existing: readonly ExistingBrowserMount[]): ReadonlyMap<SpecialFolderRole, string> {
  const owners = new Map<SpecialFolderRole, string>();
  const knownNative = new Set(existing.map(mount => mount.nativeRootId));
  for (const mount of existing) if (mount.rootRole) owners.set(mount.rootRole, mount.nativeRootId);
  const candidates = [...roots].filter(root => !root.managed && !knownNative.has(root.nativeId))
    .sort((left, right) => storageRank(left.syncing) - storageRank(right.syncing)
      || left.nativeId.localeCompare(right.nativeId));
  for (const root of candidates) {
    const role = folderRoleForBrowserRoot(root.rootKind, root.managed);
    if (role === 'custom' || role === 'managed-bookmarks' || owners.has(role)) continue;
    owners.set(role, root.nativeId);
  }
  return owners;
}

function storageRank(syncing: boolean | undefined): number {
  return syncing === true ? 0 : syncing === false ? 1 : 2;
}

/** Disambiguate coexisting storage roots; retain the familiar single-root label. */
export function browserRootDisplayTitle(title: string, syncing: boolean | undefined, ambiguous = true): string {
  if (syncing === undefined || !ambiguous) return title;
  return syncing
    ? t('sync_browserAccountRoot', '$1 (Browser account)', title)
    : t('sync_browserDeviceRoot', '$1 (On this device)', title);
}
