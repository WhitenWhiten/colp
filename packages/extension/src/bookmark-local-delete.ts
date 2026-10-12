import { digestJson } from './bookmark-event-codec.js';
import { readNativeFolderDescriptions, notifyFolderDescriptionChanged } from './folder-description-native.js';
import { createFolderDescriptionStore } from './folder-description-store.js';
import { readNativeBookmarkAnnotations } from './bookmark-annotation-native.js';
import { createBookmarkAnnotationStore } from './bookmark-annotation-store.js';
import type { BatchBookmarkApi, BatchChromeNode } from './bookmark-batch-plan.js';
import type { BatchItemRecord } from './sync-state/batch-repository.js';
import { createLocalDeleteStore, type LocalDeleteNode, type LocalDeleteStore } from './bookmark-local-delete-store.js';
import { deleteSubtreeDigest, readBatchSubtree } from './bookmark-batch-delete-boundary.js';

const backups = createLocalDeleteStore();
const MAX_SNAPSHOT_NODES = 50_000;
export { BOOKMARK_UNDO_WINDOW_MS as LOCAL_DELETE_RETENTION_MS } from './bookmark-undo.js';
import { BOOKMARK_UNDO_WINDOW_MS as LOCAL_DELETE_RETENTION_MS } from './bookmark-undo.js';

export async function backupLocalDelete(api: BatchBookmarkApi, item: BatchItemRecord, now: number,
  journal: LocalDeleteStore = backups) {
  if (!api.create) throw new Error('local_restore_unavailable');
  const root = await readBatchSubtree(api, item.nativeId);
  if (!root) throw new Error('local_delete_missing');
  if (item.subtreeDigest && deleteSubtreeDigest(root) !== item.subtreeDigest) throw new Error('changed');
  const descriptions = await readNativeFolderDescriptions([root]), annotations = await readNativeBookmarkAnnotations([root]);
  const nodes: LocalDeleteNode[] = [], seen = new Set<string>();
  const visit = (node: BatchChromeNode, parentOrder: number | null) => {
    if (seen.has(node.id) || nodes.length >= MAX_SNAPSHOT_NODES || node.unmodifiable) throw new Error('local_delete_snapshot_unavailable');
    seen.add(node.id); const order = nodes.length;
    nodes.push({ snapshotId: item.reversalId, order, parentOrder, title: node.title,
      ...(node.url === undefined && descriptions.has(node.id) ? { description: descriptions.get(node.id)! } : {}),
      ...(node.url === undefined ? {} : { url: node.url }),
      ...(annotations.has(node.id) ? { annotation: { tags: [...annotations.get(node.id)!.tags], note: annotations.get(node.id)!.note,
        ...(annotations.get(node.id)!.pinned ? { pinned: true as const } : {}) } } : {}), index: node.index ?? 0, state: 'waiting' });
    for (const child of node.children ?? []) visit(child, order);
  };
  visit(root, null);
  await journal.prune(now);
  await journal.put({ snapshotId: item.reversalId, sourceNativeId: item.nativeId, parentId: item.parentNativeId,
    digest: digestJson(nodes.map(node => ({ ...node }))), total: nodes.length, next: 0, expiresAt: now + LOCAL_DELETE_RETENTION_MS }, nodes);
}

/** Resume only recorded native receipts. An unknown create is never repeated or guessed from a URL. */
export async function restoreLocalDelete(api: BatchBookmarkApi, item: BatchItemRecord,
  journal: LocalDeleteStore = backups) {
  if (!api.create) throw new Error('local_restore_unavailable');
  let snapshot = await journal.get(item.reversalId);
  if (!snapshot || snapshot.sourceNativeId !== item.nativeId) throw new Error('local_delete_snapshot_missing');
  while (snapshot.next < snapshot.total) {
    const node = await journal.node(snapshot.snapshotId, snapshot.next);
    if (!node) throw new Error('local_delete_snapshot_missing');
    if (node.state === 'submitted') throw new Error('local_restore_result_unknown');
    const parent = node.parentOrder === null ? undefined : await journal.node(snapshot.snapshotId, node.parentOrder);
    const parentId = parent?.nativeId ?? (node.parentOrder === null ? snapshot.parentId : undefined);
    if (!parentId) throw new Error('local_restore_parent_missing');
    const [folder] = await api.get(parentId);
    if (!folder || folder.url !== undefined || folder.unmodifiable) throw new Error('local_restore_parent_missing');
    await journal.submit(snapshot, node);
    const created = await api.create({ parentId, index: node.index, title: node.title, ...(node.url === undefined ? {} : { url: node.url }) });
    await journal.confirm(snapshot, node, created.id);
    snapshot = (await journal.get(item.reversalId))!;
  }
  // Native receipts are committed first. A resumed undo can finish metadata without repeating a create.
  const descriptions = createFolderDescriptionStore(), annotations = createBookmarkAnnotationStore();
  try {
    for (const node of await journal.nodes(snapshot.snapshotId)) {
      if (!node.nativeId) continue;
      if (node.annotation && node.url !== undefined) {
        const [bookmark] = await api.get(node.nativeId);
        if (!bookmark || bookmark.url === undefined) throw new Error('local_restore_result_unknown');
        await annotations.save(bookmark, node.annotation, { preserveTags: true });
        // Created back at its old index, so a pin needs only its flag.
        if (node.annotation.pinned) await annotations.setPinned(bookmark, true);
      }
      if (node.description === undefined || node.url !== undefined) continue;
      const [folder] = await api.get(node.nativeId);
      if (!folder || folder.url !== undefined) throw new Error('local_restore_result_unknown');
      await descriptions.save(folder, node.description);
      void notifyFolderDescriptionChanged(node.nativeId);
    }
  } finally { descriptions.close(); annotations.close(); }
}
