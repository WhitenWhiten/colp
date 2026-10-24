import type { IntentRecord } from './sync-state-store.js';

/**
 * B-06: a native result the person has not decided about. Cancelling the wait is that decision and closes it, but
 * the intent keeps `nativeResult: 'result_unknown'` for diagnostics, so every reader must use this one definition.
 * The Session-renewal pre-check and the atomic recheck inside the store each had their own copy; the recheck forgot
 * the cancellation, so after a cancel every renewal froze, rebased and then threw `session_handoff_pending` forever.
 */
export function holdsNativeResultUnknown(
  intent: Pick<IntentRecord, 'nativeWaitDecision' | 'nativeResult' | 'waitReason'>): boolean {
  return intent.nativeWaitDecision?.action !== 'cancel'
    && (intent.nativeResult === 'result_unknown' || intent.waitReason === 'native_result_unknown');
}

/** Shared by issue readers and native-wait UI; cancellation/committed events close the wait. */
export function projectUnresolvedNativeWait(intent: IntentRecord, eventState?: unknown): boolean {
  return intent.nativeWaitDecision?.action !== 'cancel'
    && (intent.nativeResult === 'result_unknown' || intent.waitReason === 'native_result_unknown'
      || intent.nativeResult === 'waiting_dependency')
    && (eventState === undefined || String(eventState) === 'awaiting_confirmation');
}
