import { ReportsDomainError } from './errors.js';
import { type DigestEditionState, type DigestRunState } from './types.js';
import { type DigestSeriesState } from './types.js';

export function transitionDigestSeries(state: DigestSeriesState, transition: 'archive'): DigestSeriesState {
  if (state === 'active' && transition === 'archive') return 'archived';
  throw new ReportsDomainError('invalid_transition', `cannot ${transition} series in ${state} state`);
}
export const transitionSeriesState = transitionDigestSeries;

export type DigestEditionTransition = 'publish' | 'withdraw' | 'detach';
export function transitionDigestEdition(state: DigestEditionState, transition: DigestEditionTransition): DigestEditionState {
  if (state === 'draft' && transition === 'publish') return 'published';
  if (state === 'draft' && transition === 'withdraw') return 'withdrawn';
  if (state === 'draft' && transition === 'detach') return 'detached';
  if (state === 'published' && transition === 'withdraw') return 'withdrawn';
  throw new ReportsDomainError('invalid_transition', `cannot ${transition} edition in ${state} state`);
}
export const transitionEditionState = transitionDigestEdition;

export function isTerminalDigestEditionState(state: DigestEditionState): boolean {
  return state === 'withdrawn' || state === 'detached';
}

export type DigestRunTransition =
  | { readonly type: 'lease'; readonly owner: string; readonly generation: number }
  | { readonly type: 'succeed'; readonly owner: string; readonly generation: number }
  | { readonly type: 'retry'; readonly owner: string; readonly generation: number }
  | { readonly type: 'fail'; readonly owner: string; readonly generation: number }
  | { readonly type: 'cancel'; readonly owner?: string; readonly generation?: number };

export function transitionDigestRun(
  state: DigestRunState,
  transition: DigestRunTransition,
  current: { readonly leaseOwner: string | null; readonly generation: number },
): DigestRunState {
  if (transition.type === 'lease' && state === 'pending' && current.generation === transition.generation) return 'leased';
  const owned = 'owner' in transition && transition.owner === current.leaseOwner && transition.generation === current.generation;
  if (!owned) throw new ReportsDomainError('lease_conflict', 'run lease generation or owner does not match');
  if (state === 'leased' && transition.type === 'succeed') return 'succeeded';
  if (state === 'leased' && transition.type === 'retry') return 'retryable';
  if (state === 'leased' && transition.type === 'fail') return 'failed';
  if ((state === 'pending' || state === 'leased' || state === 'retryable') && transition.type === 'cancel') return 'cancelled';
  throw new ReportsDomainError('invalid_transition', `cannot ${transition.type} run in ${state} state`);
}
export const transitionRunState = transitionDigestRun;
