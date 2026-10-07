import { assertSameOriginFaviconUrl } from '../domain/index.js';
import type { BookmarkIconReadPort } from './ports.js';

export type BookmarkIconObjectIdLookup = Pick<BookmarkIconReadPort, 'findObjectIdsByNodeIds'>;

/**
 * Same-origin Product favicon URL. The only allowed form is
 * `{productOrigin}/api/v1/favicon/{uuid}`.
 */
export function bookmarkIconUrlFromObjectId(
  productOrigin: string,
  objectId: string,
): string {
  const origin = productOrigin.replace(/\/+$/u, '');
  return assertSameOriginFaviconUrl(`${origin}/api/v1/favicon/${objectId}`, origin);
}

/**
 * Bookmark `iconUrl` for a node id. Missing map entries and missing origin
 * fail closed to JSON `null` (the field stays present on bookmark views).
 */
export function iconUrlForNode(
  nodeId: string,
  iconsByNodeId: ReadonlyMap<string, string>,
  productOrigin: string | undefined,
): string | null {
  const objectId = iconsByNodeId.get(nodeId);
  if (objectId === undefined) return null;
  if (productOrigin === undefined || productOrigin.length === 0) return null;
  return bookmarkIconUrlFromObjectId(productOrigin, objectId);
}

/**
 * One batch lookup. Missing port or empty `nodeIds` is a no-op (no SQL).
 * Map-missing ids are omitted; callers treat miss as null.
 */
export async function loadBookmarkIconObjectIds(
  port: BookmarkIconObjectIdLookup | undefined,
  nodeIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (port === undefined || nodeIds.length === 0) return new Map();
  return port.findObjectIdsByNodeIds(nodeIds);
}

/** Single-node lookup used by create / update / move / favicon DELETE. */
export async function projectBookmarkIconUrl(
  port: BookmarkIconObjectIdLookup | undefined,
  nodeId: string,
  productOrigin: string | undefined,
): Promise<string | null> {
  const icons = await loadBookmarkIconObjectIds(port, [nodeId]);
  return iconUrlForNode(nodeId, icons, productOrigin);
}
