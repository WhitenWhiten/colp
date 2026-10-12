import { scanBoundary } from '../bookmark-boundary.js';
import type { NormalizedBookmarkNode, NormalizedBookmarkRoot } from '../chrome-bookmark-tree.js';
import type { BookmarkEventRecord } from '../sync-state/types.js';
import type { LocalNodeFact } from './matcher.js';

export function localFactsFromRoots(roots: readonly NormalizedBookmarkRoot[],
  selectedNativeIds: readonly string[], excludedNativeIds: readonly string[] = [],
  privateNativeIds: readonly string[] = []): LocalNodeFact[] {
  const selected = new Set(selectedNativeIds);
  const scan = scanBoundary({ roots, selectedNativeIds, excludedNativeIds, privateNativeIds });
  const facts: LocalNodeFact[] = [];
  const visit = (node: NormalizedBookmarkNode, ancestors: readonly string[], rootKindMount: string | null) => {
    const kind = scan.classifications.get(node.nativeId);
    const blocked = kind === 'managed' || kind === 'private-local' || kind === 'unsupported';
    const inBoundary = kind === 'special-root' || kind === 'ordinary-folder';
    const selectedHere = selected.has(node.nativeId) || ancestors.some((id) => selected.has(id));
    const mountNativeRootId = selected.has(node.nativeId) ? node.nativeId
      : ancestors.find((id) => selected.has(id)) ?? rootKindMount;
    if (inBoundary && !blocked && selectedHere && mountNativeRootId && ancestors.length > 0) {
      facts.push({
        nativeId: node.nativeId, mountNativeRootId, parentNativeId: ancestors[ancestors.length - 1] ?? null,
        kind: node.kind, title: node.title, ...(node.url ? { url: node.url } : {}),
      });
    }
    if (blocked) return;
    for (const child of node.children) visit(child, [...ancestors, node.nativeId],
      selected.has(node.nativeId) ? node.nativeId : rootKindMount);
  };
  for (const root of roots) {
    const mount = selected.has(root.nativeId) ? root.nativeId : null;
    for (const child of root.children) visit(child, [root.nativeId], mount);
  }
  return facts;
}

export function applyInboxToFacts(facts: readonly LocalNodeFact[],
  events: readonly BookmarkEventRecord[]): LocalNodeFact[] {
  const byId = new Map(facts.map((row) => [row.nativeId, { ...row }]));
  for (const event of [...events].sort((left, right) => left.ordinal - right.ordinal)) {
    if (event.status === 'processed') continue;
    const details = event.details;
    const title = typeof details.title === 'string' ? details.title : undefined;
    const url = typeof details.url === 'string' ? details.url : undefined;
    const parentNativeId = typeof details.parentNativeId === 'string' ? details.parentNativeId : null;
    const mountNativeRootId = typeof details.mountNativeRootId === 'string' ? details.mountNativeRootId : undefined;
    const kind = details.kind === 'folder' || details.kind === 'separator' ? details.kind : 'bookmark';
    if (event.kind === 'remove') { byId.delete(event.nativeId); continue; }
    const prior = byId.get(event.nativeId);
    if (event.kind === 'create' && !prior) {
      const mount = mountNativeRootId ?? parentNativeId ?? event.nativeId;
      byId.set(event.nativeId, {
        nativeId: event.nativeId, mountNativeRootId: mount, parentNativeId, kind, title: title ?? '',
        ...(url ? { url } : {}),
      });
      continue;
    }
    if (!prior) continue;
    if (event.kind === 'change') {
      byId.set(event.nativeId, { ...prior, ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }) });
    }
    if (event.kind === 'move') {
      byId.set(event.nativeId, { ...prior, parentNativeId,
        ...(mountNativeRootId ? { mountNativeRootId } : {}) });
    }
  }
  return [...byId.values()];
}
