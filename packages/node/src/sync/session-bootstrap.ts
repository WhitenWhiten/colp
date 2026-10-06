import { assertMembers, assertObject, sameData } from './session-bootstrap-guards.js';
import { requirePromise, assertNonEmpty as nonEmpty } from './internal-guards.js';
import type {
  Collection,
  Node,
  Operation,
  OperationResult,
  SyncInstanceCreatePush,
  Warning,
} from '../types/index.js';
import { createValidatorRegistry, type DefinitionName, type ValidatorRegistry } from '../schema/index.js';
import { isRfc3339DateTime } from '../shared/date-time.js';
import {
  appendSyncOperationReuseAudit, claimSyncOperation, loadSyncOperationClaim,
  SyncOperationReceiptUnavailableError, syncOperationClaimsMatch,
} from './operation-reuse.js';
import type { SyncOperationClaim, SyncOperationReuseAudit, SyncOperationReuseTransaction } from './operation-reuse.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import type { ActiveSyncSessionRecord, SyncSessionRecord } from './session.js';
import { boundSession, buildAppliedResult, buildReceipt, finalizeDeferredResult, finalizeRejectedResult } from './session-bootstrap-state.js';
import { immutableAggregate, immutableIdentity, immutablePlan, immutableReceipt, publicResult, terminatedSession } from './session-bootstrap-state.js';

type CreateCollectionOperation = Extract<Operation, { readonly type: 'create_collection' }>;
type AppliedResult = Extract<OperationResult, { readonly status: 'applied' }>;
type DeferredResult = Extract<OperationResult, { readonly status: 'deferred' }>;
type RejectedResult = Extract<OperationResult, { readonly status: 'rejected' }>;
export type SessionBootstrapStatus = 'applied' | 'deferred' | 'rejected';

export interface SessionBootstrapRequest {
  readonly push: SyncInstanceCreatePush;
  readonly digest: string;
  readonly reevaluateDeferred?: boolean;
  /** Canonical server time used only if this execution is rejected. */
  readonly rejectedAt: string;
}

export interface SessionBootstrapLane {
  readonly replicaId: string;
  readonly sessionId: string;
}

export type SessionBootstrapSequenceLane =
  | { readonly scope: 'instance'; readonly replicaId: string; readonly sessionId: string }
  | { readonly scope: 'collection'; readonly replicaId: string; readonly collectionId: string };

export interface SessionBootstrapLaneState {
  readonly nextSequence: number;
}

export interface SessionBootstrapIdentity {
  readonly collectionId: string;
  readonly rootNodeId: string;
  readonly revision: string;
}

export interface SessionBootstrapCollectionAggregate {
  readonly collection: Collection;
  readonly root: Node;
}

export interface StoredSessionBootstrapReceipt {
  readonly operationId: string;
  readonly replicaId: string;
  readonly sessionId: string;
  readonly sequence: 1;
  readonly digest: string;
  readonly status: SessionBootstrapStatus;
  readonly result: AppliedResult | DeferredResult | RejectedResult;
}

export type SessionBootstrapReceiptWriteCondition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'replace_deferred'; readonly digest: string };

export interface SessionBootstrapReceiptStore {
  findByOperationId(operationId: string): Promise<StoredSessionBootstrapReceipt | undefined>;
  findByLane(lane: SessionBootstrapLane, sequence: 1): Promise<StoredSessionBootstrapReceipt | undefined>;
  save(
    receipt: StoredSessionBootstrapReceipt,
    condition: SessionBootstrapReceiptWriteCondition,
  ): Promise<void>;
}

export interface SessionBootstrapSessionStore {
  load(sessionId: string): Promise<SyncSessionRecord | undefined>;
  /**
   * Atomically replace only the exact active, instance-scoped, unbound Session
   * captured by this transaction. Compare the complete expected record (or an
   * equivalent storage version) with the current row in the same transaction.
   * Throw on a mismatch; never overwrite a bound or terminated Session. A
   * transaction-local read-back is not a substitute for this write condition.
   */
  save(session: SyncSessionRecord, expected: ActiveSyncSessionRecord): Promise<void>;
}

