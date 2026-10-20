import { SyncFailureError } from './sync-failure-class.js';
/**
 * C-02 native create: persist started, Chrome, then receipt. Callers never
 * treat a missing nativeId as permission to create again.
 */
import {
  classifyNativeCallFacts, intentOwnerKey, type IntentOwnerInput,
} from './native-call-result.js';
import { occupancyByNative, virtualNativeId } from './projection-native-occupancy.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type {
  IntentLiveWorkKind, IntentRecord, JsonObject, MappingInput, NativeCallResult, SyncScope,
  createSyncStateStore,
} from './sync-state-store.js';
import type { LocalSyncExclusionRecord } from './sync-state/remote-delete-repository.js';
import type { ApplyIntentFactsPatch } from './sync-state/intent-facts-repository.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'getApplyIntent' | 'createApplyIntent' | 'findApplyIntent' | 'getPullEvent'
  | 'markPullBrowserCallStarted' | 'recordPullApiEvidence' | 'listMappings'
  | 'listProjectionIntents' | 'listLocalSyncExclusions' | 'getMappingByNativeId'
  | 'persistApplyIntentFacts' | 'listApplyIntents'>;

export interface NativeWaitProjection {
  readonly waitRef: string;
  readonly intentId: string;
  readonly colpId: string;
  readonly title?: string;
  readonly url?: string;
  readonly waitReason: 'native_result_unknown' | 'waiting_dependency';
  readonly candidates: readonly { readonly nativeId: string; readonly title?: string; readonly url?: string }[];
  readonly affectedRange: { readonly parentNativeId: string };
}

export type NativeCreateOutcome =
  | { readonly result: 'applied_with_evidence'; readonly nativeId: string }
  | { readonly result: 'result_unknown'; readonly wait: NativeWaitProjection }
  | { readonly result: 'waiting_dependency'; readonly wait: NativeWaitProjection }
  | { readonly result: 'failed'; readonly code: string }
  | { readonly result: 'absent' };

export interface NativeCreateInput {
  readonly scope: SyncScope;
  readonly store: Store;
  readonly api: Pick<PullBookmarkApi, 'getChildren'>;
  readonly intentId: string;
  readonly owner: IntentOwnerInput;
  readonly parentNativeId: string;
  readonly expected: { readonly title?: string; readonly url?: string };
  readonly create: () => Promise<{ readonly id: string }>;
  readonly operationId?: string;
  readonly liveWorkKind?: IntentLiveWorkKind;
  readonly crash?: (boundary: string) => void;
  readonly now?: () => number;
  readonly permissionGranted?: boolean;
}

export async function collectNativeOccupancy(store: Store, scope: SyncScope): Promise<Map<string, string>> {
  const [live, intents, exclusions, projection] = await Promise.all([
    store.listMappings(scope), store.listApplyIntents(scope),
    store.listLocalSyncExclusions(scope), store.listProjectionIntents(scope),
  ]);
  const occupied = new Map(occupancyByNative({
    liveMappings: live as MappingInput[],
    intents: projection.filter((intent) => intent.state !== 'terminal'),
  }));
  for (const intent of intents) claimIntentNative(occupied, intent);
  for (const row of exclusions as LocalSyncExclusionRecord[]) {
    if (virtualNativeId(row.nativeId) || occupied.has(row.nativeId)) continue;
    occupied.set(row.nativeId, row.priorColpId ?? `exclusion:${row.nativeId}`);
  }
  return occupied;
}

export async function executeNativeCreate(input: NativeCreateInput): Promise<NativeCreateOutcome> {
  if (input.permissionGranted === false) return fail(input, 'permission_revoked');
  let intent = await ensureIntent(input);
  const occupancy = await collectNativeOccupancy(input.store, input.scope);
  const classified = classifyIntent(intent, occupancy, input.owner.colpId);
  if (classified === 'applied_with_evidence') {
    const nativeId = appliedNativeId(intent);
    if (!nativeId) return persistUnknown(input, occupancy);
    const owner = occupancy.get(nativeId);
    if (owner !== undefined && owner !== input.owner.colpId) return persistUnknown(input, occupancy);
    return { result: 'applied_with_evidence', nativeId };
  }
  if (classified === 'result_unknown') return persistUnknown(input, occupancy);
  if (classified === 'waiting_dependency') return persistDependency(input, occupancy);
  if (classified === 'failed') return fail(input, 'native_call_failed');
  if (classified !== 'not_started') return persistUnknown(input, occupancy);

  await persistStarted(input, intent);
  let created: { readonly id: string };
  try { created = await input.create(); }
  catch (error) {
    if (error instanceof Error && error.message === 'worker_crash') throw error;
    if (isPermissionError(error)) return fail(input, 'permission_revoked');
    await patch(input, { replayState: 'not_started', nativeResult: 'not_started' });
    throw error;
  }
  input.crash?.('after_create_before_evidence');
  await persistReceipt(input, created.id);
  input.crash?.('after_evidence_before_mapping');
  input.crash?.('after_api_evidence');
  const after = await collectNativeOccupancy(input.store, input.scope);
  const occupiedBy = after.get(created.id);
  if (occupiedBy !== undefined && occupiedBy !== input.owner.colpId) return persistUnknown(input, after);
  return { result: 'applied_with_evidence', nativeId: created.id };
}

