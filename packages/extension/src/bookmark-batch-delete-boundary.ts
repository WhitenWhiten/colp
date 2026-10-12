import { digestJson } from './bookmark-event-codec.js';
import type { BatchBookmarkApi, BatchChromeNode } from './bookmark-batch-plan.js';

/** Root position is checked separately; sibling deletions do not change this subtree's contents. */
export function deleteSubtreeDigest(root: BatchChromeNode): string {
  const rows = [], seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node.id) || seen.size >= 50_000) throw new Error('delete_subtree_unavailable');
    seen.add(node.id);
    rows.push({ id: node.id, parentId: node.parentId ?? null, title: node.title, url: node.url ?? null,
      index: node.id === root.id ? 0 : node.index ?? 0, unmodifiable: node.unmodifiable ?? null, folderType: node.folderType ?? null });
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) stack.push(node.children![index]!);
  }
  return digestJson(rows);
}

export async function readBatchSubtree(api: BatchBookmarkApi, nativeId: string): Promise<BatchChromeNode | undefined> {
  if (api.getSubTree) return (await api.getSubTree(nativeId))[0];
  const stack = [...await api.getTree()];
  while (stack.length) { const node = stack.pop()!; if (node.id === nativeId) return node; stack.push(...node.children ?? []); }
  return undefined;
}

export async function assertDeleteSubtree(api: BatchBookmarkApi, nativeId: string, expected?: string) {
  const tree = await readBatchSubtree(api, nativeId);
  // Legacy folder plans did not record the confirmed subtree: require a new preview.
  if (!expected || !tree || deleteSubtreeDigest(tree) !== expected) throw new Error('changed');
}
