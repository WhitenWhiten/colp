import {
  folderIsInMount, readDefaultFolder, resolveSaveFolder, walkAncestorIds,
} from './save-folder.js';

export type SaveTargetSource = 'default' | 'save_context';

export interface ResolvedSaveTarget {
  readonly parentNativeId: string;
  readonly source: SaveTargetSource;
  readonly inRange: boolean;
}

/**
 * Default destination for popup/native saves: the last in-range folder, else
 * the save-context mount root. Out-of-range one-off picks are popup-only.
 */
export async function resolveInRangeSaveParent(input: {
  readonly collectionId?: string;
  readonly saveContextParentId?: string;
  readonly mountNativeIds: readonly string[];
  readonly getParent: (id: string) => Promise<string | undefined>;
  readonly folderExists: (id: string) => Promise<boolean>;
}): Promise<ResolvedSaveTarget | undefined> {
  const mounts = new Set(input.mountNativeIds);
  const fallback = await readDefaultFolder();
  const fallbackExists = fallback ? await input.folderExists(fallback.folderNativeId) : false;
  if (mounts.size === 0) {
    if (fallbackExists && fallback) {
      return { parentNativeId: fallback.folderNativeId, source: 'default', inRange: true };
    }
    return pickLive(input.saveContextParentId, 'save_context', mounts, input);
  }
  const fallbackAncestors = fallbackExists && fallback
    ? await walkAncestorIds(fallback.folderNativeId, input.getParent) : [];
  const resolved = input.collectionId
    ? resolveSaveFolder({
      ...(fallbackExists && fallback ? { fallback } : {}),
      ...(input.saveContextParentId ? { saveContextId: input.saveContextParentId } : {}),
      collectionId: input.collectionId, mountNativeIds: mounts, fallbackAncestors,
    })
    : undefined;
  const candidate = resolved?.folderNativeId ?? input.saveContextParentId;
  if (!candidate || !await input.folderExists(candidate)) {
    return pickLive(input.saveContextParentId, 'save_context', mounts, input);
  }
  const inRange = await isLiveInRange(candidate, mounts, input);
  if (inRange || mounts.size === 0) {
    const source: SaveTargetSource = fallbackExists && fallback?.folderNativeId === candidate
      ? 'default' : 'save_context';
    return { parentNativeId: candidate, source, inRange: inRange || mounts.size === 0 };
  }
  return pickLive(input.saveContextParentId, 'save_context', mounts, input);
}

async function pickLive(
  nativeId: string | undefined, source: SaveTargetSource, mounts: ReadonlySet<string>,
  input: { readonly getParent: (id: string) => Promise<string | undefined>;
    readonly folderExists: (id: string) => Promise<boolean> },
): Promise<ResolvedSaveTarget | undefined> {
  if (!nativeId || !await input.folderExists(nativeId)) return undefined;
  const inRange = await isLiveInRange(nativeId, mounts, input);
  if (mounts.size > 0 && !inRange) return undefined;
  return { parentNativeId: nativeId, source, inRange: inRange || mounts.size === 0 };
}

async function isLiveInRange(
  nativeId: string, mounts: ReadonlySet<string>,
  input: { readonly getParent: (id: string) => Promise<string | undefined> },
): Promise<boolean> {
  if (mounts.size === 0) return false;
  const ancestors = await walkAncestorIds(nativeId, input.getParent);
  return folderIsInMount(nativeId, ancestors, mounts);
}
