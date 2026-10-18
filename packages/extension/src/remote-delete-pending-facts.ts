import type { RemoteDeleteDecisionRecord } from './sync-state/remote-delete-repository.js';
import type { UnknownRecord } from './sync-state/types.js';

export const OPEN_REMOTE_DELETE_STATES = ['pending', 'applying', 'restoring', 'rejected'] as const;
export function remoteDeleteDeferral(event: UnknownRecord): string | undefined {
  return typeof event.deferredRemoteDeleteId === 'string' ? event.deferredRemoteDeleteId : undefined;
}
export function remoteDeleteDeferralMatches(event: UnknownRecord, decision: RemoteDeleteDecisionRecord | undefined, generation: number): boolean {
  return Boolean(decision && decision.generation === generation && remoteDeleteDeferral(event) === decision.decisionId);
}
