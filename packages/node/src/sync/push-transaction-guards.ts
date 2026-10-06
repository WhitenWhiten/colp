/**
 * Validation and normalization guards for the Push transaction coordinator.
 * Internal module — re-imported by `push-transaction.ts`; not on a barrel.
 */

import type { Operation, OperationResult } from '../types/index.js';
import { createValidatorRegistry } from '../schema/index.js';
import type { StoredOperationReceipt } from './index.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import {
  assertNonEmpty,
} from './internal-guards.js';
import { assertSyncTypedUpdateOperationPayload } from './typed-operations.js';
import type {
  PushConflictRecord,
  PushPreparedOperation,
  PushTransactionOperation,
  PushTransactionRequest,
} from './push-transaction.js';

type Status = OperationResult['status'];

function immutableData<Value>(value: Value, label: string, seen = new Set<object>()): Value {
  return immutableJsonData(value, label, seen);
}

let validators: ReturnType<typeof createValidatorRegistry> | undefined;

export function assertCanonicalOperation(operation: Operation): void {
  validators ??= createValidatorRegistry();
  const validation = validators.validate('operation', operation);
  if (!validation.valid) {
    const first = validation.errors[0];
    const location = first?.instancePath === '' ? '/' : first?.instancePath;
    throw new TypeError(
      `operation is not a valid canonical payload at ${location ?? '/'}: ${first?.message ?? 'validation failed'}.`,
    );
  }
  if (
    operation.type === 'update_collection_metadata'
    || operation.type === 'update_node_content'
    || operation.type === 'update_annotation'
    || operation.type === 'update_attachment'
    || operation.type === 'update_relation'
  ) {
    assertSyncTypedUpdateOperationPayload(operation);
  }
}

