import { folderIsInMount, walkAncestorIds } from './save-folder.js';

export type FolderSyncTarget =
  | { readonly kind: 'synced'; readonly collectionId: string }
  | { readonly kind: 'local' }
  | { readonly kind: 'unknown' };

/**
 * The collection a save into `folderId` reaches, derived from the folder —
 * never chosen. It mirrors the worker's ingress rule (a bookmark created
 * under a live mount of the bound library syncs into it) for display only;
 * the ingress stays the authority. With no live mounts yet (signed out, first
 * run incomplete, mounts pending) the answer is unknown, never "local".
 */
export async function resolveFolderSyncTarget(input: {
  readonly folderId: string;
  readonly mounts: ReadonlySet<string>;
  readonly boundCollectionId?: string;
  readonly getParent: (id: string) => Promise<string | undefined>;
}): Promise<FolderSyncTarget> {
  if (!input.folderId || !input.boundCollectionId || input.mounts.size === 0) return { kind: 'unknown' };
  const ancestors = await walkAncestorIds(input.folderId, input.getParent);
  return folderIsInMount(input.folderId, ancestors, input.mounts)
    ? { kind: 'synced', collectionId: input.boundCollectionId }
    : { kind: 'local' };
}
