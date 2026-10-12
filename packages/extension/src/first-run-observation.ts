import { projectFirstRunSurface } from './first-run-draft.js';
import type { FirstRunDurablePhase, FirstRunOrScopeResponse, FirstRunScopeState, PublicAttentionSummary } from './types.js';

export interface FirstRunObservation {
  readonly firstRun: FirstRunScopeState | undefined;
  readonly phase?: FirstRunDurablePhase;
  readonly attention?: PublicAttentionSummary;
}
/** A status snapshot replaces its phase and attention together; errors preserve the last valid observation. */
export function observeFirstRunResponse(response: FirstRunOrScopeResponse, previous: FirstRunObservation): FirstRunObservation {
  if (!response.ok || !('firstRun' in response)) return previous;
  const next: FirstRunObservation = { firstRun: response.firstRun,
    phase: response.phase, attention: response.attention };
  return projectFirstRunSurface(next) === 'hide' ? { ...next, firstRun: 'completed' } : next;
}
