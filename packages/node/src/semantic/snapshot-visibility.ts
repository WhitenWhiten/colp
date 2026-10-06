import type { StrictNode } from '../types/index.js';
import type { SemanticIssue } from './index.js';
import { visibilityRank } from './snapshot-page-assembly.js';

interface VisibilityResolverOptions {
  readonly localNodes: ReadonlyMap<string, StrictNode>;
  readonly collectionRank: number;
  readonly maxExternalNodes: number;
  readonly lookup: (id: string, path: string, reportFailure: boolean) => StrictNode | undefined;
  readonly report: (issue: SemanticIssue) => void;
}

/** Iterative local-tree resolution; only externally supplied ancestry consumes the resolver budget. */
export function createSnapshotVisibilityResolver(options: VisibilityResolverOptions) {
  const cache = new Map<string, number>();
  const cyclicAncestry = new Set<string>();
  return (node: StrictNode, path: string): number => {
    const existing = cache.get(node.id);
    if (existing !== undefined) return existing;
    const trail: StrictNode[] = [];
    const seen = new Set<string>();
    const startsExternal = !options.localNodes.has(node.id);
    let current: StrictNode | undefined = node;
    let rank = options.collectionRank;
    let externalNodes = 0;
    while (current !== undefined) {
      const resolved = cache.get(current.id);
      if (resolved !== undefined) {
        rank = resolved;
        break;
      }
      if (current.kind === 'root') {
        cache.set(current.id, rank);
        break;
      }
      if (cyclicAncestry.has(current.id)) {
        for (const ancestor of trail) cyclicAncestry.add(ancestor.id);
        return visibilityRank.private;
      }
      if (seen.has(current.id)) {
        if (startsExternal) options.report({
          code: 'parent_cycle', path,
          message: `Parent cycle detected through resolved node ${current.id}.`,
        });
        // Remember the failed ancestry separately from resolved ranks. Every
        // other entry into this cycle can fail without traversing it again.
        for (const ancestor of trail) cyclicAncestry.add(ancestor.id);
        return visibilityRank.private;
      }
      const currentIsExternal = !options.localNodes.has(current.id);
      if (currentIsExternal && ++externalNodes > options.maxExternalNodes) {
        options.report({
          code: 'reference_resolution_limit', path,
          message: `Resolved visibility ancestry exceeds ${options.maxExternalNodes} external nodes.`,
        });
        // Failure is conservative and uncached, including a local start whose ancestry is external.
        return visibilityRank.private;
      }
      seen.add(current.id);
      trail.push(current);
      current = options.lookup(current.parentId, path, startsExternal && currentIsExternal);
    }
    for (let index = trail.length - 1; index >= 0; index -= 1) {
      const child = trail[index]!;
      rank = Math.max(rank, visibilityRank[child.visibility ?? 'inherit']);
      cache.set(child.id, rank);
    }
    return cache.get(node.id) ?? rank;
  };
}
