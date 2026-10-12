export const SAVE_CONTEXT_CACHE = 'known.sync.save-context.v1';

export interface CachedSaveContext {
  readonly collectionId: string;
  readonly parentNativeId: string;
  /** First configured private-local root, when the user picked one. */
  readonly privateParentNativeId?: string;
}

/**
 * Last known native folders bound to a collection. When the worker cannot
 * resolve a save context (offline, expired session), the popup still places
 * the bookmark inside the sync boundary — or the private-local root — and
 * the durable event queue uploads synced saves once the engine reconnects.
 */
export function parseSaveContextCache(value: unknown, collectionId?: string): CachedSaveContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.collectionId !== 'string' || record.collectionId.length === 0) return undefined;
  if (typeof record.parentNativeId !== 'string' || record.parentNativeId.length === 0) return undefined;
  if (record.privateParentNativeId !== undefined && typeof record.privateParentNativeId !== 'string') return undefined;
  if (collectionId !== undefined && record.collectionId !== collectionId) return undefined;
  return {
    collectionId: record.collectionId, parentNativeId: record.parentNativeId,
    ...(typeof record.privateParentNativeId === 'string' && record.privateParentNativeId
      ? { privateParentNativeId: record.privateParentNativeId } : {}),
  };
}

export async function writeSaveContextCache(input: CachedSaveContext): Promise<void> {
  await chrome.storage.local.set({ [SAVE_CONTEXT_CACHE]: {
    collectionId: input.collectionId, parentNativeId: input.parentNativeId,
    ...(input.privateParentNativeId ? { privateParentNativeId: input.privateParentNativeId } : {}),
    updatedAt: Date.now(),
  } });
}

export async function clearSaveContextCache(): Promise<void> {
  await chrome.storage.local.remove(SAVE_CONTEXT_CACHE);
}
