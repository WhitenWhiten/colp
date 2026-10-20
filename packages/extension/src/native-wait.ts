import { projectUnresolvedNativeWait } from './native-wait-open.js';
/**
 * Unified native-result wait. User choice is confirmation CAS, never a
 * forged Chrome API receipt.
 */
import { collectNativeOccupancy, executeNativeCreate, type NativeWaitProjection } from './native-create-executor.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import { validNativeWaitTarget } from './native-wait-target.js';
import { confirmMaterializationWait, observedNativeWaitCandidate } from './native-wait-materialization.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { IntentRecord, MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = NativeWaitStore;

/** The store surface the wait projection/confirmation needs (exported so the SW handler can inject it). */
export type NativeWaitStore = Pick<ReturnType<typeof createSyncStateStore>,
  'getApplyIntent' | 'persistApplyIntentFacts' | 'listApplyIntents' | 'getScope'
  | 'listMountBindings' | 'getMappingByColpId' | 'putMapping' | 'listMappings'
  | 'listProjectionIntents' | 'listLocalSyncExclusions' | 'createApplyIntent'
  | 'findApplyIntent' | 'getPullEvent' | 'markPullBrowserCallStarted' | 'recordPullApiEvidence'
  | 'getMappingByNativeId' | 'getLocalSyncExclusion' | 'listPullEvents'>
  & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'listNativeWaitIntents'>>;

export type ConfirmNativeWaitAction = 'bind' | 'keep_local_and_create' | 'cancel';

export interface ConfirmNativeWaitInput {
  readonly scope: SyncScope;
  readonly store: Store;
  readonly waitRef: string;
  readonly intentId: string;
  readonly generation: number;
  readonly action: ConfirmNativeWaitAction;
  readonly nativeId?: string;
  readonly permissionGranted?: boolean;
  readonly api?: PullBookmarkApi;
  readonly create?: () => Promise<{ readonly id: string }>;
  /** Live-authority check re-run before the confirm commits a native mutation. */
  readonly assertCurrent?: () => Promise<void>;
}

export type ConfirmNativeWaitResult =
  | { readonly ok: true; readonly result: 'bound' | 'kept_local' | 'cancelled' | 'duplicate'; readonly nativeId?: string }
  | { readonly ok: false; readonly code: 'stale_ref' | 'account_switch' | 'detached' | 'revoked'
    | 'generation_mismatch' | 'native_result_cas' | 'request_invalid' | 'intent_not_found' };

/**
 * Waits the user still has to decide on. The list mirrors the engine's park
 * predicate (`listPullEvents(scope, ['awaiting_confirmation'])`): once a
 * confirmation settles the pull event, the item leaves the list while the
 * durable intent facts retain the user decision and any real API receipt.
 */
export async function projectNativeWaits(store: Store, scope: SyncScope): Promise<readonly NativeWaitProjection[]> {
  const intents = await (store.listNativeWaitIntents?.(scope) ?? store.listApplyIntents(scope));
  const waits: NativeWaitProjection[] = [];
  for (const intent of intents) {
    const event = intent.eventId ? await store.getPullEvent(scope, intent.eventId) : undefined;
    if (!projectUnresolvedNativeWait(intent, event?.state)) continue;
    const waitRef = intent.nativeResultConfirmation?.code ?? `nwr:${intent.intentId}`;
    const info = await resolveIntentNodeInfo(store, scope, intent);
    waits.push({
      waitRef, intentId: intent.intentId, colpId: intent.colpId ?? '',
      ...(info.title ? { title: info.title } : {}),
      ...(info.url ? { url: info.url } : {}),
      waitReason: intent.nativeResult === 'waiting_dependency' ? 'waiting_dependency' : 'native_result_unknown',
      candidates: confirmationCandidates(intent),
      affectedRange: { parentNativeId: intent.nativeParentId ?? '' },
    });
  }
  return waits;
}

async function resolveIntentNodeInfo(store: Store, scope: SyncScope, intent: IntentRecord): Promise<{ title?: string; url?: string }> {
  if (!intent.eventId) return {};
  try {
    const event = await store.getPullEvent(scope, intent.eventId);
    const effect = (event?.payload as { readonly effect?: unknown } | undefined)?.effect;
    const node = (effect as { readonly node?: unknown } | undefined)?.node;
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const title = typeof (node as { title?: unknown }).title === 'string' ? (node as { title: string }).title : undefined;
      const url = typeof (node as { url?: unknown }).url === 'string' ? (node as { url: string }).url : undefined;
      return { title, url };
    }
  } catch { /* best effort */ }
  return {};
}

