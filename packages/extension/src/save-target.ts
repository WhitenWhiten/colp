import {
  folderIsInMount, readDefaultFolder, walkAncestorIds,
} from './save-folder.js';

export type SaveTargetSource = 'default';

export interface ResolvedSaveTarget {
  readonly parentNativeId: string;
  readonly source: SaveTargetSource;
  readonly inRange: boolean;
}

/** Native shortcuts use only a folder explicitly configured by the user. */
export async function resolveInRangeSaveParent(input: {
  readonly collectionId?: string;
  readonly mountNativeIds: readonly string[];
  readonly getParent: (id: string) => Promise<string | undefined>;
  readonly folderExists: (id: string) => Promise<boolean>;
}): Promise<ResolvedSaveTarget | undefined> {
  const chosen = await readDefaultFolder();
  if (!chosen || !await input.folderExists(chosen.folderNativeId)) return undefined;
  const ancestors = await walkAncestorIds(chosen.folderNativeId, input.getParent);
  const inRange = folderIsInMount(chosen.folderNativeId, ancestors, new Set(input.mountNativeIds));
  return { parentNativeId: chosen.folderNativeId, source: 'default', inRange };
}
