import { bookmarkUrl } from '../generated/import-preview-validators.js';
import type { BackupNode } from './codec.js';

/** Filter unsupported leaves before validation, retaining the flat tree's parent indexes. */
export function supportedBackupNodes(nodes: readonly BackupNode[]): BackupNode[] {
  const indexes = new Map<number, number>();
  const result: BackupNode[] = [];
  nodes.forEach((node, index) => {
    if (node.url !== undefined && !bookmarkUrl(node.url)) return;
    const parentIndex = node.parentIndex === null ? null : indexes.get(node.parentIndex);
    if (parentIndex === undefined) return;
    indexes.set(index, result.length);
    result.push({ ...node, parentIndex });
  });
  return result;
}