export interface SessionBootstrapLaneStore {
  load(lane: SessionBootstrapSequenceLane): Promise<SessionBootstrapLaneState | undefined>;
  save(lane: SessionBootstrapSequenceLane, state: SessionBootstrapLaneState): Promise<void>;
}

export interface SessionBootstrapCollectionStore {
  load(collectionId: string): Promise<SessionBootstrapCollectionAggregate | undefined>;
  save(aggregate: SessionBootstrapCollectionAggregate): Promise<void>;
}

export interface SessionBootstrapOperationStore {
  load(operationId: string): Promise<Operation | undefined>;
  append(operation: Operation): Promise<void>;
}

export interface SessionBootstrapArtifactStore<Artifact> {
  /** Returns a durable transaction-local key suitable for read-back. */
  append(artifact: Artifact): Promise<string>;
  load(key: string): Promise<Artifact | undefined>;
}

export interface SessionBootstrapTransaction<Audit, Outbox> extends SyncOperationReuseTransaction {
  readonly receipts: SessionBootstrapReceiptStore;
  readonly sessions: SessionBootstrapSessionStore;
  readonly lanes: SessionBootstrapLaneStore;
  readonly collections: SessionBootstrapCollectionStore;
  readonly operations: SessionBootstrapOperationStore;
  readonly audits: SessionBootstrapArtifactStore<Audit>;
  readonly outbox: SessionBootstrapArtifactStore<Outbox>;
  allocateIdentity(): Promise<SessionBootstrapIdentity>;
  allocateCursor(): Promise<string>;
  loadCursor(cursor: string): Promise<string | undefined>;
}

export interface SessionBootstrapUnitOfWork<
  Audit,
  Outbox,
  Transaction extends SessionBootstrapTransaction<Audit, Outbox> = SessionBootstrapTransaction<Audit, Outbox>,
> {
  /**
   * Prevents this unit of work from also acting as another operation-ID owner.
   * Compile-time brand only; host + claim-store discipline provide exclusivity.
   */
  readonly operationIdReservationOwner: 'session-bootstrap';
  /**
   * Serialize by lane.sessionId across all processes and Replica IDs, including
   * concurrent Session termination. The full lane remains the receipt identity,
   * not the lock key: distinct Replicas can otherwise overwrite one Session.
   * Commit every mutation atomically, resolve only after a known commit, and
   * reject after rollback or an uncertain commit outcome. Session save must
   * additionally enforce its expected-record condition under that transaction.
   */
  execute<Value>(
    lane: SessionBootstrapLane,
    work: (transaction: Transaction) => Promise<Value>,
  ): Promise<Value>;
}

export interface SessionBootstrapCommitContext {
  readonly operation: CreateCollectionOperation;
  readonly result: AppliedResult | RejectedResult;
  readonly receipt: StoredSessionBootstrapReceipt;
  readonly session: SyncSessionRecord;
  readonly aggregate?: SessionBootstrapCollectionAggregate;
  readonly cursor?: string;
}

export type SessionBootstrapArtifactBuilder<Artifact> = (
  context: SessionBootstrapCommitContext,
) => Promise<Artifact>;

export type SessionBootstrapPrepared<
  Audit,
  Outbox,
  Transaction,
> =
  | {
      readonly status: 'applied';
      readonly warnings: readonly Warning[];
      readonly transform?: Readonly<Record<string, unknown>>;
      readonly apply: (
        transaction: Transaction,
        identity: SessionBootstrapIdentity,
        cursor: string,
      ) => Promise<SessionBootstrapCollectionAggregate>;
      readonly audit: SessionBootstrapArtifactBuilder<Audit>;
      readonly outbox: SessionBootstrapArtifactBuilder<Outbox>;
    }
  | {
      readonly status: 'deferred';
      readonly apply: (transaction: Transaction) => Promise<DeferredResult>;
    }
  | {
      readonly status: 'rejected';
      readonly apply: (transaction: Transaction) => Promise<RejectedResult>;
      readonly audit: SessionBootstrapArtifactBuilder<Audit>;
    };

