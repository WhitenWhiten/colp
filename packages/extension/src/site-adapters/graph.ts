import type { SiteCollection } from './contracts.js';
import { LIMITS } from './limits.js';
/** Unresolved ancestry cannot silently become a root. */
export function validateCollectionGraph(collections: readonly SiteCollection[]): boolean {
  const byId = new Map(collections.map(c => [c.id, c]));
  if (byId.size !== collections.length) return false;
  return collections.every(c => {
    const seen = new Set<string>(); let node: SiteCollection | undefined = c;
    while (node) {
      if (seen.has(node.id) || seen.size >= LIMITS.depth || node.identity !== 'siteId' || node.parentId === undefined) return false;
      seen.add(node.id);
      if (node.parentId === null) return true;
      node = byId.get(node.parentId);
      if (!node) return false;
    }
    return false;
  });
}
