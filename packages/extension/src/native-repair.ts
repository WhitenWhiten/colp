/**
 * Reentrant repair of started-without-receipt creates. Original cursor stays;
 * orphan natives are candidates only.
 */
import { intentOwnerKey } from './native-call-result.js';
import { hasTerminalDeleteEvidence } from './native-delete-executor.js';
import { pageV15Backfill } from './sync-state/v15-backfill.js';
import { scopeKey } from './sync-state/scope-key.js';
import { repairTombstonedNativeMappings } from './tombstone-mapping-repair.js';
import { repairWronglyAckedUnmountedRestore } from './unmounted-restore-repair.js';
import { repairUnmountedRangeMappings } from './unmounted-range-repair.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type { IntentRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'open' | 'listApplyIntents' | 'persistApplyIntentFacts' | 'getApplyIntent'
  | 'getScope' | 'getPullEvent' | 'listPullEvents'
  | 'listMappings' | 'listProjectionIntents' | 'listLocalSyncExclusions'
  | 'createApplyIntent' | 'findApplyIntent' | 'markPullBrowserCallStarted'
  | 'recordPullApiEvidence' | 'getMappingByNativeId' | 'listRemoteObservations'
  | 'commitTombstoneMappingRepair' | 'getLocalSyncExclusion' | 'putLocalSyncExclusion' | 'deleteMapping' | 'putMapping'
  | 'putScopeDiagnostic' | 'listMountBindings' | 'registerScope' | 'getEngineState' | 'transitionEngine'>;

const OPEN_STATES = new Set(['browser_call_started', 'native_event_observed', 'awaiting_confirmation']);

export async function repairNativeSideEffects(store: Store, scope: SyncScope,
  api?: PullBookmarkApi): Promise<{ readonly repaired: number; readonly waiting: number }> {
  await pageV15Backfill({ open: () => store.open() });
  const intents = await store.listApplyIntents(scope);
  let repaired = 0; let waiting = 0;
  for (const intent of intents) {
    if (intent.nativeWaitDecision?.action === 'cancel') continue;
    const jobId = `repair:native:${intent.intentId}`;
    if (intent.repairJobId === jobId && intent.nativeResult === 'applied_with_evidence') continue;
    if (hasReliableReceipt(intent)) {
      if (intent.nativeResult !== 'applied_with_evidence' || intent.waitReason) {
        await store.persistApplyIntentFacts(scope, intent.intentId, {
          nativeResult: 'applied_with_evidence', waitReason: null, replayState: 'committed',
          repairJobId: jobId,
          // Older repair runs re-opened these completed delete events as unknown
          // creates. Their full member receipts and committed intent restore the
          // original event state without repeating any native deletion.
          ...(hasTerminalDeleteEvidence(intent) && intent.eventId
            && (intent.state === 'authority_committed' || intent.state === 'page_complete')
            ? { eventState: intent.state } : {}),
        });
        repaired += 1;
      }
      continue;
    }
    // A delete retries fixed member ids through classified absence checks. It
    // never needs the user to identify a newly created native bookmark.
    if (intent.liveWorkKind === 'delete') {
      if (intent.nativeResult === 'result_unknown' && intent.waitReason === 'native_result_unknown'
          && (intent.state === 'browser_call_started' || intent.state === 'native_event_observed')) {
        await store.persistApplyIntentFacts(scope, intent.intentId, {
          nativeResult: 'not_started', waitReason: null, replayState: 'started',
          nativeResultConfirmation: null, repairJobId: null,
          ...(intent.eventId ? { eventState: intent.state } : {}),
        });
        repaired += 1;
      }
      continue;
    }
    if (!needsUnknownWait(intent)) continue;
    if (intent.repairJobId === jobId && intent.nativeResult === 'result_unknown') { waiting += 1; continue; }
    const waitRef = intent.nativeResultConfirmation?.code
      ?? `nwr:${intent.intentId}:${intent.generation ?? scope.generation}:repair`;
    await store.persistApplyIntentFacts(scope, intent.intentId, {
      nativeResult: 'result_unknown', waitReason: 'native_result_unknown', replayState: 'awaiting_receipt',
      nativeResultConfirmation: { kind: 'unknown', code: waitRef },
      repairJobId: jobId, eventState: intent.eventId ? 'awaiting_confirmation' : undefined,
    });
    waiting += 1;
  }
  void api;
  return { repaired, waiting };
}