export interface SessionBootstrapPrepareContext {
  readonly request: SessionBootstrapRequest;
  readonly operation: CreateCollectionOperation;
  readonly session: ActiveSyncSessionRecord;
  readonly previousDeferredReceipt?: StoredSessionBootstrapReceipt;
}

export type SessionBootstrapPrepare<Audit, Outbox, Transaction> = (
  context: SessionBootstrapPrepareContext,
  transaction: Transaction,
) => Promise<SessionBootstrapPrepared<Audit, Outbox, Transaction>>;

export type SessionBootstrapResult =
  | { readonly kind: 'executed' | 'replayed'; readonly result: AppliedResult | DeferredResult | RejectedResult }
  /** Reuse denial; `auditKey` / `audit` identify the audit persisted with it. */
  | {
      readonly kind: 'op_id_reused' | 'sequence_reuse';
      readonly auditKey: string;
      readonly audit: SyncOperationReuseAudit;
    }
  | { readonly kind: 'session_unavailable' };

const REQUEST_KEYS = new Set(['push', 'digest', 'reevaluateDeferred', 'rejectedAt']);
const PUSH_KEYS = new Set(['sessionId', 'batchId', 'atomic', 'operations']);
const OPERATION_KEYS = new Set([
  'opId',
  'replicaId',
  'sequence',
  'type',
  'occurredAt',
  'dependencies',
  'baseRevision',
  'payload',
  'source',
]);
const REQUIRED_SCOPES = ['sync:bootstrap', 'sync:push', 'collections:create'] as const;
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


function immutableData<Value>(value: Value, label: string, seen = new Set<object>()): Value {
  return immutableJsonData(value, label, seen);
}

function mutableData<Value>(value: Value): Value {
  return structuredClone(value) as Value;
}


function immutableRequest(candidate: SessionBootstrapRequest): SessionBootstrapRequest {
  assertObject(candidate, 'Session bootstrap request');
  assertMembers(candidate, REQUEST_KEYS, 'Session bootstrap request');
  nonEmpty(candidate.digest, 'Session bootstrap digest');
  nonEmpty(candidate.rejectedAt, 'Session bootstrap rejectedAt');
  if (!isRfc3339DateTime(candidate.rejectedAt)) {
    throw new TypeError('Session bootstrap rejectedAt must be an RFC 3339 date-time.');
  }
  if (!Number.isFinite(new Date(candidate.rejectedAt).getTime())) {
    throw new TypeError('Session bootstrap rejectedAt must be a representable date-time.');
  }
  if (candidate.reevaluateDeferred !== undefined && typeof candidate.reevaluateDeferred !== 'boolean') {
    throw new TypeError('Session bootstrap reevaluateDeferred must be a boolean.');
  }
  assertObject(candidate.push, 'Sync instance create Push');
  assertMembers(candidate.push, PUSH_KEYS, 'Sync instance create Push');
  nonEmpty(candidate.push.sessionId, 'Sync instance create Push sessionId');
  nonEmpty(candidate.push.batchId, 'Sync instance create Push batchId');
  if (candidate.push.atomic !== true) throw new TypeError('Sync instance create Push atomic must be true.');
  if (!Array.isArray(candidate.push.operations) || candidate.push.operations.length !== 1) {
    throw new TypeError('Sync instance create Push must contain exactly one Operation.');
  }
  const operation = candidate.push.operations[0] as CreateCollectionOperation;
  assertObject(operation, 'Sync instance create Operation');
  assertMembers(operation, OPERATION_KEYS, 'Sync instance create Operation');
  nonEmpty(operation.opId, 'Sync instance create Operation opId');
  nonEmpty(operation.replicaId, 'Sync instance create Operation replicaId');
  nonEmpty(operation.occurredAt, 'Sync instance create Operation occurredAt');
  if (operation.type !== 'create_collection') throw new TypeError('Bootstrap Operation must be create_collection.');
  if (operation.sequence !== 1) throw new TypeError('Bootstrap Operation Sequence must be 1.');
  if (operation.baseRevision !== null) throw new TypeError('Bootstrap Operation baseRevision must be null.');
  if (Object.hasOwn(operation, 'collectionId') || Object.hasOwn(operation, 'targetId')) {
    throw new TypeError('Bootstrap Operation must omit collectionId and targetId.');
  }
  assertObject(operation.payload, 'Bootstrap create_collection payload');
  assertMembers(operation.payload, new Set(['collection', 'root']), 'Bootstrap create_collection payload');
  if (!Object.hasOwn(operation.payload, 'collection') || !Object.hasOwn(operation.payload, 'root')) {
    throw new TypeError('Bootstrap create_collection payload requires collection and root.');
  }
  assertCanonical('syncInstanceCreatePush', candidate.push);
  return immutableData({
    push: candidate.push,
    digest: candidate.digest,
    ...(candidate.reevaluateDeferred === undefined ? {} : { reevaluateDeferred: candidate.reevaluateDeferred }),
    rejectedAt: candidate.rejectedAt,
  }, 'Session bootstrap request');
}