export async function confirmNativeWait(input: ConfirmNativeWaitInput): Promise<ConfirmNativeWaitResult> {
  if (input.permissionGranted === false) return { ok: false, code: 'revoked' };
  const recorded = await input.store.getScope(input.scope);
  if (recorded && scopeKey(recorded) !== scopeKey(input.scope)) return { ok: false, code: 'account_switch' };
  const mounts = await input.store.listMountBindings(input.scope);
  if (mounts.length > 0 && mounts.every((row: MountBindingRecord) => row.status === 'detached')) {
    return { ok: false, code: 'detached' };
  }
  const intent = await input.store.getApplyIntent(input.scope, input.intentId);
  if (!intent) return { ok: false, code: 'intent_not_found' };
  if (intent.generation !== input.generation) return { ok: false, code: 'generation_mismatch' };
  if (alreadyResolved(intent, input)) {
    return { ok: true, result: 'duplicate', ...(resolvedNativeId(intent) ? { nativeId: resolvedNativeId(intent) } : {}) };
  }
  if (intent.nativeWaitDecision?.action === 'cancel') return { ok: false, code: 'native_result_cas' };
  if (intent.nativeResultConfirmation?.code !== input.waitRef) return { ok: false, code: 'stale_ref' };
  try {
    if (input.action === 'cancel') {
      await input.store.persistApplyIntentFacts(input.scope, input.intentId, {
        expectedWaitRef: input.waitRef, expectedGeneration: input.generation,
        expectedNativeResult: 'result_unknown',
        nativeWaitDecision: { action: 'cancel', waitRef: input.waitRef },
        replayState: 'committed', waitReason: null,
        // Cancellation is a durable user decision, not a fabricated Chrome receipt.
        // Retain the original unknown fact for diagnostics; repair and pending-work
        // readers exclude cancelled decisions and stale pages cannot reopen them.
        eventState: 'authority_committed',
      });
      return { ok: true, result: 'cancelled' };
    }
    const materialization = await confirmMaterializationWait(input, intent);
    if (materialization) return materialization;
    if (input.action === 'bind') return await bindCandidate(input, intent, mounts);
    return await keepLocalAndCreate(input, intent);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'stale_ref' || code === 'generation_mismatch' || code === 'native_result_cas') {
      return { ok: false, code };
    }
    throw error;
  }
}

function alreadyResolved(intent: IntentRecord, input: ConfirmNativeWaitInput): boolean {
  const nativeId = resolvedNativeId(intent);
  if (intent.nativeWaitDecision?.action === input.action && intent.nativeWaitDecision.waitRef === input.waitRef
      && (input.action === 'cancel' || input.action === 'keep_local_and_create' && nativeId)) return true;
  if (input.action === 'bind' && nativeId && nativeId === input.nativeId) return true;
  if (input.action === 'cancel' && intent.nativeResult === 'result_unknown'
      && intent.nativeResultConfirmation?.code === input.waitRef) return false;
  return intent.nativeResultConfirmation?.kind === 'candidate_event' && nativeId === input.nativeId;
}

function resolvedNativeId(intent: IntentRecord): string | undefined {
  if (intent.nativeResultConfirmation?.kind === 'candidate_event'
      || intent.nativeResultConfirmation?.kind === 'api_return') return intent.nativeResultConfirmation.nativeId;
  const apiId = intent.apiResultEvidence?.nativeId;
  return typeof apiId === 'string' ? apiId : undefined;
}

async function bindCandidate(input: ConfirmNativeWaitInput, intent: IntentRecord,
  mounts: readonly MountBindingRecord[]): Promise<ConfirmNativeWaitResult> {
  if (!input.nativeId || !await validNativeWaitTarget(input, intent, mounts)) return { ok: false, code: 'request_invalid' };
  const occupancy = await collectNativeOccupancy(input.store, input.scope);
  const owner = occupancy.get(input.nativeId);
  if (owner !== undefined && owner !== intent.colpId) return { ok: false, code: 'request_invalid' };
  await commitUserNative(input, intent, mounts, input.nativeId);
  return { ok: true, result: 'bound', nativeId: input.nativeId };
}

