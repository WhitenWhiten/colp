import { SyncStateError, type JsonObject, type PushSettlement, type QueueOperation, type ReceiptInput } from './types.js';
import { boundedString, clone, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';

export function validateQueueInput(scopeKeyValue: string, input: unknown, maxBytes: number): Omit<QueueOperation, 'sequence' | 'scopeKey'> {
  const value = strictObject(clone(input), ['opId', 'batchId', 'idempotencyKey', 'digest', 'endpointIdentity', 'mediaType',
    'baseRevision', 'operationRevision', 'status', 'retry', 'payload'], 'queue operation');
  if (value.endpointIdentity !== 'syncPush' || value.status !== 'pending') throw new SyncStateError('queue_state_invalid');
  const retry = strictObject(value.retry, ['attempt', 'notBefore'], 'retry');
  const record = { opId: boundedString(value.opId, 'opId'), batchId: boundedString(value.batchId, 'batchId'),
    idempotencyKey: boundedString(value.idempotencyKey, 'idempotencyKey'), digest: boundedString(value.digest, 'digest'),
    endpointIdentity: 'syncPush' as const, mediaType: boundedString(value.mediaType, 'mediaType'),
    baseRevision: value.baseRevision === null ? null : boundedString(value.baseRevision, 'baseRevision'),
    operationRevision: boundedString(value.operationRevision, 'operationRevision'), status: 'pending' as const,
    retry: { attempt: safeInteger(retry.attempt, 'attempt'), notBefore: safeInteger(retry.notBefore, 'notBefore') },
    payload: validateJson(value.payload, 'payload') as JsonObject };
  validateRecord({ scopeKey: scopeKeyValue, ...record }, maxBytes); return record;
}

export function validateQueueRecord(input: unknown, maxBytes: number): QueueOperation {
  const value = strictObject(clone(input), ['scopeKey', 'sequence', 'opId', 'batchId', 'idempotencyKey', 'digest',
    'endpointIdentity', 'mediaType', 'baseRevision', 'operationRevision', 'status', 'retry', 'recovery', 'attempt',
    'echoApplied', 'payload'],
  'queue record', ['recovery', 'attempt', 'echoApplied']);
  if (value.endpointIdentity !== 'syncPush'
      || !['pending', 'claimed', 'deferred', 'terminal', 'gap', 'blocked', 'unknown', 'rejected', 'set_aside']
        .includes(String(value.status))) {
    throw new SyncStateError('queue_state_invalid');
  }
  // A held row was never sent: it carries why it is held and no attempt.
  if (value.status === 'set_aside' && (value.recovery === undefined || value.attempt !== undefined)) {
    throw new SyncStateError('queue_state_invalid');
  }
  const retry = strictObject(value.retry, ['attempt', 'notBefore', 'ownerId', 'fence', 'claimExpiresAt'], 'retry',
    ['ownerId', 'fence', 'claimExpiresAt']);
  const record: QueueOperation = { scopeKey: boundedString(value.scopeKey, 'scopeKey', 16_384),
    sequence: safeInteger(value.sequence, 'sequence', 1), opId: boundedString(value.opId, 'opId'),
    batchId: boundedString(value.batchId, 'batchId'), idempotencyKey: boundedString(value.idempotencyKey, 'idempotencyKey'),
    digest: boundedString(value.digest, 'digest'), endpointIdentity: 'syncPush', mediaType: boundedString(value.mediaType, 'mediaType'),
    baseRevision: value.baseRevision === null ? null : boundedString(value.baseRevision, 'baseRevision'),
    operationRevision: boundedString(value.operationRevision, 'operationRevision'), status: value.status as QueueOperation['status'],
    retry: { attempt: safeInteger(retry.attempt, 'attempt'), notBefore: safeInteger(retry.notBefore, 'notBefore'),
      ...(retry.ownerId === undefined ? {} : { ownerId: boundedString(retry.ownerId, 'ownerId') }),
      ...(retry.fence === undefined ? {} : { fence: safeInteger(retry.fence, 'fence', 1) }),
      ...(retry.claimExpiresAt === undefined ? {} : { claimExpiresAt: safeInteger(retry.claimExpiresAt, 'claimExpiresAt', 1) }) },
    ...(value.recovery === undefined ? {} : { recovery: validateQueueRecovery(value.recovery) }),
    ...(value.attempt === undefined ? {} : { attempt: validatePushAttempt(value.attempt) }),
    ...(value.echoApplied === true ? { echoApplied: true as const } : {}),
    payload: validateJson(value.payload, 'payload') as JsonObject };
  validateRecord(record, maxBytes); return record;
}
export function validateQueueRecovery(input: unknown): NonNullable<QueueOperation['recovery']> {
  const value = strictObject(input, ['code', 'expectedSequence'], 'queue recovery', ['expectedSequence']);
  return { code: boundedString(value.code, 'recovery code'),
    ...(value.expectedSequence === undefined ? {} : { expectedSequence: safeInteger(value.expectedSequence,
      'expectedSequence', 1) }) };
}
export function validatePushAttempt(input: unknown): NonNullable<QueueOperation['attempt']> {
  const value = strictObject(clone(input), ['sessionId', 'batchId', 'idempotencyKey', 'endpointIdentity', 'mediaType',
    'body', 'bodyDigest', 'startedAt', 'requestedAt', 'serverBatchId', 'tracing'], 'push attempt',
    ['startedAt', 'requestedAt', 'serverBatchId', 'tracing']);
  if (value.endpointIdentity !== 'syncPush' || value.mediaType !== 'application/json') {
    throw new SyncStateError('attempt_binding_invalid');
  }
  const tracing = value.tracing === undefined ? undefined
    : strictObject(value.tracing, ['traceId', 'spanId'], 'attempt tracing', ['spanId']);
  const attempt = { sessionId: boundedString(value.sessionId, 'sessionId'), batchId: boundedString(value.batchId, 'batchId'),
    idempotencyKey: boundedString(value.idempotencyKey, 'idempotencyKey'), endpointIdentity: 'syncPush' as const,
    mediaType: 'application/json' as const, body: boundedString(value.body, 'attempt body', 128 * 1024),
    bodyDigest: boundedString(value.bodyDigest, 'bodyDigest'),
    ...(value.startedAt === undefined ? {} : { startedAt: safeInteger(value.startedAt, 'startedAt', 1) }),
    ...(value.requestedAt === undefined ? {} : { requestedAt: safeInteger(value.requestedAt, 'requestedAt', 1) }),
    ...(value.serverBatchId === undefined ? {} : { serverBatchId: boundedString(value.serverBatchId, 'serverBatchId') }),
    ...(tracing === undefined ? {} : { tracing: { traceId: boundedString(tracing.traceId, 'traceId'),
      ...(tracing.spanId === undefined ? {} : { spanId: boundedString(tracing.spanId, 'spanId') }) } }) };
  let body: unknown; try { body = JSON.parse(attempt.body); } catch { throw new SyncStateError('attempt_binding_invalid'); }
  const document = body as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body) || document.sessionId !== attempt.sessionId
      || document.batchId !== attempt.batchId) throw new SyncStateError('attempt_binding_invalid');
  return attempt;
}
export function validatePushSettlement(input: unknown, maxBytes: number): PushSettlement {
  const value = strictObject(clone(input), ['outcome', 'receipt', 'retry', 'recovery', 'authoritativeCreate',
    'authoritativeProjection', 'clearAttempt'], 'push settlement', ['receipt', 'retry', 'recovery', 'authoritativeCreate',
    'authoritativeProjection', 'clearAttempt']);
  if (!['terminal', 'deferred', 'gap', 'blocked', 'unknown', 'rejected'].includes(String(value.outcome))) {
    throw new SyncStateError('queue_state_invalid');
  }
  const retryValue = value.retry === undefined ? undefined
    : strictObject(value.retry, ['attempt', 'notBefore'], 'push retry');
  const retry = retryValue ? { attempt: safeInteger(retryValue.attempt, 'attempt'),
    notBefore: safeInteger(retryValue.notBefore, 'notBefore') } : undefined;
  if (value.outcome === 'terminal' || value.outcome === 'deferred'
      || (value.outcome === 'blocked' && value.receipt !== undefined)) {
    if (value.receipt === undefined || (value.outcome !== 'terminal' && !retry)) throw new SyncStateError('receipt_invalid');
    const receiptValue = strictObject(value.receipt, ['opId', 'operationDigest', 'kind', 'receiptId', 'resultDigest', 'result'],
      'receipt', ['result']);
    const receiptKind = value.outcome === 'blocked' ? 'terminal' : value.outcome;
    if (receiptValue.kind !== receiptKind) throw new SyncStateError('receipt_kind_invalid');
    const receipt: ReceiptInput = { opId: boundedString(receiptValue.opId, 'opId'),
      operationDigest: boundedString(receiptValue.operationDigest, 'operationDigest'), kind: receiptKind,
      receiptId: boundedString(receiptValue.receiptId, 'receiptId'),
      resultDigest: boundedString(receiptValue.resultDigest, 'resultDigest'),
      ...(receiptValue.result === undefined ? {} : { result: validateJson(receiptValue.result, 'receipt result') as JsonObject }) };
    const authoritative = value.authoritativeCreate === undefined ? undefined
      : strictObject(value.authoritativeCreate, ['nativeId', 'targetId', 'revision'], 'authoritative create');
    const projection = value.authoritativeProjection === undefined ? undefined
      : strictObject(value.authoritativeProjection, ['targetId', 'revision', 'content'], 'authoritative projection',
        ['content']);
    if (value.outcome === 'blocked' && (authoritative || projection)) {
      throw new SyncStateError('provisional_mapping_binding_invalid');
    }
    if (value.outcome === 'blocked' && value.recovery === undefined) throw new SyncStateError('recovery_invalid');
    if (value.outcome === 'blocked') {
      const settlement: PushSettlement = { outcome: 'blocked', receipt, retry: retry!,
        recovery: validateQueueRecovery(value.recovery) };
      validateRecord(settlement, maxBytes); return settlement;
    }
    const settlement: PushSettlement = { outcome: value.outcome, receipt, ...(retry ? { retry } : {}),
      ...(authoritative ? { authoritativeCreate: {
        nativeId: boundedString(authoritative.nativeId, 'nativeId'), targetId: boundedString(authoritative.targetId, 'targetId'),
        revision: boundedString(authoritative.revision, 'revision') } } : {}),
      ...(projection ? { authoritativeProjection: { targetId: boundedString(projection.targetId, 'targetId'),
        revision: boundedString(projection.revision, 'revision'),
        ...(projection.content === undefined ? {}
          : { content: validateJson(projection.content, 'authoritative projection content') as JsonObject }) } } : {}) };
    validateRecord(settlement, maxBytes); return settlement;
  }
  if (value.outcome === 'rejected') {
    if (value.recovery === undefined) throw new SyncStateError('recovery_invalid');
    return { outcome: 'rejected', recovery: validateQueueRecovery(value.recovery) };
  }
  if (!retry) throw new SyncStateError('retry_invalid');
  if (value.outcome === 'gap' || value.outcome === 'blocked') {
    if (value.recovery === undefined) throw new SyncStateError('recovery_invalid');
    return { outcome: value.outcome, retry, recovery: validateQueueRecovery(value.recovery) };
  }
  // An unknown settlement may carry a reason code so a poisoned Operation is
  // diagnosable from the durable row instead of only a climbing retry counter.
  // Classified rebase (stale position / concurrent move) drops the attempt so
  // the next drain can bind a refreshed body; lost-response retries keep it.
  if (value.clearAttempt !== undefined && value.clearAttempt !== true) throw new SyncStateError('queue_state_invalid');
  return { outcome: 'unknown', retry,
    ...(value.recovery === undefined ? {} : { recovery: validateQueueRecovery(value.recovery) }),
    ...(value.clearAttempt === true ? { clearAttempt: true as const } : {}) };
}
export function validateReceipt(key: string, sequence: number, input: unknown, maxBytes: number) { const value = strictObject(clone(input),
  ['scopeKey', 'sequence', 'opId', 'operationDigest', 'kind', 'receiptId', 'resultDigest', 'result'], 'receipt',
  ['scopeKey', 'sequence', 'result']); if (!['terminal', 'deferred'].includes(String(value.kind)))
  throw new SyncStateError('receipt_kind_invalid');
  if ((value.scopeKey !== undefined && value.scopeKey !== key)
      || (value.sequence !== undefined && value.sequence !== sequence)) throw new SyncStateError('receipt_binding_invalid');
  const record = { scopeKey: key, sequence, opId: boundedString(value.opId, 'opId'),
    operationDigest: boundedString(value.operationDigest, 'operationDigest'), kind: value.kind as 'terminal' | 'deferred',
    receiptId: boundedString(value.receiptId, 'receiptId'), resultDigest: boundedString(value.resultDigest, 'resultDigest'),
    ...(value.result === undefined ? {} : { result: validateJson(value.result, 'receipt result') as JsonObject }) };
  validateRecord(record, maxBytes); return record; }
export function sameQueueOperation(prior: QueueOperation, operation: Omit<QueueOperation, 'sequence' | 'scopeKey'>) {
  const { sequence: _sequence, scopeKey: _scopeKey, ...stored } = prior;
  return JSON.stringify(stored) === JSON.stringify(operation);
}
export function sameReceipt(prior: Record<string, unknown>, receipt: Record<string, unknown>) {
  return JSON.stringify(prior) === JSON.stringify(receipt);
}
