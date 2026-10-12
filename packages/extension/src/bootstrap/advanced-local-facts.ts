import type { BoundaryScan } from '../bookmark-boundary.js';
import type { NormalizedBookmarkNode, NormalizedBookmarkRoot } from '../chrome-bookmark-tree.js';
import type { LocalNodeFact } from './matcher.js';

/** Keep protected descendants in the plan's facts, marked read-only. Omitting
 * them would make an ancestor incorrectly appear safe to delete. */
export function advancedLocalFacts(roots: readonly NormalizedBookmarkRoot[], scan: BoundaryScan): LocalNodeFact[] {
  const selected = new Set(scan.selectedNativeIds); const facts: LocalNodeFact[] = [];
  const pending: Array<{ node: NormalizedBookmarkNode; parent: string | null; mount: string | null;
    index: number; protected: boolean }> = roots.map((node, index) => ({ node, parent: null,
      mount: null, index, protected: false }));
  for (let offset = 0; offset < pending.length; offset += 1) {
    const item = pending[offset]!; const { node } = item;
    const mount = selected.has(node.nativeId) ? node.nativeId : item.mount;
    const classification = scan.classifications.get(node.nativeId);
    const protectedNode = item.protected || node.managed || classification === 'private-local'
      || classification === 'managed' || classification === 'unsupported' || (mount !== null && classification === 'out-of-boundary');
    if (mount) facts.push({ nativeId: node.nativeId, mountNativeRootId: mount, parentNativeId: item.parent,
      kind: node.kind, title: node.title, index: item.index,
      ...(node.url === undefined ? {} : { url: node.url }),
      ...(node.managed ? { managed: true } : {}), ...(protectedNode ? { privateLocal: true } : {}) });
    node.children.forEach((child, index) => pending.push({ node: child, parent: node.nativeId,
      mount, index, protected: protectedNode }));
  }
  return facts;
}