async function keepLocalAndCreate(input: ConfirmNativeWaitInput,
  intent: IntentRecord): Promise<ConfirmNativeWaitResult> {
  if (!input.api || !input.create || !intent.colpId || !intent.nativeParentId) {
    return { ok: false, code: 'request_invalid' };
  }
  // EXT-01: refuse before any durable claim or Chrome call when the authority
  // moved while the user was deciding. The intent then stays result-unknown and
  // replayable by the current identity instead of being consumed by a dead one.
  await input.assertCurrent?.();
  // Claim the original wait atomically BEFORE touching Chrome. Reuse its durable
  // create intent: a crash at any later boundary resumes through the ordinary
  // applier, including the result-unknown wait when a receipt was lost.
  await input.store.persistApplyIntentFacts(input.scope, input.intentId, {
    expectedWaitRef: input.waitRef, expectedGeneration: input.generation, expectedNativeResult: 'result_unknown',
    nativeWaitDecision: { action: 'keep_local_and_create', waitRef: input.waitRef },
    nativeResult: 'not_started', replayState: 'not_started', state: 'intent_prepared',
    eventState: 'intent_prepared', apiResultEvidence: null, nativeEventEvidence: null,
    nativeResultConfirmation: null, waitReason: null,
  });
  const outcome = await executeNativeCreate({
    scope: input.scope, store: input.store, api: input.api, intentId: input.intentId,
    owner: { scopeKey: scopeKey(input.scope), generation: input.generation,
      commandId: intent.commandId ?? 'pull', eventId: intent.eventId ?? intent.intentId,
      colpId: intent.colpId, substep: intent.substep ?? 'create' },
    parentNativeId: intent.nativeParentId, expected: {}, create: input.create, liveWorkKind: 'create',
  });
  if (outcome.result !== 'applied_with_evidence') return { ok: false, code: 'request_invalid' };
  await putConfirmedMapping(input, intent, await input.store.listMountBindings(input.scope), outcome.nativeId);
  return { ok: true, result: 'kept_local', nativeId: outcome.nativeId };
}

async function commitUserNative(input: ConfirmNativeWaitInput, intent: IntentRecord,
  mounts: readonly MountBindingRecord[], nativeId: string): Promise<void> {
  await input.store.persistApplyIntentFacts(input.scope, input.intentId, {
    expectedWaitRef: input.waitRef, expectedGeneration: input.generation,
    expectedNativeResult: 'result_unknown', nativeResult: 'applied_with_evidence',
    nativeResultConfirmation: { kind: 'candidate_event', nativeId },
    nativeWaitDecision: { action: 'bind', waitRef: input.waitRef },
    waitReason: null, replayState: 'awaiting_receipt', eventState: 'browser_call_started',
  });
  await putConfirmedMapping(input, intent, mounts, nativeId);
}

async function putConfirmedMapping(input: ConfirmNativeWaitInput, intent: IntentRecord,
  mounts: readonly MountBindingRecord[], nativeId: string): Promise<void> {
  if (!intent.colpId) return;
  const existing = await input.store.getMappingByColpId(input.scope, intent.colpId);
  const rootNativeId = existing?.rootNativeId ?? mounts[0]?.nativeRootId ?? intent.nativeParentId ?? nativeId;
  const { scopeKey: _scopeKey, ...prior } = existing ?? {} as { scopeKey?: string };
  const mapping: MappingInput = {
    ...prior, nativeId, colpId: intent.colpId, rootNativeId,
    ...(intent.nativeParentId ? { parentNativeId: intent.nativeParentId } : {}),
    projection: existing?.projection ?? { revision: 'confirm-native', digest: `sha256:${intent.colpId}` },
  };
  await input.store.putMapping(input.scope, mapping);
}

function confirmationCandidates(intent: IntentRecord): NativeWaitProjection['candidates'] {
  const nativeId = intent.nativeResultConfirmation?.nativeId ?? observedNativeWaitCandidate(intent);
  return nativeId ? [{ nativeId }] : [];
}
