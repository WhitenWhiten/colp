import { pushFolderRecent } from './folder-recents.js';

/** Explicit browser default; ordinary saves must never change this setting. */
export const FOLDER_DEFAULT_BINDING = 'known.sync.folder.v1';
export const FOLDER_ONCE_BINDING = 'known.sync.folder.once.v1';
/** The remembered folder belongs to this browser; one-shot destinations retain their collection scope. */
export const DEVICE_FOLDER_SCOPE = 'device';

export interface FolderBinding {
  readonly collectionId: string;
  readonly folderNativeId: string;
}

export interface FolderTreeNode {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly parentId?: string;
  readonly unmodifiable?: string;
  readonly folderType?: string;
  readonly dateAdded?: number;
  readonly children?: readonly FolderTreeNode[];
}

export function parseFolderBinding(value: unknown, collectionId?: string): FolderBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.collectionId !== 'string' || record.collectionId.length === 0) return undefined;
  if (typeof record.folderNativeId !== 'string' || record.folderNativeId.length === 0) return undefined;
  if (collectionId !== undefined && record.collectionId !== collectionId) return undefined;
  return { collectionId: record.collectionId, folderNativeId: record.folderNativeId };
}

export function folderIsInMount(nativeId: string, ancestorIds: readonly string[],
  mountNativeIds: ReadonlySet<string>): boolean {
  if (mountNativeIds.size === 0) return false;
  if (mountNativeIds.has(nativeId)) return true;
  return ancestorIds.some((id) => mountNativeIds.has(id));
}

/** A private boundary excludes itself and every descendant, including mounted roots. */
export function folderIsInSyncRange(nativeId: string, ancestorIds: readonly string[],
  selectedNative: ReadonlySet<string>, privateNative: ReadonlySet<string>): boolean {
  return ![nativeId, ...ancestorIds].some(id => privateNative.has(id))
    && folderIsInMount(nativeId, ancestorIds, selectedNative);
}

export async function walkAncestorIds(
  nativeId: string,
  getParent: (id: string) => Promise<string | undefined>,
): Promise<string[]> {
  const ancestors: string[] = [];
  let cursor = nativeId;
  for (let depth = 0; depth < 32; depth += 1) {
    const parent = await getParent(cursor);
    if (!parent) break;
    ancestors.push(parent);
    cursor = parent;
  }
  return ancestors;
}

export function resolveSaveFolder(input: {
  readonly once?: FolderBinding; readonly fallback?: FolderBinding;
  readonly collectionId: string;
  readonly mountNativeIds: ReadonlySet<string>;
  readonly onceAncestors?: readonly string[]; readonly fallbackAncestors?: readonly string[];
}): { readonly folderNativeId: string; readonly oneOff: boolean } | undefined {
  if (input.once && input.once.collectionId === input.collectionId) {
    return { folderNativeId: input.once.folderNativeId, oneOff: true };
  }
  if (input.fallback && folderIsInMount(input.fallback.folderNativeId, input.fallbackAncestors ?? [], input.mountNativeIds)) {
    return { folderNativeId: input.fallback.folderNativeId, oneOff: false };
  }
  return undefined;
}

export async function readDefaultFolder(): Promise<FolderBinding | undefined> {
  try {
    return parseFolderBinding((await chrome.storage.local.get(FOLDER_DEFAULT_BINDING))[FOLDER_DEFAULT_BINDING]);
  } catch { return undefined; }
}

export async function readOnceFolder(collectionId: string): Promise<FolderBinding | undefined> {
  try {
    return parseFolderBinding((await chrome.storage.session.get(FOLDER_ONCE_BINDING))[FOLDER_ONCE_BINDING], collectionId);
  } catch { return undefined; }
}

export async function writeOnceFolder(binding: FolderBinding): Promise<void> {
  try { await chrome.storage.session.set({ [FOLDER_ONCE_BINDING]: binding }); } catch { /* best-effort */ }
}

export async function clearOnceFolder(): Promise<void> {
  try { await chrome.storage.session.remove(FOLDER_ONCE_BINDING); } catch { /* best-effort */ }
}

export async function rememberSaveFolder(input: {
  readonly collectionId: string; readonly folderNativeId: string;
}): Promise<void> {
  await writeOnceFolder({ collectionId: input.collectionId, folderNativeId: input.folderNativeId });
}

export async function commitSaveFolder(input: {
  readonly folderNativeId: string;
}): Promise<void> {
  await pushFolderRecent(input.folderNativeId);
  await clearOnceFolder();
}
