/**
 * Pure result construction and state-specific validation for session bootstrap.
 * No I/O and no unit-of-work orchestration — those stay in session-bootstrap.ts.
 */

import { assertNonEmpty as nonEmpty } from './internal-guards.js';
import type {
  Operation,
  OperationResult,
  SyncSessionCollectionResult,
  Warning,
} from '../types/index.js';
import { createValidatorRegistry, type DefinitionName, type ValidatorRegistry } from '../schema/index.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import type { ActiveSyncSessionRecord, SyncSessionRecord } from './session.js';
import type {
  SessionBootstrapCollectionAggregate,
  SessionBootstrapIdentity,
  SessionBootstrapPrepared,
  SessionBootstrapResult,
  SessionBootstrapStatus,
  StoredSessionBootstrapReceipt,
} from './session-bootstrap.js';

type CreateCollectionOperation = Extract<Operation, { readonly type: 'create_collection' }>;
type AppliedResult = Extract<OperationResult, { readonly status: 'applied' }>;
type DeferredResult = Extract<OperationResult, { readonly status: 'deferred' }>;
type RejectedResult = Extract<OperationResult, { readonly status: 'rejected' }>;

let validators: ValidatorRegistry | undefined;

function assertCanonical(definition: DefinitionName, value: unknown): void {
  validators ??= createValidatorRegistry();
  const validation = validators.validate(definition, value);
  if (!validation.valid) {
    const first = validation.errors[0];
    const location = first?.instancePath === '' ? '/' : first?.instancePath;
    throw new TypeError(
      `${definition} is not a valid canonical payload at ${location ?? '/'}: ${first?.message ?? 'validation failed'}.`,
    );
  }
}

