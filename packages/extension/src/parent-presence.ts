/**
 * C-05: an unknown parent is not a proven unmounted skip.
 * Source-retained natives stay excluded; they are not the deleted remote Node.
 */
export type ParentPresenceClass =
  | 'need_authority'
  | 'observe_inactive'
  | 'retain_local_exclusion'
  | 'proven_unmounted';

export interface ParentPresenceFacts {
  readonly parentIdentityKnown: boolean;
  readonly parentProvenInactive: boolean;
  readonly parentProvenUnmounted: boolean;
  readonly sourceRetainedNative: boolean;
}

export function classifyParentPresence(input: ParentPresenceFacts): ParentPresenceClass {
  if (input.sourceRetainedNative) return 'retain_local_exclusion';
  if (!input.parentIdentityKnown) return 'need_authority';
  if (input.parentProvenInactive) return 'observe_inactive';
  if (input.parentProvenUnmounted) return 'proven_unmounted';
  return 'need_authority';
}
