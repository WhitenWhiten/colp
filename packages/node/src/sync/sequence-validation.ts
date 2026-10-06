import type {
  OperationReceiptStatus,
  StoredOperationReceipt,
} from './index.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import {
  assertNonEmpty,
  assertPlainDataObject,
} from './internal-guards.js';
import type { SyncOperationClaim } from './operation-reuse.js';
import type {
  SequenceEvaluation,
  SequenceLaneKey,
  SequenceLaneState,
  SequenceOperationRequest,
} from './sequence.js';

/**
 * Receipt and evaluation data validation shared by the Sequence coordinator.
 *
 * This module owns only immutable input normalization and equality for the
 * boundary types declared in `sequence.ts`; the coordinator keeps the lane,
 * claim, and persistence state machine. Lane/request/evaluation types are
 * imported as types so no runtime cycle exists between the two modules.
 */
export const TERMINAL_STATUSES: ReadonlySet<OperationReceiptStatus> = new Set([
  'applied',
  'rebased',
  'noop',
  'conflicted',
  'rejected',
]);

export function immutableData(value: unknown, label: string, seen = new Set<object>()): unknown {
  return immutableJsonData(value, label, seen);
}

export function mutableData<Value>(value: Value): Value {
  return structuredClone(value);
}

export function equalData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => equalData(item, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key)
      && equalData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export function immutableLane(candidate: SequenceLaneKey): SequenceLaneKey {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Sequence lane must be an object.');
  }
  assertPlainDataObject(candidate, new Set(['replicaId', 'sequenceScope']), 'Sequence lane');
  assertNonEmpty(candidate.replicaId, 'replicaId');
  assertNonEmpty(candidate.sequenceScope, 'sequenceScope');
  return Object.freeze({ replicaId: candidate.replicaId, sequenceScope: candidate.sequenceScope });
}

export function immutableRequest(candidate: SequenceOperationRequest): SequenceOperationRequest {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Sequence operation request must be an object.');
  }
  assertPlainDataObject(
    candidate,
    new Set(['operationId', 'replicaId', 'sequenceScope', 'sequence', 'digest', 'reevaluateDeferred']),
    'Sequence operation request',
  );
  assertNonEmpty(candidate.operationId, 'operationId');
  assertNonEmpty(candidate.replicaId, 'replicaId');
  assertNonEmpty(candidate.sequenceScope, 'sequenceScope');
  assertNonEmpty(candidate.digest, 'digest');
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) {
    throw new RangeError('sequence must be a positive safe integer.');
  }
  if (candidate.reevaluateDeferred !== undefined && typeof candidate.reevaluateDeferred !== 'boolean') {
    throw new TypeError('reevaluateDeferred must be a boolean when present.');
  }
  return Object.freeze({
    operationId: candidate.operationId,
    replicaId: candidate.replicaId,
    sequenceScope: candidate.sequenceScope,
    sequence: candidate.sequence,
    digest: candidate.digest,
    ...(candidate.reevaluateDeferred === undefined
      ? {}
      : { reevaluateDeferred: candidate.reevaluateDeferred }),
  });
}

export function immutableLaneState(candidate: SequenceLaneState | undefined): SequenceLaneState {
  if (candidate === undefined) return Object.freeze({ nextSequence: 1 });
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Stored Sequence lane state must be an object.');
  }
  assertPlainDataObject(candidate, new Set(['nextSequence']), 'Stored Sequence lane state');
  if (!Number.isSafeInteger(candidate.nextSequence) || candidate.nextSequence < 1) {
    throw new TypeError('Stored nextSequence must be a positive safe integer.');
  }
  return Object.freeze({ nextSequence: candidate.nextSequence });
}

export function immutableReceipt<Result>(
  candidate: StoredOperationReceipt<Result>,
  lane: SequenceLaneKey,
  expectedSequence?: number,
): StoredOperationReceipt<Result> {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Stored Sequence receipt must be an object.');
  }
  assertPlainDataObject(
    candidate,
    new Set(['operationId', 'replicaId', 'sequenceScope', 'sequence', 'digest', 'status', 'result']),
    'Stored Sequence receipt',
  );
  assertNonEmpty(candidate.operationId, 'Stored receipt operationId');
  assertNonEmpty(candidate.digest, 'Stored receipt digest');
  if (candidate.replicaId !== lane.replicaId || candidate.sequenceScope !== lane.sequenceScope) {
    throw new TypeError('Stored Sequence receipt belongs to a different lane.');
  }
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) {
    throw new TypeError('Stored receipt sequence must be a positive safe integer.');
  }
  if (expectedSequence !== undefined && candidate.sequence !== expectedSequence) {
    throw new TypeError('Stored Sequence receipt has a mismatched sequence.');
  }
  if (candidate.status !== 'deferred' && !TERMINAL_STATUSES.has(candidate.status)) {
    throw new TypeError('Stored Sequence receipt has an invalid status.');
  }
  const result = immutableData(candidate.result, 'Stored Sequence receipt result') as Result;
  if (
    typeof result === 'object'
    && result !== null
    && Object.hasOwn(result, 'status')
    && (result as { readonly status?: unknown }).status !== candidate.status
  ) {
    throw new TypeError('Stored Sequence receipt status differs from its operation result status.');
  }
  return Object.freeze({
    operationId: candidate.operationId,
    replicaId: lane.replicaId,
    sequenceScope: lane.sequenceScope,
    sequence: candidate.sequence,
    digest: candidate.digest,
    status: candidate.status,
    result,
  });
}

export function immutableEvaluation<Result>(candidate: SequenceEvaluation<Result>): SequenceEvaluation<Result> {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Sequence evaluation must be an object.');
  }
  assertPlainDataObject(candidate, new Set(['status', 'result']), 'Sequence evaluation');
  if (candidate.status !== 'deferred' && !TERMINAL_STATUSES.has(candidate.status)) {
    throw new TypeError('Sequence evaluation has an invalid status.');
  }
  const result = immutableData(candidate.result, 'Sequence evaluation result') as Result;
  if (
    typeof result === 'object'
    && result !== null
    && Object.hasOwn(result, 'status')
    && (result as { readonly status?: unknown }).status !== candidate.status
  ) {
    throw new TypeError('Sequence evaluation status differs from its operation result status.');
  }
  return Object.freeze({ status: candidate.status, result });
}

export function receiptMatches<Result>(
  left: StoredOperationReceipt<Result>,
  right: StoredOperationReceipt<Result>,
): boolean {
  return left.operationId === right.operationId
    && left.replicaId === right.replicaId
    && left.sequenceScope === right.sequenceScope
    && left.sequence === right.sequence
    && left.digest === right.digest
    && left.status === right.status
    && equalData(left.result, right.result);
}

export function claimForRequest(request: SequenceOperationRequest): SyncOperationClaim {
  return Object.freeze({
    operationId: request.operationId,
    digest: request.digest,
    replicaId: request.replicaId,
    sequenceScope: request.sequenceScope,
    sequence: request.sequence,
  });
}

export function claimForReceipt<Result>(receipt: StoredOperationReceipt<Result>): SyncOperationClaim {
  return Object.freeze({
    operationId: receipt.operationId,
    digest: receipt.digest,
    replicaId: receipt.replicaId,
    sequenceScope: receipt.sequenceScope,
    sequence: receipt.sequence,
  });
}
