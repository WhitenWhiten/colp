export type TimelineSummaryKind = 'collection_change' | 'follow_activity';

/** Closed timeline summary tokens. Keep the social and notifications copies in lockstep. */
export function closedTimelineSummary(
  kind: TimelineSummaryKind, locatorsVisible: boolean,
): string | null {
  if (kind === 'follow_activity') return 'new_follower';
  if (kind === 'collection_change' && locatorsVisible) return 'public_collection_updated';
  return null;
}
