/**
 * The server answers a create or move with one of these when its placement
 * facts are out of date. It executed nothing, so the push worker clears the
 * attempt and re-authors the change instead of replaying the same bytes.
 */
export function isPlacementRefusal(code: string | undefined): boolean {
  return code === 'position_context_stale' || code === 'revision_conflict';
}