function immutableSession(candidate: SyncSessionRecord): SyncSessionRecord {
  return immutableData(candidate, 'Stored bootstrap Session');
}

function eligibleSession(candidate: SyncSessionRecord | undefined, request: SessionBootstrapRequest): ActiveSyncSessionRecord | undefined {
  if (candidate === undefined) return undefined;
  const session = immutableSession(candidate);
  if (!Array.isArray(session.authorizationScopes)) {
    throw new TypeError('Stored bootstrap Session authorizationScopes must be an array.');
  }
  if (
    session.status !== 'active'
    || session.sessionId !== request.push.sessionId
    || session.sessionScope !== 'instance'
    || session.collectionId !== null
    || session.purpose !== 'create_collection'
    || !REQUIRED_SCOPES.every((scope) => session.authorizationScopes.includes(scope))
  ) return undefined;
  return session;
}

function laneFor(request: SessionBootstrapRequest): SessionBootstrapLane {
  const operation = request.push.operations[0]!;
  return Object.freeze({ replicaId: operation.replicaId, sessionId: request.push.sessionId });
}

function claimForRequest(request: SessionBootstrapRequest): SyncOperationClaim {
  const operation = request.push.operations[0]!;
  return Object.freeze({
    operationId: operation.opId,
    digest: request.digest,
    replicaId: operation.replicaId,
    sequenceScope: request.push.sessionId,
    sequence: 1,
  });
}

function claimForReceipt(receipt: StoredSessionBootstrapReceipt): SyncOperationClaim {
  return Object.freeze({
    operationId: receipt.operationId,
    digest: receipt.digest,
    replicaId: receipt.replicaId,
    sequenceScope: receipt.sessionId,
    sequence: receipt.sequence,
  });
}

async function verifiedReceiptClaim<Audit, Outbox>(
  transaction: SessionBootstrapTransaction<Audit, Outbox>,
  receipt: StoredSessionBootstrapReceipt,
): Promise<SyncOperationClaim> {
  const expected = claimForReceipt(receipt);
  const stored = await loadSyncOperationClaim(transaction.operationClaims, receipt.operationId);
  if (stored === undefined || !syncOperationClaimsMatch(stored, expected)) {
    throw new TypeError('Bootstrap receipt and lifetime Operation claim are inconsistent.');
  }
  return stored;
}

function instanceSequenceLane(lane: SessionBootstrapLane): SessionBootstrapSequenceLane {
  return Object.freeze({ scope: 'instance', replicaId: lane.replicaId, sessionId: lane.sessionId });
}

function collectionSequenceLane(replicaId: string, collectionId: string): SessionBootstrapSequenceLane {
  return Object.freeze({ scope: 'collection', replicaId, collectionId });
}

function assertLaneState(candidate: SessionBootstrapLaneState | undefined, expected: number, label: string): void {
  if (candidate === undefined) {
    if (expected !== 1) throw new TypeError(`${label} was not persisted.`);
    return;
  }
  assertObject(candidate, label);
  assertMembers(candidate, new Set(['nextSequence']), label);
  if (candidate.nextSequence !== expected) throw new TypeError(`${label} has an unexpected nextSequence.`);
}

