import type { IntentRecord } from './sync-state-store.js';
/** Shared by issue readers and native-wait UI; cancellation/committed events close the wait. */
export function projectUnresolvedNativeWait(intent: IntentRecord, eventState?: unknown): boolean {
  return intent.nativeWaitDecision?.action !== 'cancel'
    && (intent.nativeResult === 'result_unknown' || intent.waitReason === 'native_result_unknown'
      || intent.nativeResult === 'waiting_dependency')
    && (eventState === undefined || String(eventState) === 'awaiting_confirmation');
}
