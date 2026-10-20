import { SyncFailureError } from './sync-failure-class.js';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { JsonObject, IntentRecord, MappingInput, RemoteObservationRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { PullApplierOptions, PullBookmarkApi, PullNode } from './pull-applier-types.js';
import { classifyBookmarkApiFailure } from './bookmark-api-error.js';
import { executePullNativeCreate } from './pull-create-evidence.js';
import { digest } from './pull-codec.js';
import { chromeCreate, mappingFor, nodeContent, nodeCreate } from './pull-projection.js';
import {
  boundNativeId, isNonChromeNativeId, planRestored, unmountedNativeId,
} from './pull-mount-apply.js';
import { currentPullMapping } from './pull-mapping-view.js';
import { createCheckedPullNative } from './pull-native-create-boundary.js';
import { NativeWriteNotStartedError } from './native-call-result.js';

const INTENT_TTL_MS = 5 * 60_000;

type Store = ReturnType<typeof createSyncStateStore>;
type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;

export async function materializeRestoredNode(input: {
  readonly eventId: string; readonly event: OpEvent; readonly store: Store; readonly api: PullBookmarkApi;
  readonly options: PullApplierOptions; readonly scope: SyncScope; readonly generation: number;
  readonly separatorPolicy: string | undefined; readonly now: () => number;
  readonly nativeIndex: (afterId: string | null, beforeId: string | null) => Promise<number>;
  readonly parentRevisionMapping: (revision: { readonly parentId: string; readonly childrenRevision: string }) => Promise<MappingInput>;
}): Promise<{ readonly mappings: MappingInput[]; readonly deleteNativeIds: readonly string[];
  readonly observations: readonly Omit<RemoteObservationRecord, 'scopeKey'>[] }> {
  const effect = input.event.effect;
  if (effect.kind !== 'node_restored') throw new SyncFailureError('pull_effect_kind_invalid');
  const observations = [restoredObservation(input.event, input.now())];
  const plan = await planRestored(input.store, input.scope, effect.placement.parentId);
  if (plan.kind === 'need_authority') throw new SyncFailureError('need_authority');
  if (plan.kind === 'skip_unmounted') {
    const mapping = mappingFor(effect.node, unmountedNativeId(effect.node.id), unmountedNativeId(effect.placement.parentId),
      effect.placement.parentId, null, unmountedNativeId(effect.placement.parentId));
    const extra = await input.parentRevisionMapping(effect.parentRevision).catch(() => null);
    return { mappings: extra ? [mapping, extra] : [mapping], deleteNativeIds: [], observations };
  }
  const mounts = await input.store.listMountBindings(input.scope);
  const recorded = await currentPullMapping(input.store, input.scope, effect.placement.parentId);
  if (!recorded) throw new SyncFailureError('need_authority');
  const parentNativeId = boundNativeId(recorded, mounts);
  if (isNonChromeNativeId(parentNativeId)) throw new SyncFailureError('need_authority');
  const parent = stripScope(parentNativeId === recorded.nativeId ? recorded
    : { ...recorded, nativeId: parentNativeId, rootNativeId: parentNativeId });
  const rest = await restoreParentRevision(effect.parentRevision, parent, [], input.parentRevisionMapping);
  const node = nodeCreate(effect.node);
  const sidecar = effect.node.kind === 'separator' && input.separatorPolicy === 'preserve_remote';
  const nativeId = sidecar ? `sidecar:${effect.node.id}` : await restoredChromeId(input, parent.nativeId, node);
  const priorNativeId = (await input.store.getMappingByColpId(input.scope, effect.node.id))?.nativeId;
  return { mappings: [mappingFor(effect.node, nativeId, parent.nativeId, parent.colpId ?? effect.placement.parentId,
    null, parent.rootNativeId), ...rest], deleteNativeIds: priorNativeId && priorNativeId !== nativeId ? [priorNativeId] : [],
  observations };
}

function restoredObservation(event: OpEvent, observedAt: number): Omit<RemoteObservationRecord, 'scopeKey'> {
  const effect = event.effect;
  if (effect.kind !== 'node_restored') throw new SyncFailureError('pull_effect_kind_invalid');
  return {
    colpId: effect.node.id, remoteRevision: effect.node.revision, cursor: event.cursor, kind: 'content',
    payload: { ...nodeContent(effect.node), parentId: effect.placement.parentId,
      afterId: effect.placement.afterId, beforeId: effect.placement.beforeId },
    sourceDigest: effect.effectDigest, observedAt,
  };
}

async function restoreParentRevision(revision: { readonly parentId: string; readonly childrenRevision: string },
  parent: MappingInput, extra: readonly MappingInput[],
  parentRevisionMapping: (revision: { readonly parentId: string; readonly childrenRevision: string }) => Promise<MappingInput>,
): Promise<MappingInput[]> {
  if (extra.length > 0) {
    return extra.map((mapping) => ({ ...mapping, projection: { ...mapping.projection,
      childrenRevision: revision.childrenRevision } }));
  }
  try { return [await parentRevisionMapping(revision)]; }
  catch {
    return [{ ...parent, projection: { ...parent.projection, childrenRevision: revision.childrenRevision } }];
  }
}

async function reserveRestoreCreateEcho(input: {
  readonly eventId: string; readonly event: OpEvent; readonly store: Store; readonly api: PullBookmarkApi;
  readonly scope: SyncScope; readonly generation: number; readonly now: () => number;
}, parentNativeId: string, node: JsonObject): Promise<void> {
  const children = await input.api.getChildren(parentNativeId);
  const correlationId = restoreCreateCorrelation(parentNativeId, node);
  try {
    await input.store.createApplyIntent(input.scope, {
      intentId: `intent:${input.eventId}:${correlationId.slice(7, 23)}`, correlationId,
      operationId: input.event.operation.opId, eventId: input.eventId, effectId: input.event.effect.effectId,
      expected: { kind: 'create', nativeId: `pending:${input.event.effect.effectId}` },
      anchors: { beforeNativeIds: children.map((child) => child.id) }, nativeParentId: parentNativeId,
      preStateDigest: digest(children), expiresAt: input.now() + INTENT_TTL_MS, state: 'intent_prepared',
      generation: input.generation, nativeResult: 'not_started', replayState: 'not_started',
    });
  } catch { /* Prepared restore intent already owns this correlation. */ }
}

type RestoreCall = {
  readonly eventId: string; readonly event: OpEvent; readonly store: Store; readonly api: PullBookmarkApi;
  readonly options: PullApplierOptions; readonly scope: SyncScope; readonly generation: number;
  readonly now: () => number;
  readonly nativeIndex: (afterId: string | null, beforeId: string | null) => Promise<number>;
};
type RestorePhase = { readonly kind: 'not_called' } | { readonly kind: 'unknown' }
  | { readonly kind: 'applied'; readonly nativeId: string | undefined }
  | { readonly kind: 'failed'; readonly code: string };

/**
 * Reconfirm placement before Chrome create. A legal start (no anchor) may use 0.
 * An anchor read failure must not. A call that already started is unknown, not not-called,
 * and is not created again.
 */
async function restoredChromeId(input: RestoreCall, parentNativeId: string, node: JsonObject): Promise<string> {
  const phase = await restorePhase(input, parentNativeId, node);
  if (phase.kind === 'applied') {
    if (!phase.nativeId) throw new SyncFailureError('native_result_unknown');
    return phase.nativeId;
  }
  if (phase.kind === 'unknown') throw new SyncFailureError('native_result_unknown');
  if (phase.kind === 'failed') {
    if (isPermissionFailure(phase.code)) await input.store.setBrowserRootStatus(input.scope, 'permission_required');
    throw new Error(phase.code);
  }
  await reserveRestoreCreateEcho(input, parentNativeId, node);
  const index = await confirmedRestoreIndex(input, parentNativeId, node);
  return createRestoredNative(input, parentNativeId, inputNode(input), index);
}

async function confirmedRestoreIndex(input: RestoreCall, parentNativeId: string, node: JsonObject): Promise<number> {
  try { return await restoreIndex(input); }
  catch (error) {
    if (isWorkerCrash(error)) throw error;
    const outcome = await cancelUncalledRestore(input, parentNativeId, node, placementCode(error));
    if (isPermissionFailure(error)) await input.store.setBrowserRootStatus(input.scope, 'permission_required');
    if (outcome === 'unknown') {
      await noteStartedCreate(input, error);
      throw new Error(isPermissionFailure(error) ? 'permission_required' : 'native_result_unknown');
    }
    throw placementError(error);
  }
}

async function restorePhase(input: RestoreCall, parentNativeId: string, node: JsonObject): Promise<RestorePhase> {
  const event = await input.store.getPullEvent(input.scope, input.eventId);
  const eventState = event ? String(event.state) : '';
  const pull = await input.store.getApplyIntent(input.scope, `intent:${input.eventId}`);
  const reserved = await input.store.findApplyIntent(input.scope, restoreCreateCorrelation(parentNativeId, node)) as IntentRecord | null;
  return stricterPhase([phaseOf(pull ?? null, eventState), phaseOf(reserved, eventState)]);
}

function stricterPhase(phases: readonly RestorePhase[]): RestorePhase {
  const applied = phases.find((phase) => phase.kind === 'applied' && phase.nativeId);
  if (applied) return applied;
  if (phases.some((phase) => phase.kind === 'unknown' || phase.kind === 'applied')) return { kind: 'unknown' };
  const failed = phases.find((phase) => phase.kind === 'failed');
  return failed ?? { kind: 'not_called' };
}

function phaseOf(intent: IntentRecord | null, eventState: string): RestorePhase {
  const started = browserCallStarted(eventState, intent);
  if (intent?.nativeResult === 'applied_with_evidence') return { kind: 'applied', nativeId: evidencedNativeId(intent) };
  const nativeId = intent ? evidencedNativeId(intent) : undefined;
  if (nativeId && intent?.nativeResult !== 'failed' && intent?.nativeResult !== 'result_unknown'
      && intent?.nativeResult !== 'unknown') return { kind: 'applied', nativeId };
  if (intent?.nativeResult === 'failed') {
    return { kind: 'failed', code: intent.nativeResultConfirmation?.code ?? 'native_call_failed' };
  }
  if (started || intent?.nativeResult === 'result_unknown' || intent?.nativeResult === 'unknown') return { kind: 'unknown' };
  return { kind: 'not_called' };
}

function browserCallStarted(eventState: string, intent: IntentRecord | null): boolean {
  if (eventState === 'browser_call_started' || eventState === 'native_event_observed'
      || eventState === 'awaiting_confirmation') return true;
  if (!intent) return false;
  return intent.replayState === 'started' || intent.replayState === 'awaiting_receipt'
    || intent.state === 'browser_call_started' || intent.state === 'native_event_observed'
    || intent.state === 'awaiting_confirmation';
}

function evidencedNativeId(intent: IntentRecord): string | undefined {
  const evidence = intent.apiResultEvidence?.nativeId;
  if (typeof evidence === 'string' && evidence.length > 0) return evidence;
  const confirmed = intent.nativeResultConfirmation?.kind === 'api_return'
      || intent.nativeResultConfirmation?.kind === 'candidate_event'
    ? intent.nativeResultConfirmation.nativeId : undefined;
  return typeof confirmed === 'string' && confirmed.length > 0 ? confirmed : undefined;
}

/** No anchor is index 0. A named anchor that cannot be read is a failure, never 0. */
async function restoreIndex(input: RestoreCall): Promise<number> {
  const effect = input.event.effect;
  if (effect.kind !== 'node_restored') throw new SyncFailureError('pull_effect_kind_invalid');
  if (!effect.placement.afterId && !effect.placement.beforeId) return 0;
  return input.nativeIndex(effect.placement.afterId, effect.placement.beforeId);
}

/**
 * Not-called: cancel create evidence and the reserved echo, and revert the command to staged
 * so the call fact is not_called. A started call is left unknown and is not rewritten as not-called.
 */
async function cancelUncalledRestore(input: RestoreCall, parentNativeId: string, node: JsonObject,
  code: string): Promise<'not_called' | 'unknown'> {
  const event = await input.store.getPullEvent(input.scope, input.eventId);
  const eventState = event ? String(event.state) : '';
  const pull = await input.store.getApplyIntent(input.scope, `intent:${input.eventId}`);
  const reserved = await input.store.findApplyIntent(input.scope, restoreCreateCorrelation(parentNativeId, node)) as IntentRecord | null;
  const seen = new Set<string>();
  let started = false;
  for (const intent of [pull ?? null, reserved]) {
    if (!intent || seen.has(intent.intentId)) continue;
    seen.add(intent.intentId);
    if (phaseOf(intent, eventState).kind !== 'not_called') { started = true; continue; }
    const ownsEvent = intent.eventId === input.eventId && intent.intentId === `intent:${input.eventId}`;
    await input.store.persistApplyIntentFacts(input.scope, intent.intentId, {
      nativeResult: 'not_started', replayState: 'not_started', apiResultEvidence: null, nativeEventEvidence: null,
      ...(ownsEvent ? { state: 'staged', eventState: 'staged' } : { state: 'blocked' }),
    });
  }
  if (started || browserCallStarted(eventState, null)) return 'unknown';
  await input.store.putScopeDiagnostic(input.scope, { kind: 'restore_create_not_called', code,
    details: { eventId: input.eventId, browserCalled: false } });
  return 'not_called';
}

async function noteStartedCreate(input: RestoreCall, error: unknown): Promise<void> {
  const event = await input.store.getPullEvent(input.scope, input.eventId);
  const eventState = event ? String(event.state) : '';
  const intent = await input.store.getApplyIntent(input.scope, `intent:${input.eventId}`);
  const lied = !!intent && intent.nativeResult !== 'failed' && intent.nativeResult !== 'applied_with_evidence'
    && intent.nativeResult !== 'result_unknown' && intent.nativeResult !== 'unknown'
    && (intent.nativeResult === 'not_started' || intent.nativeResult === undefined
      || intent.replayState === 'not_started' || intent.replayState === undefined);
  if (intent && lied && browserCallStarted(eventState, intent)) {
    await input.store.persistApplyIntentFacts(input.scope, intent.intentId, {
      nativeResult: 'result_unknown', replayState: 'awaiting_receipt',
    });
  }
  if (isPermissionFailure(error)) await input.store.setBrowserRootStatus(input.scope, 'permission_required');
}

function placementCode(error: unknown): string {
  if (isPermissionFailure(error)) return 'permission_required';
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)) return error.message;
  return 'anchor_read_failed';
}

