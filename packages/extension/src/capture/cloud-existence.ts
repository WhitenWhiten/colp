import type { CaptureEditorPage } from '../classification-product-client.js';
import type { CaptureLocation } from './contracts.js';

/** Existing permission/revision-fenced editor pages; publish only a complete snapshot. */
export async function queryCloudCapture(url: string, collectionId: string,
  read: (cursor?: string) => Promise<CaptureEditorPage>) {
  let cursor: string | undefined;
  let snapshot: string | undefined;
  const nodes = new Map<string, CaptureEditorPage['nodes'][number]>();
  let last: CaptureEditorPage | undefined;
  const cursors = new Set<string>();
  for (let count = 0; count < 100; count++) {
    const page = await read(cursor);
    if (page.collection.id !== collectionId || (snapshot && snapshot !== page.page.snapshotId)) throw new Error('capture_cloud_snapshot_changed');
    snapshot = page.page.snapshotId; last = page;
    for (const node of page.nodes) nodes.set(node.id, node);
    if (!page.page.hasMore) break;
    if (!page.page.nextCursor || cursors.has(page.page.nextCursor)) throw new Error('capture_cloud_cursor_invalid');
    cursor = page.page.nextCursor; cursors.add(cursor);
  }
  if (!last || last.page.hasMore) return { locations: [], collectionIds: [collectionId], complete: false, stale: false };
  const locations: CaptureLocation[] = [];
  for (const node of nodes.values()) {
    if (node.kind !== 'bookmark' || node.url !== url) continue;
    const path: string[] = [];
    const seen = new Set<string>();
    let parent = node.parentId;
    while (parent !== last.root.id) {
      if (!parent || seen.has(parent)) throw new Error('capture_cloud_path_invalid');
      seen.add(parent);
      const folder = nodes.get(parent);
      if (!folder || folder.kind !== 'folder') throw new Error('capture_cloud_path_incomplete');
      path.unshift(folder.title); parent = folder.parentId;
    }
    locations.push({ nativeId: null, nodeId: node.id, collectionId, collectionTitle: last.collection.title,
      path: [last.collection.title, ...path], writable: last.capabilities.updateNode && last.capabilities.moveNode, url });
  }
  return { locations, collectionIds: [collectionId], complete: true, stale: false };
}
