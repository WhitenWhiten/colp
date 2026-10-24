import { SyncFailureError } from './sync-failure-class.js';
/**
 * SR-02: the honest Chrome-bookmark read seam for Pull apply.
 *
 * Real Chromium *rejects* `chrome.bookmarks.get` for an unknown id; it never answers `[]`. Every
 * read therefore has to be classified (`present | not_found | permission_denied |
 * managed_not_writable | other_failure`) and routed by meaning:
 *
 * - `not_found` on a node the remote effect *targets* -> local/remote divergence, recorded as
 *   `pull_apply_target_missing` and held for explicit local replica rebuild (see
 *   `src/pull-recovery-freeze.ts`). It is not a transport fault, so it must not become an
 *   unbounded offline backoff over the same staged event.
 * - `not_found` on a node that is merely *read for evidence* (`readOptional`) -> `undefined`,
 *   which callers already model as "no before-state / nothing to verify against".
 * - `permission_denied` / `managed_not_writable` / `other_failure` -> the raw message, so the
 *   existing offline classification keeps seeing a genuine API fault.
 */
import { lookupBookmark, lookupBookmarkChildren, type BookmarkLookup, type BookmarkNode } from './bookmark-api-error.js';
import { requirePullMapping } from './pull-apply-decision.js';
import type { PullApplierOptions, PullBookmarkApi } from './pull-applier-types.js';

export function createPullBookmarkEvidence(options: PullApplierOptions, api: PullBookmarkApi) {
  /**
   * The one place in the pull-apply seam that touches `chrome.bookmarks.get`. Callers must
   * classify the outcome instead of assuming presence - an empty array was a lenient fake,
   * never the contract.
   */
  function lookup(id: string): Promise<BookmarkLookup> {
    return lookupBookmark((nativeId) => api.get(nativeId), id);
  }

  /** Same seam for `getChildren`; an empty array is legal here (empty folder), a rejection is not. */
  function lookupChildren(id: string): Promise<BookmarkLookup> {
    return lookupBookmarkChildren((nativeId) => api.getChildren(nativeId), id);
  }

  /**
   * SR-02: remote authority names a native bookmark that no longer exists locally. That is a
   * local-projection / remote-authority divergence, not a retryable transport failure - the local
   * bookmark was deleted (or never materialised) while the server still carries the node.
   * Record the divergence, then surface `pull_apply_target_missing`, which freezes the Pull:
   * the scope stops with an explicit rebuild action. A fresh active Session cannot repair a
   * missing Chrome identity and must never replay the same staged read indefinitely.
   */
  async function targetMissingError(colpId: string, nativeId: string, role?: 'parent'): Promise<Error> {
    await options.store.putScopeDiagnostic(options.scope, { kind: 'pull_apply_target_missing', code: 'not_found',
      details: { colpId, nativeId, ...(role ? { role } : {}) } });
    return new SyncFailureError('pull_apply_target_missing');
  }

  /**
   * Pre-state evidence for a create. A vanished parent is the same divergence as a vanished
   * mutation target; any other read failure must fail the expectation outright - digesting an
   * empty child list would fabricate evidence that was never observed. B-10: that failure is
   * transient (nothing was written, the read is tried again), never a freeze whose only exit is
   * a rebuild; a lost permission keeps waiting for the user like every other native call.
   */
  async function parentChildren(colpId: string, parentNativeId: string): Promise<readonly BookmarkNode[]> {
    const looked = await lookupChildren(parentNativeId);
    if (looked.class === 'not_found') throw await targetMissingError(colpId, parentNativeId, 'parent');
    if (looked.class === 'permission_denied') throw new SyncFailureError('permission_revoked');
    if (looked.class !== 'present') throw new SyncFailureError('native_read_failed');
    return looked.nodes;
  }

  /**
   * SR-02: an anchor mapping whose native bookmark is gone cannot be resolved to an index.
   * `anchor_mapping_missing` freezes the Pull (sync-failure-class.ts) and holds the page for explicit local
   * replica rebuild instead of silently landing the child at index 0. Real API faults keep
   * their raw message and therefore the existing offline classification.
   */
  async function anchorIndex(colpId: string, offset: (index: number) => number): Promise<number> {
    const anchor = await requirePullMapping(options, colpId, 'anchor');
    const looked = await lookup(anchor.nativeId);
    if (looked.class === 'not_found') throw new SyncFailureError('anchor_mapping_missing');
    if (looked.class !== 'present') throw new Error(looked.message);
    const node = looked.nodes[0];
    if (!node || node.index === undefined) throw new SyncFailureError('anchor_mapping_missing');
    return offset(node.index);
  }

  /**
   * A failed anchor read must fail the whole expectation. Silently falling back to index 0 would
   * land the node in the wrong slot, which is worse than not landing it at all.
   */
  async function nativeIndex(afterId: string | null, beforeId: string | null): Promise<number> {
    if (afterId) return await anchorIndex(afterId, (index) => index + 1);
    if (beforeId) return await anchorIndex(beforeId, (index) => index);
    return 0;
  }

  return { lookup, lookupChildren, targetMissingError, parentChildren, nativeIndex };
}

/**
 * Verifications reads ("do we know a before-state?", "is this native still there?") are not
 * existence expectations: `not_found` degrades to `undefined`, which every caller already models,
 * while a genuine API fault still surfaces with its raw message instead of masquerading as
 * "nothing found".
 */
export function readOptional(looked: BookmarkLookup | undefined): BookmarkNode | undefined {
  if (looked === undefined || looked.class === 'not_found') return undefined;
  if (looked.class === 'present') return looked.nodes[0];
  throw new Error(looked.message);
}