async function appendAndVerify<Artifact>(
  store: SessionBootstrapArtifactStore<Artifact>,
  artifact: Artifact,
  label: string,
): Promise<void> {
  const immutable = immutableData(artifact, label);
  const key = await requirePromise(store.append(mutableData(immutable)), `${label} append`);
  nonEmpty(key, `${label} key`);
  const reloaded = await requirePromise(store.load(key), `${label} read-back`);
  if (reloaded === undefined || !sameData(immutableData(reloaded, `${label} read-back`), immutable)) {
    throw new TypeError(`${label} failed transaction-local read-back verification.`);
  }
}

async function loadReceiptPair<Audit, Outbox>(
  transaction: SessionBootstrapTransaction<Audit, Outbox>,
  request: SessionBootstrapRequest,
  lane: SessionBootstrapLane,
): Promise<{ readonly byOperation?: StoredSessionBootstrapReceipt; readonly byLane?: StoredSessionBootstrapReceipt }> {
  const operation = request.push.operations[0]!;
  const byOperationRaw = await requirePromise(
    transaction.receipts.findByOperationId(operation.opId),
    'Bootstrap receipt operation-id load',
  );
  const byLaneRaw = await requirePromise(
    transaction.receipts.findByLane(mutableData(lane), 1),
    'Bootstrap receipt lane load',
  );
  const pair = Object.freeze({
    ...(byOperationRaw === undefined ? {} : { byOperation: immutableReceipt(byOperationRaw) }),
    ...(byLaneRaw === undefined ? {} : { byLane: immutableReceipt(byLaneRaw) }),
  });
  if (pair.byOperation !== undefined && pair.byOperation.operationId !== operation.opId) {
    throw new TypeError('Bootstrap operation-id index returned a receipt for another Operation.');
  }
  if (pair.byLane !== undefined
    && (pair.byLane.replicaId !== lane.replicaId || pair.byLane.sessionId !== lane.sessionId)) {
    throw new TypeError('Bootstrap lane index returned a receipt for another lane.');
  }
  const operationPointsAtLane = pair.byOperation !== undefined
    && pair.byOperation.replicaId === lane.replicaId
    && pair.byOperation.sessionId === lane.sessionId;
  const lanePointsAtOperation = pair.byLane?.operationId === operation.opId;
  if ((operationPointsAtLane || lanePointsAtOperation)
    && (pair.byOperation === undefined || pair.byLane === undefined || !sameData(pair.byOperation, pair.byLane))) {
    throw new TypeError('Bootstrap receipt durable indexes are inconsistent.');
  }
  return pair;
}

async function saveReceiptAndVerify<Audit, Outbox>(
  transaction: SessionBootstrapTransaction<Audit, Outbox>,
  receipt: StoredSessionBootstrapReceipt,
  condition: SessionBootstrapReceiptWriteCondition,
  request: SessionBootstrapRequest,
  lane: SessionBootstrapLane,
): Promise<StoredSessionBootstrapReceipt> {
  await requirePromise(
    transaction.receipts.save(mutableData(receipt), mutableData(condition)),
    'Bootstrap receipt save',
  );
  const pair = await loadReceiptPair(transaction, request, lane);
  if (pair.byOperation === undefined || pair.byLane === undefined
    || !sameData(pair.byOperation, receipt) || !sameData(pair.byLane, receipt)) {
    throw new TypeError('Bootstrap receipt was not staged under both durable indexes.');
  }
  return pair.byOperation;
}

async function saveLaneAndVerify<Audit, Outbox>(
  transaction: SessionBootstrapTransaction<Audit, Outbox>,
  lane: SessionBootstrapSequenceLane,
  nextSequence: number,
): Promise<void> {
  await requirePromise(transaction.lanes.save(mutableData(lane), { nextSequence }), 'Bootstrap lane save');
  const reloaded = await requirePromise(transaction.lanes.load(mutableData(lane)), 'Bootstrap lane read-back');
  assertLaneState(reloaded, nextSequence, 'Bootstrap lane read-back');
}