function assertObject(value: unknown, label: string): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function assertMembers(candidate: object, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains an unknown member.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} members must be enumerable data properties.`);
    }
  }
}

function immutableData<Value>(value: Value, label: string, seen = new Set<object>()): Value {
  return immutableJsonData(value, label, seen);
}

export function assertResultIdentity(
  result: OperationResult,
  operation: CreateCollectionOperation,
  status: SessionBootstrapStatus,
): void {
  if (result.status !== status || result.opId !== operation.opId || result.sequence !== 1) {
    throw new TypeError('Bootstrap result identity does not match its Operation.');
  }
  if (!Array.isArray(result.warnings)) throw new TypeError('Bootstrap result warnings must be an array.');
  assertCanonical('operationResult', result);
}

export function assertCursorlessResult(result: OperationResult, status: 'deferred' | 'rejected'): void {
  assertObject(result, `Bootstrap ${status} result`);
  if (result.status !== status || Object.hasOwn(result, 'cursor') || Object.hasOwn(result, 'boundCollection')) {
    throw new TypeError(`Bootstrap ${status} result must be cursorless and unbound.`);
  }
  nonEmpty(result.code, `Bootstrap ${status} result code`);
  if (!Array.isArray(result.warnings)) throw new TypeError('Bootstrap result warnings must be an array.');
}

export function assertBoundCollection(
  candidate: SyncSessionCollectionResult,
  identity: SessionBootstrapIdentity,
  cursor: string,
): void {
  assertObject(candidate, 'Bootstrap boundCollection');
  assertMembers(candidate, new Set([
    'collectionId', 'snapshotRequired', 'serverCursor', 'serverRevision',
  ]), 'Bootstrap boundCollection');
  if (
    candidate.collectionId !== identity.collectionId
    || candidate.serverRevision !== identity.revision
    || candidate.serverCursor !== cursor
    || typeof candidate.snapshotRequired !== 'boolean'
  ) throw new TypeError('Bootstrap boundCollection differs from committed server identity.');
}

export function assertAppliedResult(candidate: AppliedResult): void {
  assertObject(candidate, 'Bootstrap applied result');
  nonEmpty(candidate.revision, 'Bootstrap applied revision');
  nonEmpty(candidate.cursor, 'Bootstrap applied cursor');
  if (candidate.boundCollection === undefined) {
    throw new TypeError('Bootstrap applied result requires boundCollection.');
  }
}

export function immutableIdentity(candidate: SessionBootstrapIdentity): SessionBootstrapIdentity {
  assertObject(candidate, 'Allocated bootstrap identity');
  assertMembers(candidate, new Set(['collectionId', 'rootNodeId', 'revision']), 'Allocated bootstrap identity');
  nonEmpty(candidate.collectionId, 'Allocated Collection id');
  nonEmpty(candidate.rootNodeId, 'Allocated Root id');
  nonEmpty(candidate.revision, 'Allocated bootstrap revision');
  if (new Set([candidate.collectionId, candidate.rootNodeId, candidate.revision]).size !== 3) {
    throw new TypeError('Allocated bootstrap identities must be distinct.');
  }
  return Object.freeze({ ...candidate });
}

export function immutableAggregate(
  candidate: SessionBootstrapCollectionAggregate,
  identity: SessionBootstrapIdentity,
): SessionBootstrapCollectionAggregate {
  const aggregate = immutableData(candidate, 'Bootstrap Collection aggregate');
  assertCanonical('collection', aggregate.collection);
  assertCanonical('node', aggregate.root);
  if (
    aggregate.collection.id !== identity.collectionId
    || aggregate.collection.rootNodeId !== identity.rootNodeId
    || aggregate.collection.revision !== identity.revision
    || aggregate.root.id !== identity.rootNodeId
    || aggregate.root.collectionId !== identity.collectionId
    || aggregate.root.revision !== identity.revision
    || aggregate.root.kind !== 'root'
    || aggregate.root.parentId !== null
    || aggregate.root.folderRole !== 'root'
  ) throw new TypeError('Bootstrap aggregate does not use the allocated server identity.');
  return aggregate;
}

export function boundSession(session: ActiveSyncSessionRecord, collectionId: string): ActiveSyncSessionRecord {
  return immutableData({
    ...session,
    sessionScope: 'collection',
    collectionId,
    purpose: null,
  }, 'Bound bootstrap Session');
}

export function terminatedSession(session: ActiveSyncSessionRecord, rejectedAt: string): SyncSessionRecord {
  return immutableData({
    ...session,
    status: 'terminated',
    terminationReason: 'bootstrap_rejected',
    terminatedAt: rejectedAt,
  }, 'Rejected bootstrap Session');
}

export function immutablePlan<Audit, Outbox, Transaction>(
  candidate: SessionBootstrapPrepared<Audit, Outbox, Transaction>,
): SessionBootstrapPrepared<Audit, Outbox, Transaction> {
  assertObject(candidate, 'Session bootstrap prepared result');
  const allowed = candidate.status === 'applied'
    ? new Set(['status', 'warnings', 'transform', 'apply', 'audit', 'outbox'])
    : candidate.status === 'deferred'
      ? new Set(['status', 'apply'])
      : candidate.status === 'rejected'
        ? new Set(['status', 'apply', 'audit'])
        : undefined;
  if (allowed === undefined) throw new TypeError('Session bootstrap prepare returned an invalid status.');
  assertMembers(candidate, allowed, 'Session bootstrap prepared result');
  if (typeof candidate.apply !== 'function') throw new TypeError('Session bootstrap apply must be a function.');
  if (candidate.status === 'applied') {
    if (!Array.isArray(candidate.warnings)) throw new TypeError('Applied bootstrap warnings must be an array.');
    const warnings = immutableData(candidate.warnings, 'Applied bootstrap warnings');
    const transform = candidate.transform === undefined
      ? undefined
      : immutableData(candidate.transform, 'Applied bootstrap transform');
    if (typeof candidate.audit !== 'function' || typeof candidate.outbox !== 'function') {
      throw new TypeError('Applied bootstrap requires Audit and Outbox builders.');
    }
    return Object.freeze({
      status: candidate.status,
      warnings,
      ...(transform === undefined ? {} : { transform }),
      apply: candidate.apply,
      audit: candidate.audit,
      outbox: candidate.outbox,
    }) as SessionBootstrapPrepared<Audit, Outbox, Transaction>;
  } else if (candidate.status === 'rejected' && typeof candidate.audit !== 'function') {
    throw new TypeError('Rejected bootstrap requires an Audit builder.');
  }
  return candidate.status === 'deferred'
    ? Object.freeze({ status: candidate.status, apply: candidate.apply })
    : Object.freeze({ status: candidate.status, apply: candidate.apply, audit: candidate.audit });
}

export function publicResult(result: SessionBootstrapResult): SessionBootstrapResult {
  return immutableData(result, 'Committed Session bootstrap result');
}

export function immutableReceipt(candidate: StoredSessionBootstrapReceipt): StoredSessionBootstrapReceipt {
  assertObject(candidate, 'Stored bootstrap receipt');
  assertMembers(candidate, new Set([
    'operationId', 'replicaId', 'sessionId', 'sequence', 'digest', 'status', 'result',
  ]), 'Stored bootstrap receipt');
  nonEmpty(candidate.operationId, 'Stored bootstrap receipt operationId');
  nonEmpty(candidate.replicaId, 'Stored bootstrap receipt replicaId');
  nonEmpty(candidate.sessionId, 'Stored bootstrap receipt sessionId');
  nonEmpty(candidate.digest, 'Stored bootstrap receipt digest');
  if (candidate.sequence !== 1) throw new TypeError('Stored bootstrap receipt Sequence must be 1.');
  if (candidate.status !== 'applied' && candidate.status !== 'deferred' && candidate.status !== 'rejected') {
    throw new TypeError('Stored bootstrap receipt has an invalid status.');
  }
  const receipt = immutableData(candidate, 'Stored bootstrap receipt');
  if (receipt.result.status !== receipt.status
    || receipt.result.opId !== receipt.operationId
    || receipt.result.sequence !== receipt.sequence) {
    throw new TypeError('Stored bootstrap receipt result identity is inconsistent.');
  }
  if (receipt.status === 'applied') assertAppliedResult(receipt.result as AppliedResult);
  if (receipt.status === 'deferred') assertCursorlessResult(receipt.result, 'deferred');
  if (receipt.status === 'rejected') assertCursorlessResult(receipt.result, 'rejected');
  return receipt;
}

/** Normalize + validate a deferred apply payload (identity + cursorless). */
export function finalizeDeferredResult(
  candidate: unknown,
  operation: CreateCollectionOperation,
): DeferredResult {
  const result = immutableData(candidate, 'Deferred bootstrap result') as DeferredResult;
  assertResultIdentity(result, operation, 'deferred');
  assertCursorlessResult(result, 'deferred');
  return result;
}

/** Normalize + validate a rejected apply payload (identity + cursorless). */
export function finalizeRejectedResult(
  candidate: unknown,
  operation: CreateCollectionOperation,
): RejectedResult {
  const result = immutableData(candidate, 'Rejected bootstrap result') as RejectedResult;
  assertResultIdentity(result, operation, 'rejected');
  assertCursorlessResult(result, 'rejected');
  return result;
}

/** Build boundCollection from committed identity + cursor, then validate. */
export function buildBoundCollection(
  identity: SessionBootstrapIdentity,
  cursor: string,
): SyncSessionCollectionResult {
  const boundCollection: SyncSessionCollectionResult = immutableData({
    collectionId: identity.collectionId,
    snapshotRequired: false,
    serverCursor: cursor,
    serverRevision: identity.revision,
  }, 'Bootstrap boundCollection');
  assertBoundCollection(boundCollection, identity, cursor);
  return boundCollection;
}

/**
 * Construct + validate the applied OperationResult for a successful bootstrap.
 *
 * Note: this helper's only consumer is the instance-scoped
 * `create_collection` lane in `session-bootstrap.ts` (`coordinateSessionBootstrap`)
 * — currently a package-only capability with no in-repo production consumer.
 * Kept with the lane it serves rather than deleted so the SYNC-0007 semantics
 * stay intact for hosts that wire the capability.
 */
export function buildAppliedResult(
  operation: CreateCollectionOperation,
  identity: SessionBootstrapIdentity,
  cursor: string,
  warnings: readonly Warning[],
  transform?: Readonly<Record<string, unknown>>,
): AppliedResult {
  const boundCollection = buildBoundCollection(identity, cursor);
  const result = immutableData({
    opId: operation.opId,
    sequence: 1,
    status: 'applied',
    warnings,
    revision: identity.revision,
    cursor,
    boundCollection,
    ...(transform === undefined ? {} : { transform }),
  }, 'Applied bootstrap result') as AppliedResult;
  assertResultIdentity(result, operation, 'applied');
  assertAppliedResult(result);
  return result;
}

/** Construct a durable receipt envelope for the given status + result. */
export function buildReceipt(
  operation: CreateCollectionOperation,
  sessionId: string,
  digest: string,
  status: SessionBootstrapStatus,
  result: AppliedResult | DeferredResult | RejectedResult,
): StoredSessionBootstrapReceipt {
  return immutableReceipt({
    operationId: operation.opId,
    replicaId: operation.replicaId,
    sessionId,
    sequence: 1,
    digest,
    status,
    result,
  });
}