function placementError(error: unknown): Error {
  const code = placementCode(error);
  return error instanceof Error && error.message === code ? error : new Error(code);
}

function isPermissionFailure(error: unknown): boolean {
  if (typeof error === 'string') return error === 'permission_required' || error === 'permission_revoked';
  if (!(error instanceof Error)) return false;
  return error.message === 'permission_required' || error.message === 'permission_revoked'
    || classifyBookmarkApiFailure(error) === 'permission_denied';
}

function isWorkerCrash(error: unknown): boolean {
  return error instanceof Error && error.message === 'worker_crash';
}

function inputNode(input: RestoreCall): PullNode {
  const effect = input.event.effect;
  if (effect.kind !== 'node_restored') throw new SyncFailureError('pull_effect_kind_invalid');
  return effect.node;
}

async function createRestoredNative(input: RestoreCall, parentNativeId: string, node: PullNode, index: number): Promise<string> {
  const effect = input.event.effect;
  if (effect.kind !== 'node_restored') throw new SyncFailureError('pull_effect_kind_invalid');
  const phase = await restorePhase(input, parentNativeId, nodeCreate(node));
  if (phase.kind === 'applied') {
    if (!phase.nativeId) throw new SyncFailureError('native_result_unknown');
    return phase.nativeId;
  }
  if (phase.kind !== 'not_called') {
    throw new Error(phase.kind === 'failed' ? phase.code : 'native_result_unknown');
  }
  const payload = nodeCreate(node);
  let recovered: Awaited<ReturnType<typeof executePullNativeCreate>>;
  try {
    recovered = await executePullNativeCreate(input.options, input.api, input.event, parentNativeId,
      input.eventId, () => createCheckedPullNative({ ...input, parentColpId: effect.placement.parentId, placement: effect.placement,
        details: { parentId: parentNativeId, index, ...chromeCreate(node) } }),
      node.id);
  } catch (error) {
    if (isWorkerCrash(error) || error instanceof NativeWriteNotStartedError) throw error;
    await noteStartedCreate(input, error);
    throw error;
  }
  if (recovered.result !== 'applied_with_evidence') {
    const code = recovered.result === 'failed' ? recovered.code : 'native_result_unknown';
    await noteStartedCreate(input, new Error(code));
    throw new Error(code);
  }
  await recordRestoreCreateEvidence(input, parentNativeId, payload, recovered.nativeId);
  return recovered.nativeId;
}

async function recordRestoreCreateEvidence(input: {
  readonly store: Store; readonly scope: SyncScope;
}, parentNativeId: string, node: JsonObject, nativeId: string): Promise<void> {
  const correlationId = restoreCreateCorrelation(parentNativeId, node);
  await input.store.observeApplyIntentEvent(input.scope, correlationId, { eventDigest: correlationId, nativeId });
}

function restoreCreateCorrelation(parentNativeId: string, node: JsonObject): string {
  return digest({ kind: 'create', nativeId: '', details: { parentId: parentNativeId, node } });
}

function stripScope(mapping: MappingInput & { readonly scopeKey?: string }): MappingInput {
  const { scopeKey: _scopeKey, ...value } = mapping;
  return value;
}