async function saveSessionAndVerify<Audit, Outbox>(
  transaction: SessionBootstrapTransaction<Audit, Outbox>,
  session: SyncSessionRecord,
  expected: ActiveSyncSessionRecord,
): Promise<SyncSessionRecord> {
  await requirePromise(
    transaction.sessions.save(mutableData(session), mutableData(expected)),
    'Bootstrap Session conditional save',
  );
  const reloaded = await requirePromise(transaction.sessions.load(session.sessionId), 'Bootstrap Session read-back');
  if (reloaded === undefined || !sameData(immutableSession(reloaded), session)) {
    throw new TypeError('Bootstrap Session failed transaction-local read-back verification.');
  }
  return immutableSession(reloaded);
}

async function appendOperationAndVerify<Audit, Outbox>(
  transaction: SessionBootstrapTransaction<Audit, Outbox>,
  operation: CreateCollectionOperation,
): Promise<void> {
  await requirePromise(transaction.operations.append(mutableData(operation)), 'Bootstrap Operation append');
  const reloaded = await requirePromise(transaction.operations.load(operation.opId), 'Bootstrap Operation read-back');
  if (reloaded === undefined || !sameData(immutableData(reloaded, 'Bootstrap Operation read-back'), operation)) {
    throw new TypeError('Bootstrap Operation failed transaction-local read-back verification.');
  }
}

/**
 * Coordinates the single create_collection bootstrap in one durable,
 * Session-serialized transaction. This module intentionally supplies no
 * in-memory store and performs no Publisher HTTP CRUD.
 * It is an alternative top-level owner to the Push and Sequence coordinators.
 *
 * Package-only capability, no known production consumer: the lane requires an
 * instance-scoped Session carrying `collections:create`, which no known
 * backend issues (see docs/SYNC_WIRE_COMPLETENESS.md for the honest status).
 */
export async function coordinateSessionBootstrap<
  Audit,
  Outbox,
  Transaction extends SessionBootstrapTransaction<Audit, Outbox> = SessionBootstrapTransaction<Audit, Outbox>,