function classifyIntent(intent: IntentRecord, occupancy: ReadonlyMap<string, string>,
  colpId: string): NativeCallResult {
  const apiId = apiReturnId(intent);
  const confirmed = intent.nativeResultConfirmation?.kind === 'candidate_event'
    ? intent.nativeResultConfirmation.nativeId : undefined;
  if (typeof confirmed === 'string' && unoccupiedOrSelf(occupancy, confirmed, colpId)) {
    return 'applied_with_evidence';
  }
  if (intent.nativeResult === 'result_unknown') return 'result_unknown';
  return classifyNativeCallFacts({
    intentExists: true,
    callStarted: callHasStarted(intent),
    ...(apiId ? { apiReturnNativeId: apiId } : {}),
    nativeEventCorrelationOnly: Boolean(intent.nativeEventEvidence) && !apiId,
    deleteTargetProvenAbsent: false,
    permissionOrManagedOrOtherError: false,
    waitingDependency: false,
  });
}

function callHasStarted(intent: IntentRecord): boolean {
  if (intent.replayState === 'not_started') return false;
  if (intent.replayState === 'started' || intent.replayState === 'awaiting_receipt') return true;
  return intent.state === 'browser_call_started' || intent.state === 'native_event_observed'
    || intent.state === 'awaiting_confirmation';
}

function apiReturnId(intent: IntentRecord): string | undefined {
  const value = intent.apiResultEvidence?.nativeId
    ?? (intent.nativeResultConfirmation?.kind === 'api_return' ? intent.nativeResultConfirmation.nativeId : undefined);
  return typeof value === 'string' ? value : undefined;
}

function appliedNativeId(intent: IntentRecord): string | undefined {
  return apiReturnId(intent)
    ?? (intent.nativeResultConfirmation?.kind === 'candidate_event'
      ? intent.nativeResultConfirmation.nativeId : undefined);
}

async function ensureIntent(input: NativeCreateInput): Promise<IntentRecord> {
  const existing = await input.store.getApplyIntent(input.scope, input.intentId);
  if (existing) return existing;
  const correlationId = intentOwnerKey(input.owner);
  const found = await input.store.findApplyIntent(input.scope, correlationId);
  if (found) return found;
  try {
    await input.store.createApplyIntent(input.scope, {
      intentId: input.intentId, correlationId, operationId: input.operationId ?? input.owner.eventId,
      expected: { kind: 'create', nativeId: `pending:${input.owner.colpId}` },
      expiresAt: (input.now ?? Date.now)() + 300_000, state: 'intent_prepared',
      generation: input.owner.generation, commandId: input.owner.commandId, colpId: input.owner.colpId,
      substep: input.owner.substep, liveWorkKind: input.liveWorkKind ?? 'create',
      nativeParentId: input.parentNativeId, nativeResult: 'not_started', replayState: 'not_started',
    });
  } catch (error) {
    const raced = await input.store.getApplyIntent(input.scope, input.intentId)
      ?? await input.store.findApplyIntent(input.scope, correlationId);
    if (raced) return raced;
    throw error;
  }
  const created = await input.store.getApplyIntent(input.scope, input.intentId);
  if (!created) throw new SyncFailureError('intent_not_found');
  return created;
}

async function persistStarted(input: NativeCreateInput, intent: IntentRecord): Promise<void> {
  if (intent.eventId) {
    const event = await input.store.getPullEvent(input.scope, intent.eventId);
    if (event && String(event.state) === 'intent_prepared' && String(event.intentId) === input.intentId) {
      await input.store.markPullBrowserCallStarted(input.scope, intent.eventId);
    }
  }
  await patch(input, {
    replayState: 'started', commandId: input.owner.commandId, colpId: input.owner.colpId,
    substep: input.owner.substep, liveWorkKind: input.liveWorkKind ?? 'create',
    generation: input.owner.generation, nativeParentId: input.parentNativeId,
    ...(intent.state === 'intent_prepared' && !intent.eventId ? { state: 'browser_call_started' } : {}),
  });
}

