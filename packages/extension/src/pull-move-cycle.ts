import { lookupBookmark } from './bookmark-api-error.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { PullBookmarkApi } from './pull-applier-types.js';

/** No bookmark tree is deeper than this; a walk that long is a broken tree, which Chrome rejects by itself. */
const MAX_ANCESTORS = 64;

/** True when `destinationNativeId` is `nodeNativeId` or lies below it: Chrome refuses such a move. */
export async function movesIntoOwnSubtree(api: PullBookmarkApi, nodeNativeId: string,
  destinationNativeId: string): Promise<boolean> {
  let current: string | undefined = destinationNativeId;
  for (let depth = 0; current !== undefined && depth < MAX_ANCESTORS; depth += 1) {
    if (current === nodeNativeId) return true;
    const looked = await lookupBookmark((id) => api.get(id), current);
    // What the browser will not show is the browser's to decide: the call itself reports a cycle.
    if (looked.class !== 'present') return false;
    current = looked.nodes[0]?.parentId;
  }
  return false;
}

/**
 * B-03: two devices that nest the same folders in opposite directions make the server ask this browser to move a
 * folder into its own descendant. The cycle is certain before any call, so the folder is set aside at once
 * (`pull_apply_move_cycle`) instead of being refused by Chrome on every wake.
 */
export async function refuseMoveCycle(api: PullBookmarkApi, mapping: { readonly nativeId: string; readonly nodeKind?: string },
  parent: { readonly nativeId: string }): Promise<void> {
  if (mapping.nodeKind !== 'folder') return;
  if (await movesIntoOwnSubtree(api, mapping.nativeId, parent.nativeId)) throw new SyncFailureError('pull_apply_move_cycle');
}
