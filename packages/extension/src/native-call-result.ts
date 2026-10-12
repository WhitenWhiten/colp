/**
 * C-02: Chrome side effects distinguish not-started from result-unknown.
 * 0 or 1 unoccupied newcomer is not identity proof.
 */
import type { IntentRecord, NativeCallResult, PersistedNativeCallResult } from './sync-state/types.js';

export interface NativeCallFacts {
  readonly intentExists: boolean;
  readonly callStarted: boolean;
  readonly apiReturnNativeId?: string;
  readonly nativeEventCorrelationOnly: boolean;
  readonly newcomerCount?: number;
  readonly deleteTargetProvenAbsent: boolean;
  readonly permissionOrManagedOrOtherError: boolean;
  readonly waitingDependency: boolean;
}

export interface IntentOwnerInput {
  readonly scopeKey: string;
  readonly generation: number;
  readonly commandId: string;
  readonly eventId: string;
  readonly colpId: string;
  readonly substep: string;
}

export function classifyNativeCallFacts(input: NativeCallFacts): NativeCallResult {
  if (input.permissionOrManagedOrOtherError) return 'failed';
  if (input.waitingDependency) return 'waiting_dependency';
  if (input.deleteTargetProvenAbsent) return 'absent';
  if (input.callStarted && typeof input.apiReturnNativeId === 'string') return 'applied_with_evidence';
  if (input.callStarted) return 'result_unknown';
  if (input.intentExists) return 'not_started';
  return 'result_unknown';
}

export function readStoredNativeResult(
  intent: Pick<IntentRecord, 'nativeResult'> | Record<string, unknown>,
): PersistedNativeCallResult {
  const value = 'nativeResult' in intent ? intent.nativeResult : undefined;
  return typeof value === 'string' ? value as PersistedNativeCallResult : 'unknown';
}

export function readStoredReplayState(
  intent: Pick<IntentRecord, 'replayState'> | Record<string, unknown>,
): NonNullable<IntentRecord['replayState']> {
  const value = 'replayState' in intent ? intent.replayState : undefined;
  return typeof value === 'string' ? value as NonNullable<IntentRecord['replayState']> : 'unknown';
}

export function intentOwnerKey(input: IntentOwnerInput): string {
  return JSON.stringify([
    input.scopeKey, input.generation, input.commandId, input.eventId, input.colpId, input.substep,
  ]);
}