>(
  unitOfWork: SessionBootstrapUnitOfWork<Audit, Outbox, Transaction>,
  candidateRequest: SessionBootstrapRequest,
  prepare: SessionBootstrapPrepare<Audit, Outbox, Transaction>,
): Promise<SessionBootstrapResult> {
  if (typeof prepare !== 'function') throw new TypeError('Session bootstrap prepare must be a function.');
  const request = immutableRequest(candidateRequest);
  const operation = request.push.operations[0]! as CreateCollectionOperation;
  const lane = laneFor(request);
  let invocations = 0;
  let callbackResult: SessionBootstrapResult | undefined;

  const outcome = await requirePromise(unitOfWork.execute(mutableData(lane), async (transaction) => {
    invocations += 1;
    if (invocations !== 1) throw new TypeError('Session bootstrap UnitOfWork must invoke its callback exactly once.');
    assertObject(transaction, 'Session bootstrap transaction');

    const pair = await loadReceiptPair(transaction, request, lane);
    const attemptedClaim = claimForRequest(request);
    const operationClaim = pair.byOperation === undefined
      ? undefined
      : await verifiedReceiptClaim(transaction, pair.byOperation);
    const laneClaim = pair.byLane === undefined
      ? undefined
      : await verifiedReceiptClaim(transaction, pair.byLane);
    let previousDeferredReceipt: StoredSessionBootstrapReceipt | undefined;
    if (pair.byLane !== undefined) {
      const exact = pair.byOperation !== undefined
        && sameData(pair.byOperation, pair.byLane)
        && syncOperationClaimsMatch(attemptedClaim, laneClaim!);
      if (!exact) {
        if (pair.byLane.digest !== request.digest) {
          const denial = await appendSyncOperationReuseAudit(
            transaction.reuseAudits,
            'sequence_reuse',
            attemptedClaim,
            laneClaim!,
          );
          callbackResult = Object.freeze({
            kind: 'sequence_reuse' as const, auditKey: denial.key, audit: denial.audit,
          });
          return callbackResult;
        }
        if (operationClaim !== undefined && operationClaim.digest !== request.digest) {
          const denial = await appendSyncOperationReuseAudit(
            transaction.reuseAudits,
            'op_id_reused',
            attemptedClaim,
            operationClaim,
          );
          callbackResult = Object.freeze({
            kind: 'op_id_reused' as const, auditKey: denial.key, audit: denial.audit,
          });
          return callbackResult;
        }
        const denial = await appendSyncOperationReuseAudit(
          transaction.reuseAudits,
          'sequence_reuse',
          attemptedClaim,
          laneClaim!,
        );
        callbackResult = Object.freeze({
          kind: 'sequence_reuse' as const, auditKey: denial.key, audit: denial.audit,
        });
        return callbackResult;
      }
      const stored = pair.byLane;
      if (stored.status !== 'deferred' || request.reevaluateDeferred !== true) {
        callbackResult = Object.freeze({ kind: 'replayed', result: stored.result });
        return callbackResult;
      }
      previousDeferredReceipt = stored;
    } else if (pair.byOperation !== undefined) {
      if (operationClaim!.digest !== request.digest) {
        const denial = await appendSyncOperationReuseAudit(
          transaction.reuseAudits,
          'op_id_reused',
          attemptedClaim,
          operationClaim!,
        );
        callbackResult = Object.freeze({
          kind: 'op_id_reused' as const, auditKey: denial.key, audit: denial.audit,
        });
        return callbackResult;
      }
      throw new TypeError('Bootstrap Operation receipt is missing its lane index.');
    }

    const retainedClaim = await loadSyncOperationClaim(
      transaction.operationClaims,
      operation.opId,
    );
    if (retainedClaim !== undefined && pair.byOperation === undefined) {
      if (retainedClaim.digest !== request.digest) {
        const denial = await appendSyncOperationReuseAudit(
          transaction.reuseAudits,
          'op_id_reused',
          attemptedClaim,
          retainedClaim,
        );
        callbackResult = Object.freeze({
          kind: 'op_id_reused' as const, auditKey: denial.key, audit: denial.audit,
        });
        return callbackResult;
      }
      throw new SyncOperationReceiptUnavailableError('Lifetime Operation claim exists without its bootstrap receipt.');
    }

    const rawSession = await requirePromise(
      transaction.sessions.load(request.push.sessionId),
      'Bootstrap Session load',
    );
    const session = eligibleSession(rawSession, request);
    if (session === undefined) {
      callbackResult = Object.freeze({ kind: 'session_unavailable' as const });
      return callbackResult;
    }
    const instanceLane = instanceSequenceLane(lane);
    const instanceState = await requirePromise(transaction.lanes.load(mutableData(instanceLane)), 'Instance lane load');
    assertLaneState(instanceState, 1, 'Instance lane');
    if (previousDeferredReceipt === undefined) {
      const claimResult = await claimSyncOperation(transaction, attemptedClaim);
      if (claimResult.kind === 'existing') {
        if (claimResult.claim.digest !== request.digest) {
          const denial = await appendSyncOperationReuseAudit(
            transaction.reuseAudits,
            'op_id_reused',
            attemptedClaim,
            claimResult.claim,
          );
          callbackResult = Object.freeze({
            kind: 'op_id_reused' as const, auditKey: denial.key, audit: denial.audit,
          });
          return callbackResult;
        }
        throw new SyncOperationReceiptUnavailableError('Lifetime Operation claim exists without its bootstrap receipt.');
      }
    }
    const plan = immutablePlan(await requirePromise(prepare(Object.freeze({
      request,
      operation,
      session,
      ...(previousDeferredReceipt === undefined ? {} : { previousDeferredReceipt }),
    }), transaction), 'Session bootstrap prepare'));
    const condition: SessionBootstrapReceiptWriteCondition = previousDeferredReceipt === undefined
      ? Object.freeze({ kind: 'absent' })
      : Object.freeze({ kind: 'replace_deferred', digest: request.digest });

    if (plan.status === 'deferred') {
      if (previousDeferredReceipt !== undefined) {
        callbackResult = Object.freeze({ kind: 'replayed' as const, result: previousDeferredReceipt.result });
        return callbackResult;
      }
      const result = finalizeDeferredResult(
        await requirePromise(plan.apply(transaction), 'Deferred bootstrap apply'),
        operation,
      );
      const receipt = buildReceipt(operation, request.push.sessionId, request.digest, 'deferred', result);
      const saved = await saveReceiptAndVerify(transaction, receipt, condition, request, lane);
      callbackResult = Object.freeze({ kind: 'executed' as const, result: saved.result });
      return callbackResult;
    }

    if (plan.status === 'rejected') {
      const result = finalizeRejectedResult(
        await requirePromise(plan.apply(transaction), 'Rejected bootstrap apply'),
        operation,
      );
      await appendOperationAndVerify(transaction, operation);
      const terminated = await saveSessionAndVerify(transaction, terminatedSession(session, request.rejectedAt), session);
      await saveLaneAndVerify(transaction, instanceLane, 2);
      const receipt = buildReceipt(operation, request.push.sessionId, request.digest, 'rejected', result);
      const saved = await saveReceiptAndVerify(transaction, receipt, condition, request, lane);
      const context = immutableData({ operation, result, receipt: saved, session: terminated }, 'Rejected bootstrap context');
      await appendAndVerify(transaction.audits, await requirePromise(plan.audit(context), 'Rejected bootstrap Audit builder'), 'Rejected bootstrap Audit');
      callbackResult = Object.freeze({ kind: 'executed' as const, result: saved.result });
      return callbackResult;
    }

    const identity = immutableIdentity(await requirePromise(transaction.allocateIdentity(), 'Bootstrap identity allocation'));
    const existing = await requirePromise(transaction.collections.load(identity.collectionId), 'Allocated Collection collision check');
    if (existing !== undefined) throw new TypeError('Allocated Collection id is already in use.');
    const cursor = await requirePromise(transaction.allocateCursor(), 'Bootstrap Cursor allocation');
    nonEmpty(cursor, 'Allocated bootstrap Cursor');
    const reloadedCursor = await requirePromise(transaction.loadCursor(cursor), 'Bootstrap Cursor read-back');
    if (reloadedCursor !== cursor) throw new TypeError('Bootstrap Cursor failed transaction-local read-back verification.');
    const aggregate = immutableAggregate(
      await requirePromise(plan.apply(transaction, mutableData(identity), cursor), 'Applied bootstrap apply'),
      identity,
    );
    await requirePromise(transaction.collections.save(mutableData(aggregate)), 'Bootstrap Collection save');
    const reloadedAggregateRaw = await requirePromise(
      transaction.collections.load(identity.collectionId),
      'Bootstrap Collection read-back',
    );
    if (reloadedAggregateRaw === undefined) throw new TypeError('Bootstrap Collection was not persisted.');
    const reloadedAggregate = immutableAggregate(reloadedAggregateRaw, identity);
    if (!sameData(aggregate, reloadedAggregate)) {
      throw new TypeError('Bootstrap Collection failed transaction-local read-back verification.');
    }
    const result = buildAppliedResult(
      operation,
      identity,
      cursor,
      plan.warnings,
      plan.transform,
    );
    await appendOperationAndVerify(transaction, operation);
    const bound = await saveSessionAndVerify(transaction, boundSession(session, identity.collectionId), session);
    await saveLaneAndVerify(transaction, collectionSequenceLane(operation.replicaId, identity.collectionId), 1);
    await saveLaneAndVerify(transaction, instanceLane, 2);
    const receipt = buildReceipt(operation, request.push.sessionId, request.digest, 'applied', result);
    const saved = await saveReceiptAndVerify(transaction, receipt, condition, request, lane);
    const context = immutableData({
      operation,
      result,
      receipt: saved,
      session: bound,
      aggregate: reloadedAggregate,
      cursor,
    }, 'Applied bootstrap context');
    await appendAndVerify(transaction.audits, await requirePromise(plan.audit(context), 'Applied bootstrap Audit builder'), 'Applied bootstrap Audit');
    await appendAndVerify(transaction.outbox, await requirePromise(plan.outbox(context), 'Applied bootstrap Outbox builder'), 'Applied bootstrap Outbox');
    callbackResult = Object.freeze({ kind: 'executed' as const, result: saved.result });
    return callbackResult;
  }), 'Session bootstrap UnitOfWork execute');

  if (invocations !== 1 || callbackResult === undefined || outcome !== callbackResult) {
    throw new TypeError('Session bootstrap UnitOfWork must return its callback result by identity exactly once.');
  }
  return publicResult(outcome);
}