export function assertExactObject(candidate: object, keys: readonly string[], label: string): void {
  if (Array.isArray(candidate)) throw new TypeError(`${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const actual = Reflect.ownKeys(candidate);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError(`${label} has invalid members.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} members must be enumerable data properties.`);
    }
  }
}

function immutableOperationItem(candidate: PushTransactionOperation): PushTransactionOperation {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Push operation item must be an object.');
  }
  assertExactObject(candidate, ['operation', 'sequenceScope', 'digest'], 'Push operation item');
  assertNonEmpty(candidate.sequenceScope, 'Push sequenceScope');
  assertNonEmpty(candidate.digest, 'Push digest');
  const operation = immutableData(candidate.operation, 'Push operation');
  assertCanonicalOperation(operation);
  assertNonEmpty(operation.opId, 'Push operation opId');
  assertNonEmpty(operation.replicaId, 'Push operation replicaId');
  if (!Number.isSafeInteger(operation.sequence) || operation.sequence < 1) {
    throw new RangeError('Push operation Sequence must be a positive safe integer.');
  }
  return Object.freeze({ operation, sequenceScope: candidate.sequenceScope, digest: candidate.digest });
}

export function immutableRequest(candidate: PushTransactionRequest): PushTransactionRequest {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Push transaction request must be an object.');
  }
  const hasReevaluateDeferred = 'reevaluateDeferred' in candidate;
  assertExactObject(
    candidate,
    hasReevaluateDeferred
      ? ['batchId', 'atomic', 'serverCursor', 'operations', 'reevaluateDeferred']
      : ['batchId', 'atomic', 'serverCursor', 'operations'],
    'Push transaction request',
  );
  assertNonEmpty(candidate.batchId, 'Push batchId');
  assertNonEmpty(candidate.serverCursor, 'Push serverCursor');
  if (typeof candidate.atomic !== 'boolean') throw new TypeError('Push atomic must be boolean.');
  if (hasReevaluateDeferred && typeof candidate.reevaluateDeferred !== 'boolean') {
    throw new TypeError('Push reevaluateDeferred must be a boolean when present.');
  }
  if (!Array.isArray(candidate.operations) || candidate.operations.length === 0) {
    throw new TypeError('Push operations must be a non-empty array.');
  }
  return Object.freeze({
    batchId: candidate.batchId,
    atomic: candidate.atomic,
    serverCursor: candidate.serverCursor,
    operations: Object.freeze(candidate.operations.map(immutableOperationItem)) as unknown as PushTransactionRequest['operations'],
    ...(hasReevaluateDeferred ? { reevaluateDeferred: candidate.reevaluateDeferred } : {}),
  });
}

export function immutablePlan<Transaction, Conflict extends PushConflictRecord, Audit, Outbox>(
  candidate: PushPreparedOperation<Transaction, Conflict, Audit, Outbox>,
): PushPreparedOperation<Transaction, Conflict, Audit, Outbox> {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Push preflight result must be an object.');
  }
  const status = candidate.status;
  const keys = status === 'deferred'
    ? ['status', 'apply']
    : status === 'noop' || status === 'rejected'
      ? ['status', 'apply', 'audit']
      : status === 'applied' || status === 'rebased' || status === 'conflicted'
        ? ['status', 'apply', 'audit', 'outbox']
        : undefined;
  if (keys === undefined) throw new TypeError('Push preflight returned an unknown status.');
  assertExactObject(candidate, keys, 'Push preflight result');
  if (typeof candidate.apply !== 'function') throw new TypeError('Push apply must be a function.');
  if (status !== 'deferred' && typeof candidate.audit !== 'function') {
    throw new TypeError('Push audit builder must be a function.');
  }
  if (
    (status === 'applied' || status === 'rebased' || status === 'conflicted')
    && typeof candidate.outbox !== 'function'
  ) {
    throw new TypeError('Push outbox builder must be a function.');
  }
  return Object.freeze({ ...candidate });
}

function assertResultIdentity(result: OperationResult, operation: Operation, status: Status): void {
  if (result.status !== status) throw new TypeError('Push apply returned a mismatched status.');
  if (result.opId !== operation.opId || result.sequence !== operation.sequence) {
    throw new TypeError('Push result identity does not match its Operation.');
  }
}

export function assertOperationResultShape(
  candidate: OperationResult,
  operation: Operation,
  status: Status,
): void {
  validators ??= createValidatorRegistry();
  const validation = validators.validate('operationResult', candidate);
  if (!validation.valid) {
    const first = validation.errors[0];
    throw new TypeError(
      `Push ${status} result has invalid members at ${first?.instancePath || '/'}: ${first?.message ?? 'validation failed'}.`,
    );
  }
  assertResultIdentity(candidate, operation, status);
}

export function immutableStoredReceipt(
  candidate: StoredOperationReceipt<OperationResult>,
  label: string,
): StoredOperationReceipt<OperationResult> {
  if (typeof candidate !== 'object' || candidate === null) throw new TypeError(`${label} must be an object.`);
  assertExactObject(
    candidate,
    ['operationId', 'replicaId', 'sequenceScope', 'sequence', 'digest', 'status', 'result'],
    label,
  );
  assertNonEmpty(candidate.operationId, `${label} operationId`);
  assertNonEmpty(candidate.replicaId, `${label} replicaId`);
  assertNonEmpty(candidate.sequenceScope, `${label} sequenceScope`);
  assertNonEmpty(candidate.digest, `${label} digest`);
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) {
    throw new TypeError(`${label} Sequence must be a positive safe integer.`);
  }
  const receipt = immutableData(candidate, label);
  if (receipt.result.status !== receipt.status) {
    throw new TypeError(`${label} status differs from its Operation result.`);
  }
  const identity = { opId: receipt.operationId, sequence: receipt.sequence } as Operation;
  try {
    assertOperationResultShape(
      receipt.result,
      identity,
      receipt.status,
    );
  } catch {
    throw new TypeError(`${label} is inconsistent with its stored Operation result.`);
  }
  return receipt;
}
