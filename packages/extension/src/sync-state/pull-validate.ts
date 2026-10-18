import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createProjectionSuppression, type ProjectionIntentRecord } from '../recovery-overlay.js';
import { SyncStateError, type AckIntentRecord, type DurableSyncEngineState,
  type ImportNodeRecord, type ImportPlanRecord, type ImportRecoveryCode, type IntentLiveWorkKind,
  type IntentReplayState, type JsonObject, type NativeResultConfirmation, type PersistedNativeCallResult,
  type PullApplyState, type PullPageInput, type RecoveryPageInput, type SyncEnginePhase,
  type UnknownRecord, type MappingInput } from './types.js';
import { boundedString, canonicalJson, clone, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';
import { validateMapping } from './mapping-repository.js';

export function validateCursor(key: string, input: unknown, maxBytes: number) { const value = strictObject(clone(input),
  ['cursor', 'checkpoint', 'evidence'], 'cursor'); const evidence = strictObject(value.evidence,
  ['receiptId', 'operationDigest'], 'cursor evidence'); const record = { scopeKey: key, cursor: boundedString(value.cursor, 'cursor'),
    checkpoint: boundedString(value.checkpoint, 'checkpoint'), evidence: { receiptId: boundedString(evidence.receiptId, 'receiptId'),
      operationDigest: boundedString(evidence.operationDigest, 'operationDigest') } }; validateRecord(record, maxBytes); return record; }
const NATIVE_RESULTS = new Set(['not_started', 'applied_with_evidence', 'absent', 'result_unknown',
  'waiting_dependency', 'failed', 'unknown']);
const REPLAY_STATES = new Set(['unknown', 'not_started', 'started', 'awaiting_receipt', 'committed']);
const LIVE_WORK = new Set(['create', 'restore', 'move', 'delete', 'rejoin', 'unknown']);

export function validateIntent(key: string, input: Record<string, unknown>, maxBytes: number) { const value = strictObject(clone(input),
  ['intentId', 'correlationId', 'operationId', 'expected', 'expiresAt', 'state', 'eventId', 'effectId',
    'preStateDigest', 'expectedPostState', 'nativeTargetId', 'nativeParentId', 'anchors', 'apiPhase',
    'nativeEventEvidence', 'apiResultEvidence', 'generation', 'nativeResult', 'waitReason',
    'nativeResultConfirmation', 'repairJobId', 'replayState', 'commandId', 'colpId', 'substep', 'liveWorkKind', 'nativeWaitDecision'],
  'intent', ['state', 'eventId', 'effectId', 'preStateDigest',
    'expectedPostState', 'nativeTargetId', 'nativeParentId', 'anchors', 'apiPhase', 'nativeEventEvidence',
    'apiResultEvidence', 'generation', 'nativeResult', 'waitReason', 'nativeResultConfirmation', 'repairJobId',
    'replayState', 'commandId', 'colpId', 'substep', 'liveWorkKind', 'nativeWaitDecision']);
  const expected = strictObject(value.expected,
  ['kind', 'nativeId'], 'expected mutation'); const record = { scopeKey: key, intentId: boundedString(value.intentId, 'intentId'),
    correlationId: boundedString(value.correlationId, 'correlationId'), operationId: boundedString(value.operationId, 'operationId'),
    expected: { kind: boundedString(expected.kind, 'kind'), nativeId: boundedString(expected.nativeId, 'nativeId') },
    expiresAt: safeInteger(value.expiresAt, 'expiresAt'),
    ...(value.state === undefined ? {} : { state: String(value.state) as PullApplyState }),
    ...(value.eventId === undefined ? {} : { eventId: boundedString(value.eventId, 'eventId') }),
    ...(value.effectId === undefined ? {} : { effectId: boundedString(value.effectId, 'effectId') }),
    ...(value.preStateDigest === undefined ? {} : { preStateDigest: boundedString(value.preStateDigest, 'preStateDigest') }),
    ...(value.expectedPostState === undefined ? {} : { expectedPostState: validateJson(value.expectedPostState, 'expectedPostState') as JsonObject }),
    ...(value.nativeTargetId === undefined ? {} : { nativeTargetId: value.nativeTargetId === null ? null
      : boundedString(value.nativeTargetId, 'nativeTargetId') }),
    ...(value.nativeParentId === undefined ? {} : { nativeParentId: value.nativeParentId === null ? null
      : boundedString(value.nativeParentId, 'nativeParentId') }),
    ...(value.anchors === undefined ? {} : { anchors: validateJson(value.anchors, 'anchors') as JsonObject }),
    ...(value.apiPhase === undefined ? {} : { apiPhase: boundedString(value.apiPhase, 'apiPhase') }),
    ...(value.nativeEventEvidence === undefined ? {} : { nativeEventEvidence: value.nativeEventEvidence === null ? null
      : validateJson(value.nativeEventEvidence, 'nativeEventEvidence') as JsonObject }),
    ...(value.apiResultEvidence === undefined ? {} : { apiResultEvidence: value.apiResultEvidence === null ? null
      : validateJson(value.apiResultEvidence, 'apiResultEvidence') as JsonObject }),
    ...(value.generation === undefined ? {} : { generation: safeInteger(value.generation, 'generation', 1) }),
    ...intentV15Fields(value) };
  validateRecord(record, maxBytes); return record; }

function intentV15Fields(value: UnknownRecord) {
  if (value.nativeResult !== undefined && !NATIVE_RESULTS.has(String(value.nativeResult))) {
    throw new SyncStateError('native_result_invalid');
  }
  if (value.replayState !== undefined && !REPLAY_STATES.has(String(value.replayState))) {
    throw new SyncStateError('replay_state_invalid');
  }
  if (value.liveWorkKind !== undefined && !LIVE_WORK.has(String(value.liveWorkKind))) {
    throw new SyncStateError('live_work_invalid');
  }
  const confirmation = value.nativeResultConfirmation === undefined ? undefined
    : validateNativeResultConfirmation(value.nativeResultConfirmation);
  const decision = value.nativeWaitDecision === undefined ? undefined : validateNativeWaitDecision(value.nativeWaitDecision);
  return {
    ...(decision === undefined ? {} : { nativeWaitDecision: decision }),
    ...(value.nativeResult === undefined ? {} : { nativeResult: String(value.nativeResult) as PersistedNativeCallResult }),
    ...(value.waitReason === undefined ? {} : { waitReason: boundedString(value.waitReason, 'waitReason') }),
    ...(confirmation === undefined ? {} : { nativeResultConfirmation: confirmation }),
    ...(value.repairJobId === undefined ? {} : { repairJobId: boundedString(value.repairJobId, 'repairJobId') }),
    ...(value.replayState === undefined ? {} : { replayState: String(value.replayState) as IntentReplayState }),
    ...(value.commandId === undefined ? {} : { commandId: boundedString(value.commandId, 'commandId') }),
    ...(value.colpId === undefined ? {} : { colpId: boundedString(value.colpId, 'colpId') }),
    ...(value.substep === undefined ? {} : { substep: boundedString(value.substep, 'substep') }),
    ...(value.liveWorkKind === undefined ? {} : { liveWorkKind: String(value.liveWorkKind) as IntentLiveWorkKind }),
  };
}

function validateNativeWaitDecision(input: unknown): import('./types.js').NativeWaitDecision {
  const value = strictObject(input, ['action', 'waitRef'], 'native wait decision');
  if (!['bind', 'keep_local_and_create', 'cancel'].includes(String(value.action))) throw new SyncStateError('request_invalid');
  return { action: value.action as import('./types.js').NativeWaitDecision['action'],
    waitRef: boundedString(value.waitRef, 'waitRef') };
}

function validateNativeResultConfirmation(input: unknown): NativeResultConfirmation {
  const value = strictObject(input, ['kind', 'nativeId', 'code'], 'native result confirmation', ['nativeId', 'code']);
  if (!['unknown', 'api_return', 'candidate_event', 'absent', 'failed'].includes(String(value.kind))) {
    throw new SyncStateError('native_result_confirmation_invalid');
  }
  return { kind: value.kind as NativeResultConfirmation['kind'],
    ...(value.nativeId === undefined ? {} : { nativeId: boundedString(value.nativeId, 'nativeId') }),
    ...(value.code === undefined ? {} : { code: boundedString(value.code, 'code') }) };
}
export function validatePullPage(key: string, input: PullPageInput, maxBytes: number) {
  const pageId = boundedString(input.pageId, 'pageId'); const seen = new Set<string>();
  const events = input.events.map((event, ordinal) => {
    if (seen.has(event.eventId)) throw new SyncStateError('pull_event_duplicate'); seen.add(event.eventId);
    return { scopeKey: key, pageId, ordinal, state: event.initialState ?? 'staged',
      eventId: boundedString(event.eventId, 'eventId'), cursor: boundedString(event.cursor, 'eventCursor'),
      operationId: boundedString(event.operationId, 'operationId'), effectId: boundedString(event.effectId, 'effectId'),
      effectDigest: boundedString(event.effectDigest, 'effectDigest'), operationDigest: boundedString(event.operationDigest, 'operationDigest'),
      kind: boundedString(event.kind, 'kind'), payload: validateJson(event.payload, 'pullEvent.payload') as JsonObject };
  });
  const effectPages = (input.effectPages ?? []).map((page) => { if (!seen.has(page.eventId)) throw new SyncStateError('effect_page_event_unbound'); return ({ scopeKey: key, pageId,
    eventId: boundedString(page.eventId, 'eventId'), effectId: boundedString(page.effectId, 'effectId'),
    pageNumber: safeInteger(page.pageNumber, 'pageNumber', 1), pageDigest: boundedString(page.pageDigest, 'pageDigest'),
    previousPageDigest: page.previousPageDigest === null ? null : boundedString(page.previousPageDigest, 'previousPageDigest'),
    payload: validateJson(page.payload, 'effectPage.payload') as JsonObject }); });
  const record = { scopeKey: key, pageId, previousCursor: boundedString(input.previousCursor, 'previousCursor'),
    nextCursor: boundedString(input.nextCursor, 'nextCursor'), collectionRevision: boundedString(input.collectionRevision, 'collectionRevision'),
    pageDigest: boundedString(input.pageDigest, 'pageDigest'), eventCount: events.length, state: 'staged' as const,
    events, effectPages };
  validateRecord(record, Math.max(maxBytes, 2 * 1024 * 1024)); return record;
}
/** Stage-time identity of a pull event row: every byte the server signed, minus the
 * local placement (pageId/ordinal) and the apply state the durable store advanced. */
export function samePullEventRecord(left: UnknownRecord, right: UnknownRecord): boolean {
  return ['eventId', 'cursor', 'operationId', 'effectId', 'effectDigest', 'operationDigest', 'kind', 'payload']
    .every((field) => canonicalJson(left[field]) === canonicalJson(right[field]));
}

/** Same for an authoritative effect page, which is keyed by event identity, not by page. */
export function sameEffectPageRecord(left: UnknownRecord, right: UnknownRecord): boolean {
  return ['eventId', 'pageNumber', 'pageDigest', 'previousPageDigest', 'payload']
    .every((field) => canonicalJson(left[field]) === canonicalJson(right[field]));
}

export function uniqueExclusions<T extends { readonly nativeId?: unknown }>(rows: readonly T[]): T[] {
  const seen = new Set<string>(); const unique: T[] = [];
  for (const row of rows) {
    const nativeId = typeof row.nativeId === 'string' ? row.nativeId : '';
    if (!nativeId || seen.has(nativeId)) continue;
    seen.add(nativeId); unique.push(row);
  }
  return unique;
}

export function validateImportPlan(scopeKeyValue: string, input: unknown, maxBytes: number): ImportPlanRecord {
  const value = strictObject(clone(input), ['scopeKey', 'planId', 'conversionDigest', 'sourceProfile', 'sourceIdentity',
    'choiceDigest', 'state', 'createdAt', 'updatedAt'], 'import plan', ['scopeKey']);
  if (value.scopeKey !== undefined && value.scopeKey !== scopeKeyValue) throw new SyncStateError('scope_mismatch');
  if (!['netscape-bookmarks-v1', 'chromium-bookmarks-v1'].includes(String(value.sourceProfile))) {
    throw new SyncStateError('import_source_invalid');
  }
  if (!['active', 'paused', 'complete', 'attention'].includes(String(value.state))) throw new SyncStateError('import_state_invalid');
  const record: ImportPlanRecord = { scopeKey: scopeKeyValue, planId: boundedString(value.planId, 'planId'),
    conversionDigest: boundedString(value.conversionDigest, 'conversionDigest'),
    sourceProfile: value.sourceProfile as ImportPlanRecord['sourceProfile'],
    sourceIdentity: boundedString(value.sourceIdentity, 'sourceIdentity'), choiceDigest: boundedString(value.choiceDigest, 'choiceDigest'),
    state: value.state as ImportPlanRecord['state'], createdAt: safeInteger(value.createdAt, 'createdAt'),
    updatedAt: safeInteger(value.updatedAt, 'updatedAt') };
  validateRecord(record, maxBytes); return record;
}

export function validateImportNode(scopeKeyValue: string, input: unknown, maxBytes: number): ImportNodeRecord {
  const value = strictObject(clone(input), ['scopeKey', 'planId', 'sourceNodeId', 'order', 'parentSourceNodeId', 'opId',
    'choice', 'status', 'sequence', 'recovery', 'target', 'authoritativeTarget', 'node'], 'import node',
  ['scopeKey', 'sequence', 'recovery', 'target', 'authoritativeTarget']);
  if (value.scopeKey !== undefined && value.scopeKey !== scopeKeyValue) throw new SyncStateError('scope_mismatch');
  if (!['import', 'skip'].includes(String(value.choice))
      || !['staged', 'skipped', 'queued', 'terminal', 'recoverable'].includes(String(value.status))) {
    throw new SyncStateError('import_node_state_invalid');
  }
  const parentSourceNodeId = value.parentSourceNodeId === null ? null : boundedString(value.parentSourceNodeId, 'parentSourceNodeId');
  const targetValue = value.target === undefined ? undefined
    : strictObject(value.target, ['nativeId', 'colpId', 'revision'], 'import target');
  const authoritativeValue = value.authoritativeTarget === undefined ? undefined
    : strictObject(value.authoritativeTarget, ['colpId', 'revision'], 'import authoritative target');
  const recovery = value.recovery === undefined ? undefined : String(value.recovery) as ImportRecoveryCode;
  if (recovery !== undefined && !['conflict', 'session_expired', 'permission_required', 'push_rejected'].includes(recovery)) {
    throw new SyncStateError('import_recovery_invalid');
  }
  const record: ImportNodeRecord = { scopeKey: scopeKeyValue, planId: boundedString(value.planId, 'planId'),
    sourceNodeId: boundedString(value.sourceNodeId, 'sourceNodeId'), order: safeInteger(value.order, 'order'),
    parentSourceNodeId, opId: boundedString(value.opId, 'opId'), choice: value.choice as ImportNodeRecord['choice'],
    status: value.status as ImportNodeRecord['status'],
    ...(value.sequence === undefined ? {} : { sequence: safeInteger(value.sequence, 'sequence', 1) }),
    ...(recovery === undefined ? {} : { recovery }), ...(targetValue === undefined ? {} : { target: {
      nativeId: boundedString(targetValue.nativeId, 'nativeId'), colpId: boundedString(targetValue.colpId, 'colpId'),
      revision: boundedString(targetValue.revision, 'revision') } }), ...(authoritativeValue === undefined ? {} : {
      authoritativeTarget: { colpId: boundedString(authoritativeValue.colpId, 'colpId'),
        revision: boundedString(authoritativeValue.revision, 'revision') } }),
    node: validateJson(value.node, 'import node payload') as JsonObject };
  validateRecord(record, maxBytes); return record;
}
export function validateRecoveryPage(key: string, input: RecoveryPageInput, maxBytes: number) { const value = strictObject(clone(input),
  ['snapshotId', 'sessionId', 'revision', 'syncCursor', 'capability', 'identityDigest', 'rootNodeId', 'page', 'pageDigest',
    'previousPageDigest', 'nextCursor', 'complete', 'nodes', 'materializationVersion'], 'recovery page',
  ['sessionId', 'capability', 'materializationVersion']);
  if (!Array.isArray(value.nodes) || typeof value.complete !== 'boolean') throw new SyncStateError('recovery_page_invalid');
  const record = { scopeKey: key, snapshotId: boundedString(value.snapshotId, 'snapshotId'),
    sessionId: value.sessionId === undefined ? null : boundedString(value.sessionId, 'sessionId'),
    revision: boundedString(value.revision, 'revision'),
    syncCursor: boundedString(value.syncCursor, 'syncCursor'),
    // FIX-M-012: the capability is absent on intermediate pages and ordinary bootstraps; an
    // undefined record field would fail the store's JSON validation, so the key is omitted.
    ...(value.capability === undefined ? {} : { capability: boundedString(value.capability, 'capability') }),
    ...(value.materializationVersion === undefined ? {}
      : { materializationVersion: boundedString(value.materializationVersion, 'materializationVersion') }),
    identityDigest: boundedString(value.identityDigest, 'identityDigest'),
    rootNodeId: boundedString(value.rootNodeId, 'rootNodeId'), page: safeInteger(value.page, 'page'),
    pageDigest: boundedString(value.pageDigest, 'pageDigest'),
    previousPageDigest: value.previousPageDigest === null ? null : boundedString(value.previousPageDigest, 'previousPageDigest'),
    nextCursor: value.nextCursor === null ? null : boundedString(value.nextCursor, 'nextCursor'), complete: value.complete,
    nodes: value.nodes.map((node: unknown) => { const item = strictObject(node,
      ['colpId', 'parentId', 'position', 'kind', 'payloadDigest', 'mapping'], 'recovery node', ['mapping']);
      if (!['Folder', 'Bookmark', 'Separator'].includes(String(item.kind))) throw new SyncStateError('node_kind_invalid');
      const colpId = boundedString(item.colpId, 'colpId'); const payloadDigest = boundedString(item.payloadDigest, 'payloadDigest');
      return { colpId: boundedString(item.colpId, 'colpId'), parentId: item.parentId === null ? null : boundedString(item.parentId, 'parentId'),
        position: boundedString(item.position, 'position'), kind: item.kind, payloadDigest,
        mapping: validateMapping(key, item.mapping === undefined ? { nativeId: `recovery:${colpId}`, colpId,
          rootNativeId: 'recovery', projection: { revision: boundedString(value.revision, 'revision'), digest: payloadDigest } }
          : item.mapping as MappingInput, maxBytes) }; }) };
  const { nodes, ...header } = record; validateRecord(header, maxBytes);
  for (const node of nodes) validateRecord({ scopeKey: key, snapshotId: record.snapshotId, page: record.page, ...node }, maxBytes);
  return record; }
export function validateEngineState(input: unknown): DurableSyncEngineState {
  const value = strictObject(clone(input), ['scopeKey', 'phase', 'revision', 'updatedAt', 'sessionId', 'recoveryFrozen',
    'authorityRefreshRequired', 'notBefore', 'connectivityConfirmationRevision', 'lastPublishedCursor',
    'lastAckedCursor', 'lastPushServerCursor', 'lastPushOutcomeHint', 'networkBackoffCount', 'lastError',
    'expectedRevision', 'localProjectionOwner', 'circuitBreaker'],
  'engine state', ['sessionId', 'authorityRefreshRequired', 'connectivityConfirmationRevision',
    'lastPublishedCursor', 'lastAckedCursor', 'lastPushServerCursor', 'lastPushOutcomeHint', 'networkBackoffCount',
    'lastError', 'expectedRevision', 'localProjectionOwner', 'circuitBreaker']);
  if (!['idle', 'session', 'bootstrap', 'pulling', 'applying', 'acking', 'pushing', 'sleeping', 'offline',
    'recovery', 'retired', 'error'].includes(String(value.phase)) || typeof value.recoveryFrozen !== 'boolean') {
    throw new SyncStateError('engine_state_invalid');
  }
  return { scopeKey: boundedString(value.scopeKey, 'scopeKey', 16_384), phase: value.phase as SyncEnginePhase,
    revision: safeInteger(value.revision, 'engine revision', 1), updatedAt: safeInteger(value.updatedAt, 'updatedAt'),
    recoveryFrozen: value.recoveryFrozen, authorityRefreshRequired: value.authorityRefreshRequired === true,
    notBefore: safeInteger(value.notBefore, 'notBefore'),
    ...(value.localProjectionOwner === undefined ? {} : { localProjectionOwner:
      safeInteger(value.localProjectionOwner, 'localProjectionOwner', 1) }),
    ...(value.connectivityConfirmationRevision === undefined ? {} : { connectivityConfirmationRevision:
      safeInteger(value.connectivityConfirmationRevision, 'connectivityConfirmationRevision', 1) }),
    ...(value.sessionId === undefined ? {} : { sessionId: boundedString(value.sessionId, 'sessionId') }),
    ...(value.lastPublishedCursor === undefined ? {} : { lastPublishedCursor: boundedString(value.lastPublishedCursor,
      'lastPublishedCursor') }), ...(value.lastAckedCursor === undefined ? {} : { lastAckedCursor: boundedString(
      value.lastAckedCursor, 'lastAckedCursor') }), ...(value.lastPushServerCursor === undefined ? {} : {
      lastPushServerCursor: boundedString(value.lastPushServerCursor, 'lastPushServerCursor') }),
    ...(value.lastPushOutcomeHint === undefined ? {} : { lastPushOutcomeHint: boundedString(value.lastPushOutcomeHint,
      'lastPushOutcomeHint') }),
    ...(value.circuitBreaker === undefined ? {} : { circuitBreaker: validateCircuitBreaker(value.circuitBreaker) }),
    ...(value.networkBackoffCount === undefined ? {} : { networkBackoffCount: safeInteger(
      value.networkBackoffCount, 'networkBackoffCount', 0) }),
    ...(value.lastError === undefined ? {} : {
      lastError: boundedString(value.lastError, 'lastError') }) };
}

export function readProjectionIntent(value: UnknownRecord): ProjectionIntentRecord {
  const optional = <Key extends keyof ProjectionIntentRecord>(key: Key, raw: unknown) =>
    raw === undefined || raw === null ? {} : { [key]: raw } as Pick<ProjectionIntentRecord, Key>;
  const kind = String(value.intentKind ?? value.kind);
  const state = String(value.state);
  if (!['create', 'update', 'move', 'delete'].includes(kind)
      || !['pending', 'executing', 'terminal', 'ambiguous', 'recovery'].includes(state)) {
    throw new SyncStateError('projection_intent_invalid');
  }
  const record: ProjectionIntentRecord = {
    intentId: boundedString(value.intentId, 'intentId'),
    kind: kind as ProjectionIntentRecord['kind'],
    colpId: boundedString(value.colpId, 'colpId'), order: safeInteger(value.order, 'order', 1),
    // Normalize legacy correlation strings on read, without losing native receipts.
    suppression: kind === 'create' && typeof value.parentNativeId === 'string' && typeof value.title === 'string'
      ? createProjectionSuppression(value.parentNativeId, value.title, typeof value.url === 'string' ? value.url : undefined)
      : boundedString(value.suppression, 'suppression'),
    generation: safeInteger(value.generation, 'generation', 1),
    state: state as ProjectionIntentRecord['state'],
    ...optional('nativeId', value.nativeId === undefined ? undefined : String(value.nativeId)),
    ...optional('parentColpId', value.parentColpId === undefined ? undefined : String(value.parentColpId)),
    ...optional('parentNativeId', value.parentNativeId === undefined ? undefined : String(value.parentNativeId)),
    ...optional('title', value.title === undefined ? undefined : String(value.title)),
    ...optional('url', value.url === undefined ? undefined : String(value.url)),
    ...optional('index', value.index === undefined ? undefined : Number(value.index)),
    ...optional('folder', value.folder === undefined ? undefined : Boolean(value.folder)),
    ...optional('observedNativeId', value.observedNativeId === undefined ? undefined : String(value.observedNativeId)),
  };
  return record;
}

export function validateAckIntent(input: unknown): AckIntentRecord {
  const value = strictObject(clone(input), ['scopeKey', 'intentId', 'kind', 'sessionId', 'cursor', 'idempotencyKey',
    'endpointIdentity', 'mediaType', 'body', 'bodyDigest', 'state', 'result'], 'ack intent', ['result']);
  if (!['pull', 'bootstrap'].includes(String(value.kind)) || value.endpointIdentity !== 'syncAck'
      || value.mediaType !== 'application/json' || !['pending', 'complete'].includes(String(value.state))) {
    throw new SyncStateError('ack_intent_invalid');
  }
  const body = boundedString(value.body, 'ack body', 128 * 1024); let document: unknown;
  try { document = JSON.parse(body); } catch { throw new SyncStateError('ack_intent_invalid'); }
  const cursor = boundedString(value.cursor, 'cursor'); const sessionId = boundedString(value.sessionId, 'sessionId');
  if (!document || typeof document !== 'object' || Array.isArray(document)
      || (document as UnknownRecord).cursor !== cursor || (document as UnknownRecord).sessionId !== sessionId) {
    throw new SyncStateError('ack_intent_invalid');
  }
  const bodyDigest = boundedString(value.bodyDigest, 'bodyDigest');
  if (bodyDigest !== bytesToHex(sha256(new TextEncoder().encode(body)))) throw new SyncStateError('ack_intent_invalid');
  return { scopeKey: boundedString(value.scopeKey, 'scopeKey', 16_384), intentId: boundedString(value.intentId, 'intentId'),
    kind: value.kind as AckIntentRecord['kind'], sessionId, cursor,
    idempotencyKey: boundedString(value.idempotencyKey, 'idempotencyKey'), endpointIdentity: 'syncAck',
    mediaType: 'application/json', body, bodyDigest,
    state: value.state as AckIntentRecord['state'], ...(value.result === undefined ? {} : {
      result: validateJson(value.result, 'ack result') as JsonObject }) };
}

function validateCircuitBreaker(input: unknown): NonNullable<DurableSyncEngineState['circuitBreaker']> {
  const value = strictObject(input, ['progress', 'failures', 'trips', 'retryAt'], 'circuit breaker', ['retryAt']);
  if (!Array.isArray(value.failures) || value.failures.length > 512) throw new SyncStateError('engine_state_invalid');
  const failures = value.failures.map(input => {
    const row = strictObject(input, ['code', 'attempts'], 'circuit failure');
    if (!Array.isArray(row.attempts) || row.attempts.length < 1 || row.attempts.length > 5) {
      throw new SyncStateError('engine_state_invalid');
    }
    return { code: boundedString(row.code, 'code', 128),
      attempts: row.attempts.map(at => safeInteger(at, 'attempt time')) };
  });
  if (new Set(failures.map(row => row.code)).size !== failures.length) throw new SyncStateError('engine_state_invalid');
  return { progress: boundedString(value.progress, 'progress', 128), failures,
    trips: safeInteger(value.trips, 'trips'),
    ...(value.retryAt === undefined ? {} : { retryAt: safeInteger(value.retryAt, 'retryAt') }) };
}