export async function recoverPendingNativeSideEffects(store: Store, scope: SyncScope,
  api?: PullBookmarkApi): Promise<void> {
  await repairNativeSideEffects(store, scope, api);
  await repairTombstonedNativeMappings(store, scope, api);
  await repairWronglyAckedUnmountedRestore(store, scope);
  await repairUnmountedRangeMappings(store as ReturnType<typeof createSyncStateStore>, scope, api);
  const intents = await store.listApplyIntents(scope);
  for (const intent of intents) {
    if (!hasReliableReceipt(intent) || intent.nativeResult === 'applied_with_evidence') continue;
    await store.persistApplyIntentFacts(scope, intent.intentId, {
      nativeResult: 'applied_with_evidence', waitReason: null, replayState: 'committed',
    });
  }
}

export function hasPendingNativeOrPull(input: {
  readonly stagedPullPages: number;
  readonly incompletePullEvents: number;
  readonly unknownIntents: number;
}): boolean {
  return input.stagedPullPages > 0 || input.incompletePullEvents > 0 || input.unknownIntents > 0;
}

export async function pendingNativeOrPullFacts(store: Pick<Store, 'listApplyIntents' | 'listPullEvents'> & {
  listPullPages(scope: SyncScope, states?: readonly string[]): Promise<readonly unknown[]>;
}, scope: SyncScope): Promise<{
  readonly pendingIncompletePull: boolean; readonly nativeResultUnknown: boolean;
}> {
  const [pages, events, intents] = await Promise.all([
    store.listPullPages(scope, ['staged']),
    store.listPullEvents(scope, ['staged', 'intent_prepared', 'browser_call_started', 'native_event_observed',
      'awaiting_confirmation']),
    store.listApplyIntents(scope),
  ]);
  return {
    pendingIncompletePull: pages.length > 0 || events.length > 0,
    nativeResultUnknown: intents.some((intent: IntentRecord) => intent.nativeWaitDecision?.action !== 'cancel'
      && (intent.nativeResult === 'result_unknown' || intent.waitReason === 'native_result_unknown')),
  };
}

function hasReliableReceipt(intent: IntentRecord): boolean {
  return hasTerminalDeleteEvidence(intent) || typeof intent.apiResultEvidence?.nativeId === 'string'
    || intent.nativeResultConfirmation?.kind === 'api_return' && typeof intent.nativeResultConfirmation.nativeId === 'string';
}

/**
 * S1 / B0-1: a user confirmation (`bind` / `keep_local_and_create`) is the
 * receipt for this create — the candidate native *is* the landing. Re-opening
 * it here would re-park Ack on a wait the user already decided
 * (`commitUserNative` leaves `replayState: 'awaiting_receipt'` on purpose).
 */
function confirmedByUser(intent: IntentRecord): boolean {
  return intent.nativeResultConfirmation?.kind === 'candidate_event';
}

function needsUnknownWait(intent: IntentRecord): boolean {
  if (intent.nativeResult === 'not_started' && intent.replayState === 'not_started') return false;
  if (hasReliableReceipt(intent)) return false;
  if (confirmedByUser(intent)) return false;
  if (intent.nativeResult === 'result_unknown') return true;
  if (OPEN_STATES.has(String(intent.state))) return true;
  return intent.replayState === 'started' || intent.replayState === 'awaiting_receipt';
}

export function repairOwnerKey(intent: IntentRecord, scope: SyncScope): string {
  return intentOwnerKey({
    scopeKey: scopeKey(scope), generation: intent.generation ?? scope.generation,
    commandId: intent.commandId ?? 'repair', eventId: intent.eventId ?? intent.intentId,
    colpId: intent.colpId ?? intent.expected.nativeId, substep: intent.substep ?? 'repair',
  });
}
