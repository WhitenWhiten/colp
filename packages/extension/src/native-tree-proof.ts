import { SyncFailureError } from './sync-failure-class.js';
export interface NativeProofNode {
  readonly id: string; readonly parentId?: string; readonly title: string;
  readonly url?: string; readonly index?: number; readonly dateAdded?: number;
  readonly unmodifiable?: string; readonly children?: readonly NativeProofNode[];
}
/** Ignore last-used timestamps; preview authority concerns identity, content and placement. */
export function nativeTreeProof(roots: readonly NativeProofNode[]) {
  const nodes: Array<{ id: string; parentId: string | null; title: string; url: string | null;
    index: number; dateAdded: number | null; managed: boolean }> = [];
  const seen = new Set<string>();
  const visit = (siblings: readonly NativeProofNode[], parentId: string | null, depth: number, managed: boolean) => {
    if (depth > 65) throw new SyncFailureError('preview_too_large');
    for (const [index, node] of siblings.entries()) {
      if (nodes.length >= 100_000 || !node.id || seen.has(node.id)) throw new SyncFailureError('preview_too_large');
      seen.add(node.id);
      nodes.push({ id: node.id, parentId, title: node.title, url: node.url ?? null, index,
        dateAdded: node.dateAdded ?? null, managed: managed || Boolean(node.unmodifiable) });
      visit(node.children ?? [], node.id, depth + 1, managed || Boolean(node.unmodifiable));
    }
  };
  visit(roots, null, 0, false);
  return nodes;
}
export async function localProofDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > 32 * 1024 * 1024) throw new SyncFailureError('preview_too_large');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
