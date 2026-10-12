import { isProtocolOpaqueId } from './protocol-id.js';
import type { PublicCollectionChoice } from './types.js';

export const COLLECTIONS_CACHE = 'known.collections.cache.v1';

export interface CollectionsCacheAccount {
  readonly accountId?: string;
  readonly accountLabel?: string;
}

export function selectPrivateBookmarkLibraries<T extends { readonly kind: string; readonly visibility?: string }>(
  items: readonly T[],
): T[] {
  return items.filter((item) => item.kind === 'bookmarks' && item.visibility === 'private');
}

export function parseCollectionsCache(value: unknown, account?: CollectionsCacheAccount):
  readonly PublicCollectionChoice[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.accountId !== 'string' || typeof record.accountLabel !== 'string'
      || !Array.isArray(record.collections) || typeof record.fetchedAt !== 'number') return undefined;
  if (account?.accountId && record.accountId !== account.accountId) return undefined;
  if (account?.accountLabel && record.accountLabel !== account.accountLabel) return undefined;
  const collections: PublicCollectionChoice[] = [];
  for (const item of record.collections) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const row = item as Record<string, unknown>;
    if (!isProtocolOpaqueId(row.id) || typeof row.title !== 'string' || typeof row.kind !== 'string') return undefined;
    const rootNodeId = row.rootNodeId;
    if (rootNodeId !== undefined && !isProtocolOpaqueId(rootNodeId)) return undefined;
    const visibility = row.visibility;
    if (visibility !== undefined && typeof visibility !== 'string') return undefined;
    collections.push({
      id: row.id, title: row.title, kind: row.kind,
      ...(typeof visibility === 'string' ? { visibility } : {}),
      ...(typeof rootNodeId === 'string' ? { rootNodeId } : {}),
    });
  }
  return collections;
}

export async function writeCollectionsCache(input: {
  readonly accountId: string; readonly accountLabel: string; readonly collections: readonly PublicCollectionChoice[];
}): Promise<void> {
  await chrome.storage.local.set({ [COLLECTIONS_CACHE]: {
    accountId: input.accountId, accountLabel: input.accountLabel, collections: input.collections, fetchedAt: Date.now(),
  } });
}

export async function clearCollectionsCache(): Promise<void> {
  await chrome.storage.local.remove(COLLECTIONS_CACHE);
}

const COLLECTION_BINDING_KEY = 'known.sync.collection.v1';

/** Drop a stored sync target once an authoritative private-library list omits it. */
export async function forgetCollectionBindingIfAbsent(
  libraries: readonly { readonly id: string }[],
): Promise<void> {
  const stored = (await chrome.storage.local.get(COLLECTION_BINDING_KEY))[COLLECTION_BINDING_KEY];
  if (!isProtocolOpaqueId(stored) || libraries.some((item) => item.id === stored)) return;
  await chrome.storage.local.remove(COLLECTION_BINDING_KEY);
}
