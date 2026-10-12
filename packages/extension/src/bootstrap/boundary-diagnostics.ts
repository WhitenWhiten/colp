import { bookmarkRepresentability } from '../bookmark-event-codec.js';
import type { BoundaryScan } from '../bookmark-boundary.js';
import type { NormalizedBookmarkNode } from '../chrome-bookmark-tree.js';
import type { SyncScope, createSyncStateStore } from '../sync-state-store.js';

export async function recordBoundaryDiagnostics(store: Pick<ReturnType<typeof createSyncStateStore>, 'putIngressDiagnostic'>,
  scope: SyncScope, scan: BoundaryScan, roots: readonly NormalizedBookmarkNode[], sourceId: string): Promise<void> {
  async function visit(node: NormalizedBookmarkNode, inherited?: string): Promise<void> {
    const reason = bookmarkRepresentability({ type: node.kind, title: node.title, url: node.url });
    const excludedReason = scan.classifications.get(node.nativeId) === 'unsupported'
      ? inherited ?? (reason === 'supported' ? undefined : reason) : undefined;
    if (scan.classifications.get(node.nativeId) === 'unsupported' && excludedReason) {
      await store.putIngressDiagnostic(scope, { code: excludedReason }, { sourceId: `${sourceId}:${node.nativeId}` });
    }
    for (const child of node.children) await visit(child, excludedReason);
  }
  for (const root of roots) await visit(root);
}