async function persistReceipt(input: NativeCreateInput, nativeId: string): Promise<void> {
  const intent = await input.store.getApplyIntent(input.scope, input.intentId);
  const evidence = { operationId: input.operationId ?? input.owner.eventId, nativeId } as JsonObject;
  if (intent?.eventId) {
    try { await input.store.recordPullApiEvidence(input.scope, intent.eventId, evidence); }
    catch { /* Intent-only paths (rejoin) have no pull event in the started state. */ }
  }
  await patch(input, {
    nativeResult: 'applied_with_evidence', replayState: 'awaiting_receipt',
    apiResultEvidence: evidence, nativeResultConfirmation: { kind: 'api_return', nativeId },
    waitReason: null, commandId: input.owner.commandId, colpId: input.owner.colpId,
    substep: input.owner.substep, liveWorkKind: input.liveWorkKind ?? 'create',
  });
}

async function persistUnknown(input: NativeCreateInput,
  occupancy: ReadonlyMap<string, string>): Promise<NativeCreateOutcome> {
  const waitRef = `nwr:${input.intentId}:${input.owner.generation}:${(input.now ?? Date.now)()}`;
  const candidates = await listCandidates(input, occupancy);
  await patch(input, {
    nativeResult: 'result_unknown', waitReason: 'native_result_unknown', replayState: 'awaiting_receipt',
    nativeResultConfirmation: { kind: 'unknown', code: waitRef }, eventState: 'awaiting_confirmation',
    commandId: input.owner.commandId, colpId: input.owner.colpId, substep: input.owner.substep,
    liveWorkKind: input.liveWorkKind ?? 'create', generation: input.owner.generation,
    nativeParentId: input.parentNativeId,
  });
  return {
    result: 'result_unknown',
    wait: {
      waitRef, intentId: input.intentId, colpId: input.owner.colpId, waitReason: 'native_result_unknown',
      candidates, affectedRange: { parentNativeId: input.parentNativeId },
    },
  };
}

async function persistDependency(input: NativeCreateInput,
  occupancy: ReadonlyMap<string, string>): Promise<NativeCreateOutcome> {
  const unknown = await persistUnknown(input, occupancy);
  if (unknown.result !== 'result_unknown') return unknown;
  await patch(input, { nativeResult: 'waiting_dependency', waitReason: 'parent' });
  return { result: 'waiting_dependency', wait: { ...unknown.wait, waitReason: 'waiting_dependency' } };
}

async function fail(input: NativeCreateInput, code: string): Promise<NativeCreateOutcome> {
  const intent = await input.store.getApplyIntent(input.scope, input.intentId);
  if (intent) {
    await patch(input, {
      nativeResult: 'failed', nativeResultConfirmation: { kind: 'failed', code },
      commandId: input.owner.commandId, colpId: input.owner.colpId, substep: input.owner.substep,
    });
  }
  return { result: 'failed', code };
}

async function listCandidates(input: NativeCreateInput, occupancy: ReadonlyMap<string, string>) {
  let children: readonly { readonly id: string; readonly title?: string; readonly url?: string }[] = [];
  try { children = await input.api.getChildren(input.parentNativeId); }
  catch { return []; }
  return children.filter((child) => child.title === input.expected.title && child.url === input.expected.url
    && unoccupiedOrSelf(occupancy, child.id, input.owner.colpId))
    .map((child) => ({ nativeId: child.id, title: child.title, url: child.url }));
}

function claimIntentNative(occupied: Map<string, string>, intent: IntentRecord): void {
  const nativeId = apiReturnId(intent)
    ?? (typeof intent.nativeResultConfirmation?.nativeId === 'string'
      ? intent.nativeResultConfirmation.nativeId : undefined);
  if (!nativeId || virtualNativeId(nativeId) || !intent.colpId || occupied.has(nativeId)) return;
  occupied.set(nativeId, intent.colpId);
}

function unoccupiedOrSelf(occupancy: ReadonlyMap<string, string>, nativeId: string, colpId: string): boolean {
  const owner = occupancy.get(nativeId);
  return owner === undefined || owner === colpId;
}

function isPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /permission|not authorized|revoked/i.test(message);
}

function patch(input: NativeCreateInput, facts: ApplyIntentFactsPatch) {
  return input.store.persistApplyIntentFacts(input.scope, input.intentId, facts);
}
