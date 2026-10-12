import type { BoundaryNodeClass } from './bookmark-boundary.js';
import type { NormalizedBookmarkNode } from './chrome-bookmark-tree.js';
import type { PublicSyncProgress } from './types.js';

/** Bootstrap phases before the first push: the browser and the collection are still being compared. */
const PREPARING_PHASES = new Set(['confirmed', 'scanning', 'matching']);

export interface SyncProgressFacts {
  readonly firstRun: 'none' | 'deferred' | 'running' | 'completed';
  /** Phase of the newest bootstrap run, if any. */
  readonly runPhase?: string;
  readonly roots: readonly NormalizedBookmarkNode[];
  readonly classifications: ReadonlyMap<string, BoundaryNodeClass>;
  /** Native ids that already have a server node (matched, pushed, or pulled). */
  readonly mappedNativeIds: ReadonlySet<string>;
  /** Whether outbound work is still queued. */
  readonly liveWork: boolean;
}

/**
 * How much of the synced boundary is on the server. Counts the bookmarks and
 * folders the first-sync scan counts (`scanBoundary`: selected, not excluded,
 * not private, not managed) and, of those, the ones with a server mapping.
 * A mapping is the one fact every path ends in, whether the item matched an
 * existing server node, was uploaded, or came down from the server.
 */
export function projectSyncProgress(facts: SyncProgressFacts): PublicSyncProgress | null {
  if (facts.firstRun === 'none' || facts.firstRun === 'deferred') return null;
  const bookmarks = { synced: 0, total: 0 }; const folders = { synced: 0, total: 0 };
  const visit = (node: NormalizedBookmarkNode) => {
    const kind = facts.classifications.get(node.nativeId);
    if (kind === 'special-root' || kind === 'ordinary-folder') {
      const tally = node.kind === 'bookmark' ? bookmarks : node.kind === 'folder' ? folders : undefined;
      if (tally) { tally.total += 1; if (facts.mappedNativeIds.has(node.nativeId)) tally.synced += 1; }
    }
    for (const child of node.children) visit(child);
  };
  for (const root of facts.roots) visit(root);
  const preparing = facts.runPhase !== undefined && PREPARING_PHASES.has(facts.runPhase);
  const left = bookmarks.total - bookmarks.synced + folders.total - folders.synced;
  return {
    stage: preparing ? 'preparing' : left > 0 ? 'syncing' : 'done',
    firstSync: facts.firstRun === 'running' || preparing || facts.runPhase === 'syncing',
    liveWork: facts.liveWork,
    bookmarks, folders,
  };
}
