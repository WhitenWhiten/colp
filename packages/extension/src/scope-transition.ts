/**
 * S-01 range, rejoin, and isolation contracts. Pure; no IndexedDB or Chrome.
 * `status !== 'detached'` is not a writable-active test.
 */
import type {
  MountBindingStatus, RangeTransitionAction, RangeTransitionDecision, RejoinCompareOutcome,
  ScopeCommandPhase, WritableScopeKind,
} from './sync-state/types.js';

export const PULL_DEPENDENCY_KINDS = Object.freeze([
  'parent_child', 'same_node', 'placement_anchor', 'parent_children_revision',
  'create_order', 'range_boundary', 'known_pending', 'local_pending_edits',
] as const);

export interface RangeEndFacts {
  readonly kind: WritableScopeKind;
  readonly mountId?: string;
  readonly generation?: number;
  readonly boundaryVersion?: string;
}

export interface RangeTransitionInput {
  readonly source: RangeEndFacts;
  readonly destination: RangeEndFacts;
  readonly identityConfirmed: boolean;
  readonly ancestorConfirmed: boolean;
  readonly permissionConfirmed: boolean;
  readonly pendingLocalOperations?: boolean;
}

export interface MountActivityInput {
  readonly status?: MountBindingStatus;
  readonly privateLocal?: boolean;
  readonly managed?: boolean;
  readonly rejoinInFlight?: boolean;
  readonly identityKnown?: boolean;
  readonly present?: boolean;
}

export function isWritableActiveScope(input: MountActivityInput): boolean {
  return classifyMountActivity(input) === 'active';
}

/** Rejoin is in-flight until the command reaches active or failed. */
export function rejoinCommandInFlight(phase: ScopeCommandPhase): boolean {
  return phase !== 'active' && phase !== 'failed';
}

export function classifyMountActivity(input: MountActivityInput): WritableScopeKind {
  if (input.privateLocal || input.managed) return 'private_local';
  if (input.identityKnown === false) return 'unknown';
  if (input.status === 'pending' || input.rejoinInFlight) return 'pending';
  if (input.status === 'detached') return 'detached';
  if (input.status === 'active') return 'active';
  if (input.present === false) return 'unmounted';
  return 'unmounted';
}

export function decideRangeTransition(input: RangeTransitionInput): RangeTransitionDecision {
  const pending = input.pendingLocalOperations === true;
  if (!input.identityConfirmed || !input.ancestorConfirmed || !input.permissionConfirmed) {
    return decision('await_dependency', { pending });
  }
  const source = input.source.kind;
  const destination = input.destination.kind;
  if (source === 'unknown' || destination === 'unknown' || source === 'pending' || destination === 'pending') {
    return source === 'active' || destination === 'active'
      ? decision('await_dependency', { pending })
      : decision('observe_only', { pending, observation: true });
  }
  if (generationsConflict(input.source, input.destination)) {
    return decision('await_dependency', { pending });
  }
  if (source === 'active' && destination === 'active') {
    return decision('native_move', { pending, chrome: true });
  }
  if (source === 'active') {
    return decision('retain_local_copy', { pending, observation: true, exclusion: true });
  }
  if (destination === 'active') {
    return decision('materialize_independent', { pending, chrome: true, observation: true, exclusion: true });
  }
  return decision('observe_only', { pending, observation: true });
}

export function compareRejoinFacts(input: {
  readonly baselineKnown: boolean;
  readonly localEqualsBaseline: boolean;
  readonly remoteEqualsBaseline: boolean;
  readonly sameFieldFork: boolean;
  readonly bothChangedDistinctFields: boolean;
  readonly remoteDeleted: boolean;
  readonly localEdited: boolean;
}): RejoinCompareOutcome {
  if (!input.baselineKnown) return 'baseline_unknown';
  if (input.remoteDeleted) return input.localEdited ? 'retain_local_edit' : 'apply_delete_policy';
  if (input.sameFieldFork) return 'conflict';
  if (input.bothChangedDistinctFields) return 'typed_merge';
  if (input.localEqualsBaseline && !input.remoteEqualsBaseline) return 'apply_remote';
  if (!input.localEqualsBaseline && input.remoteEqualsBaseline) return 'queue_local_at_baseline_revision';
  return 'already_equal';
}

export function canContinueIndependentPull(input: {
  readonly unknownBrowserSideEffect: boolean;
  readonly legalDuplicateContent: boolean;
  readonly sharesParentChild: boolean;
  readonly sharesNode: boolean;
  readonly sharesPlacementAnchor: boolean;
  readonly sharesParentChildrenRevision: boolean;
}): 'continue' | 'block' | 'unknown_side_effect' {
  if (input.unknownBrowserSideEffect) return 'unknown_side_effect';
  if (input.sharesParentChild || input.sharesNode || input.sharesPlacementAnchor
    || input.sharesParentChildrenRevision) return 'block';
  return 'continue';
}

function generationsConflict(source: RangeEndFacts, destination: RangeEndFacts): boolean {
  return source.generation !== undefined && destination.generation !== undefined
    && source.generation !== destination.generation;
}

function decision(action: RangeTransitionAction, flags: {
  readonly pending?: boolean; readonly chrome?: boolean;
  readonly observation?: boolean; readonly exclusion?: boolean;
}): RangeTransitionDecision {
  return {
    action, chromeMutation: flags.chrome === true, persistObservation: flags.observation === true,
    persistExclusion: flags.exclusion === true, preservePendingOperations: flags.pending === true,
  };
}
