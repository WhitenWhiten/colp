import type { Operation, OperationResult } from '../types/index.js';
import type {
  StoredOperationReceipt,
  SyncTransaction,
  SyncUnitOfWork,
} from './index.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import {
  pushExecutionScope,
  type PushExecutionScope,
  type PushReceiptWriteCondition,
} from './push-unit-of-work.js';
import {
  assertNonEmpty,
  requirePromise,
} from './internal-guards.js';
import {
  assertCanonicalOperation,
  assertExactObject,
  assertOperationResultShape,
  immutablePlan,
  immutableRequest,
  immutableStoredReceipt,
} from './push-transaction-guards.js';
import {
  appendSyncOperationReuseAudit,
  claimSyncOperation,
  claimSyncOperations,
  loadSyncOperationClaim,
  SyncOperationReceiptUnavailableError,
  SyncOperationReuseError,
  syncOperationClaimsMatch,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
} from './operation-reuse.js';

type Status = OperationResult['status'];
type ResultWithStatus<S extends Status> = Extract<OperationResult, { readonly status: S }>;
type CursorResultStatus = 'applied' | 'rebased' | 'conflicted';
type CursorlessResult<S extends CursorResultStatus> = Omit<ResultWithStatus<S>, 'cursor'>;

export interface PushConflictRecord {
  readonly id: string;
}

export interface PushTransactionOperation {
  readonly operation: Operation;
  readonly sequenceScope: string;
  readonly digest: string;
}

export interface PushTransactionRequest {
  readonly batchId: string;
  readonly atomic: boolean;
  /** Authoritative cursor observed immediately before this coordinator is called. */
  readonly serverCursor: string;
  readonly operations: readonly [PushTransactionOperation, ...PushTransactionOperation[]];
  /**
   * Explicitly permits a persisted deferred receipt to be evaluated again,
   * with the same semantics as {@link SequenceOperationRequest.reevaluateDeferred}.
   * Without this flag a stored deferred receipt replays exactly.
   */
  readonly reevaluateDeferred?: boolean;
}

export interface PushTransactionResult {
  readonly batchId: string;
  readonly results: readonly OperationResult[];
  readonly serverCursor: string;
}

export interface PushCommitContext<Conflict extends PushConflictRecord> {
  readonly operation: Operation;
  readonly result: OperationResult;
  readonly receipt: StoredOperationReceipt<OperationResult>;
  readonly cursor?: string;
  readonly conflict?: Conflict;
}

export type PushArtifactBuilder<Artifact, Conflict extends PushConflictRecord> = (
  context: PushCommitContext<Conflict>,
) => Promise<Artifact>;

interface PreparedBase<S extends Status, Transaction> {
  readonly status: S;
  readonly apply: (
    transaction: Transaction,
    cursor: S extends CursorResultStatus ? string : undefined,
  ) => Promise<unknown>;
}

export type PushPreparedOperation<
  Transaction,
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
> =
  | (PreparedBase<'applied', Transaction> & {
      readonly apply: (transaction: Transaction, cursor: string) => Promise<CursorlessResult<'applied'>>;
      readonly audit: PushArtifactBuilder<Audit, Conflict>;
      readonly outbox: PushArtifactBuilder<Outbox, Conflict>;
    })
  | (PreparedBase<'rebased', Transaction> & {
      readonly apply: (transaction: Transaction, cursor: string) => Promise<CursorlessResult<'rebased'>>;
      readonly audit: PushArtifactBuilder<Audit, Conflict>;
      readonly outbox: PushArtifactBuilder<Outbox, Conflict>;
    })
  | (PreparedBase<'conflicted', Transaction> & {
      readonly apply: (
        transaction: Transaction,
        cursor: string,
      ) => Promise<{ readonly result: CursorlessResult<'conflicted'>; readonly conflict: Conflict }>;
      readonly audit: PushArtifactBuilder<Audit, Conflict>;
      readonly outbox: PushArtifactBuilder<Outbox, Conflict>;
    })
  | (PreparedBase<'noop', Transaction> & {
      readonly apply: (transaction: Transaction, cursor: undefined) => Promise<ResultWithStatus<'noop'>>;
      readonly audit: PushArtifactBuilder<Audit, Conflict>;
    })
  | (PreparedBase<'rejected', Transaction> & {
      readonly apply: (
        transaction: Transaction,
        cursor: undefined,
      ) => Promise<ResultWithStatus<'rejected'>>;
      readonly audit: PushArtifactBuilder<Audit, Conflict>;
    })
  | (PreparedBase<'deferred', Transaction> & {
      readonly apply: (
        transaction: Transaction,
        cursor: undefined,
      ) => Promise<ResultWithStatus<'deferred'>>;
    });

/**
 * Evaluation context handed to Push preflight.
 *
 * `previousDeferredReceipt` is present only when a persisted deferred receipt
 * is being re-evaluated under `PushTransactionRequest.reevaluateDeferred` —
 * the same shape Sequence passes as {@link SequenceEvaluationContext}.
 */
export interface PushPreflightContext {
  readonly previousDeferredReceipt?: StoredOperationReceipt<OperationResult>;
  /** Identity of this atomic preparation pass; never reused after rollback or across requests. */
  readonly atomicBatch?: object;
}

export type PushPreflight<
  Transaction,
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
> = (
  operation: PushTransactionOperation,
  index: number,
  context?: PushPreflightContext,
) => Promise<PushPreparedOperation<Transaction, Conflict, Audit, Outbox>>;

/**
 * Pure preparation callback for the Push coordinator ownership boundary.
 *
 * The callback MUST NOT commit durable state, perform irreversible external effects,
 * or invoke another operation-ID-owning coordinator. All writes belong in the
 * returned plan's transaction-bound callbacks.
 */
export type PurePushPreflight<
  Transaction,
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
> = PushPreflight<Transaction, Conflict, Audit, Outbox>;

/**
 * Marks Push as the sole operation-ID reservation owner for this transaction boundary.
 *
 * This field is a compile-time ownership brand, not a runtime mutex.
 * Hosts (and claim-store discipline) must ensure only one coordinator — Push **or**
 * Sequence — claims operation IDs for a given write path. There is no cross-coordinator
 * lock; nesting Push and Sequence on the same request boundary is a host contract
 * violation, not something this brand can prevent at runtime.
 */
export interface PushOperationIdOwner {
  readonly operationIdReservationOwner: 'push';
}

export class AtomicPushNotCommittableError extends Error {
  public constructor() {
    super('An atomic Push operation did not reach a committable terminal status during preflight.');
    this.name = 'AtomicPushNotCommittableError';
  }
}

/** Identity of the non-atomic Push operation that was denied. */
export interface PushDeniedOperation {
  readonly index: number;
  readonly opId: string;
  readonly replicaId: string;
  readonly sequenceScope: string;
  readonly sequence: number;
  readonly digest: string;
}

/** Durable progress a non-atomic Push made before a reuse denial. */
export interface PushPartialProgress {
  readonly batchId: string;
  /** Results of operations `0 … failed.index - 1`; each is committed or a stored replay. */
  readonly results: readonly OperationResult[];
  readonly failed: PushDeniedOperation;
  /** Latest cursor committed by this invocation, else the request's `serverCursor`. */
  readonly serverCursor: string;
}

/**
 * Non-atomic Push reuse denial that keeps the committed prefix visible.
 *
 * It is a {@link SyncOperationReuseError}: hosts still answer `409
 * sequence_reuse` / `op_id_reused` with the persisted audit (`auditKey`,
 * `audit`). `progress` reports what already committed so the client can
 * persist those results, then inspect and repair the denied operation. The
 * committed operations replay their stored results if sent again; the denied
 * operation will not succeed unchanged. Atomic batches never throw this
 * class, because a denial there commits no operation.
 */
export class PushOperationReuseError extends SyncOperationReuseError {
  readonly progress: PushPartialProgress;

  constructor(auditKey: string, audit: SyncOperationReuseAudit, progress: PushPartialProgress) {
    super(auditKey, audit);
    this.name = 'PushOperationReuseError';
    this.progress = immutableData(progress, 'Push partial progress');
  }
}

function assertAtomicCommittable(status: Status): void {
  // Conflicts are durable business outcomes; a rejection or pending operation
  // cannot satisfy admission for an all-or-nothing request.
  if (status === 'deferred' || status === 'rejected') {
    throw new AtomicPushNotCommittableError();
  }
}

function immutableData<Value>(value: Value, label: string, seen = new Set<object>()): Value {
  return immutableJsonData(value, label, seen);
}

function mutableData<Value>(value: Value): Value {
  return structuredClone(value) as Value;
}

function receiptFor(
  item: PushTransactionOperation,
  result: OperationResult,
): StoredOperationReceipt<OperationResult> {
  return immutableData({
    operationId: item.operation.opId,
    replicaId: item.operation.replicaId,
    sequenceScope: item.sequenceScope,
    sequence: item.operation.sequence,
    digest: item.digest,
    status: result.status,
    result,
  }, 'Push receipt');
}

interface CommittedOperation {
  readonly result: OperationResult;
  readonly cursor?: string;
}

interface PushReuseDenial {
  readonly key: string;
  readonly audit: SyncOperationReuseAudit;
}

type PushInspection =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly committed: CommittedOperation }
  | {
      readonly kind: 'reevaluate';
      readonly previousDeferredReceipt: StoredOperationReceipt<OperationResult>;
    }
  | { readonly kind: 'denied'; readonly denial: PushReuseDenial };

function claimForItem(item: PushTransactionOperation): SyncOperationClaim {
  return Object.freeze({
    operationId: item.operation.opId,
    digest: item.digest,
    replicaId: item.operation.replicaId,
    sequenceScope: item.sequenceScope,
    sequence: item.operation.sequence,
  });
}

function claimForReceipt<Result>(receipt: StoredOperationReceipt<Result>): SyncOperationClaim {
  return Object.freeze({
    operationId: receipt.operationId,
    digest: receipt.digest,
    replicaId: receipt.replicaId,
    sequenceScope: receipt.sequenceScope,
    sequence: receipt.sequence,
  });
}

async function verifiedReceiptClaim<
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
  Transaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>,
>(
  transaction: Transaction,
  receipt: StoredOperationReceipt<OperationResult>,
): Promise<SyncOperationClaim> {
  const expected = claimForReceipt(receipt);
  const claim = await loadSyncOperationClaim(transaction.operationClaims, receipt.operationId);
  if (claim === undefined || !syncOperationClaimsMatch(claim, expected)) {
    throw new TypeError('Push receipt and lifetime Operation claim are inconsistent.');
  }
  return claim;
}

async function denyPushReuse<
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
  Transaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>,
>(
  transaction: Transaction,
  code: 'sequence_reuse' | 'op_id_reused',
  attempted: SyncOperationClaim,
  stored: SyncOperationClaim,
): Promise<PushInspection> {
  const denial = await appendSyncOperationReuseAudit(transaction.reuseAudits, code, attempted, stored);
  return Object.freeze({ kind: 'denied', denial });
}

async function inspectPushOperation<
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
  Transaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>,
>(
  transaction: Transaction,
  item: PushTransactionOperation,
  reevaluateDeferred: boolean,
): Promise<PushInspection> {
  const attempted = claimForItem(item);
  const byOperationIdRaw = await requirePromise(
    transaction.receipts.findByOperationId(item.operation.opId),
    'Push replay receipt operation-id load',
  );
  const bySequenceRaw = await requirePromise(
    transaction.receipts.findBySequence(
      item.operation.replicaId,
      item.sequenceScope,
      item.operation.sequence,
    ),
    'Push replay receipt Sequence load',
  );
  if (byOperationIdRaw === undefined && bySequenceRaw === undefined) {
    return Object.freeze({ kind: 'new' });
  }

  const byOperationId = byOperationIdRaw === undefined
    ? undefined
    : immutableStoredReceipt(byOperationIdRaw, 'Push replay receipt operation-id load');
  const bySequence = bySequenceRaw === undefined
    ? undefined
    : immutableStoredReceipt(bySequenceRaw, 'Push replay receipt Sequence load');
  if (byOperationId !== undefined && byOperationId.operationId !== item.operation.opId) {
    throw new TypeError('Push operation-id receipt index returned another Operation ID.');
  }
  if (bySequence !== undefined && (
    bySequence.replicaId !== item.operation.replicaId
    || bySequence.sequenceScope !== item.sequenceScope
    || bySequence.sequence !== item.operation.sequence
  )) {
    throw new TypeError('Push Sequence receipt index returned another Sequence tuple.');
  }
  const operationClaim = byOperationId === undefined
    ? undefined
    : await verifiedReceiptClaim(transaction, byOperationId);
  const sequenceClaim = bySequence === undefined
    ? undefined
    : await verifiedReceiptClaim(transaction, bySequence);

  if (bySequence !== undefined) {
    if (bySequence.digest !== item.digest) {
      return denyPushReuse(transaction, 'sequence_reuse', attempted, sequenceClaim!);
    }
    if (bySequence.operationId !== item.operation.opId) {
      return denyPushReuse(transaction, 'sequence_reuse', attempted, sequenceClaim!);
    }
    if (byOperationId === undefined || !sameData(byOperationId, bySequence)) {
      throw new TypeError('Push receipt durable indexes are inconsistent.');
    }
    const result = immutableData(bySequence.result, 'Push replay OperationResult') as OperationResult;
    if (!sameData(bySequence, receiptFor(item, result))) {
      throw new TypeError('Push exact-replay receipt does not match the attempted identity.');
    }
    if (bySequence.status === 'deferred' && reevaluateDeferred) {
      return Object.freeze({ kind: 'reevaluate' as const, previousDeferredReceipt: bySequence });
    }
    // The result keeps its historical cursor for exact replay. Only cursors
    // allocated by this invocation may advance the authoritative response head.
    return Object.freeze({
      kind: 'replay',
      committed: Object.freeze({ result }),
    });
  }

  if (byOperationId !== undefined) {
    if (byOperationId.digest !== item.digest) {
      return denyPushReuse(transaction, 'op_id_reused', attempted, operationClaim!);
    }
    throw new TypeError('Push Operation receipt is missing its Sequence index.');
  }
  return Object.freeze({ kind: 'new' });
}

async function commitOperation<
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
  Transaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>,
>(
  transaction: Transaction,
  item: PushTransactionOperation,
  plan: PushPreparedOperation<Transaction, Conflict, Audit, Outbox>,
  previousDeferredReceipt?: StoredOperationReceipt<OperationResult>,
): Promise<CommittedOperation> {
  const cursor = plan.status === 'applied' || plan.status === 'rebased' || plan.status === 'conflicted'
    ? await requirePromise(transaction.allocateCursor(), 'Push Cursor allocation')
    : undefined;
  if (cursor !== undefined) assertNonEmpty(cursor, 'Allocated Push Cursor');

  const apply = plan.apply as (transaction: Transaction, cursor: string | undefined) => Promise<unknown>;
  const raw = await requirePromise(apply(transaction, cursor), 'Push business apply');
  let result: OperationResult;
  let conflict: Conflict | undefined;
  if (plan.status === 'conflicted') {
    if (cursor === undefined) throw new TypeError('Conflicted Push result requires a Cursor.');
    if (typeof raw !== 'object' || raw === null) throw new TypeError('Conflicted apply result must be an object.');
    assertExactObject(raw, ['result', 'conflict'], 'Conflicted apply result');
    const pair = raw as { readonly result: CursorlessResult<'conflicted'>; readonly conflict: Conflict };
    const cursorless = immutableData(pair.result, 'Push OperationResult') as OperationResult;
    if ('cursor' in cursorless) throw new TypeError('Push builder result has invalid members: cursor is coordinator-owned.');
    result = immutableData({ ...cursorless, cursor }, 'Push OperationResult') as OperationResult;
    conflict = immutableData(pair.conflict, 'Push Conflict');
    assertNonEmpty(conflict.id, 'Push Conflict id');
    if (result.conflictId !== conflict.id) {
      throw new TypeError('Conflicted result conflictId does not match the persisted Conflict.');
    }
  } else if (plan.status === 'applied' || plan.status === 'rebased') {
    if (cursor === undefined) throw new TypeError('Applied or rebased Push result requires a Cursor.');
    const cursorless = immutableData(raw, 'Push OperationResult') as OperationResult;
    if ('cursor' in cursorless) throw new TypeError('Push builder result has invalid members: cursor is coordinator-owned.');
    result = immutableData({ ...cursorless, cursor }, 'Push OperationResult') as OperationResult;
  } else {
    result = immutableData(raw, 'Push OperationResult') as OperationResult;
  }
  assertOperationResultShape(result, item.operation, plan.status);
  if ('cursor' in result && result.cursor !== cursor) {
    throw new TypeError('Push result Cursor does not match the allocated Cursor.');
  }

  const receipt = receiptFor(item, result);
  if (plan.status !== 'deferred') {
    await requirePromise(transaction.appendOperation(mutableData(item.operation)), 'Push Operation append');
  }
  if (conflict !== undefined) {
    await requirePromise(transaction.saveConflict(mutableData(conflict)), 'Push Conflict save');
  }
  // First evaluation inserts; a terminal re-evaluation replaces only the
  // matching deferred receipt. Replays never reach this write.
  const condition: PushReceiptWriteCondition = previousDeferredReceipt === undefined
    ? Object.freeze({ kind: 'absent' })
    : Object.freeze({
      kind: 'replace_deferred',
      operationId: previousDeferredReceipt.operationId,
      digest: previousDeferredReceipt.digest,
    });
  await requirePromise(
    transaction.receipts.save(mutableData(receipt), mutableData(condition)),
    'Push receipt save',
  );
  const byOperationIdRaw = await requirePromise(
    transaction.receipts.findByOperationId(item.operation.opId),
    'Push receipt operation-id read-back',
  );
  const bySequenceRaw = await requirePromise(
    transaction.receipts.findBySequence(
      item.operation.replicaId,
      item.sequenceScope,
      item.operation.sequence,
    ),
    'Push receipt Sequence read-back',
  );
  const byOperationId = byOperationIdRaw === undefined
    ? undefined
    : immutableData(byOperationIdRaw, 'Push receipt operation-id read-back');
  const bySequence = bySequenceRaw === undefined
    ? undefined
    : immutableData(bySequenceRaw, 'Push receipt Sequence read-back');
  if (!sameData(byOperationId, receipt) || !sameData(bySequence, receipt)) {
    throw new TypeError('Push receipt was not durably staged under both receipt indexes.');
  }

  if (plan.status !== 'deferred') {
    const context = immutableData({
      operation: item.operation,
      result,
      receipt,
      ...(cursor === undefined ? {} : { cursor }),
      ...(conflict === undefined ? {} : { conflict }),
    }, 'Push commit context') as PushCommitContext<Conflict>;
    const audit = immutableData(
      await requirePromise(plan.audit(context), 'Push audit builder'),
      'Push Audit',
    );
    await requirePromise(transaction.appendAudit(mutableData(audit)), 'Push Audit append');
    if (plan.status === 'applied' || plan.status === 'rebased' || plan.status === 'conflicted') {
      const outbox = immutableData(
        await requirePromise(plan.outbox(context), 'Push outbox builder'),
        'Push Outbox',
      );
      await requirePromise(transaction.appendOutbox(mutableData(outbox)), 'Push Outbox append');
    }
  }
  return cursor === undefined
    ? Object.freeze({ result })
    : Object.freeze({ result, cursor });
}

function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameData(entry, right[index]));
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key)) return false;
    if (!sameData(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

async function executeExactlyOnce<Value, Transaction>(
  execute: (
    work: (transaction: Transaction) => Promise<Value>,
    scope: PushExecutionScope,
  ) => Promise<Value>,
  scope: PushExecutionScope,
  work: (transaction: Transaction) => Promise<Value>,
): Promise<Value> {
  let invocations = 0;
  let callbackResult: Value | undefined;
  const outcome = await requirePromise(execute(async (transaction) => {
    invocations += 1;
    if (invocations !== 1) throw new TypeError('Sync UnitOfWork must invoke its callback exactly once.');
    if (typeof transaction !== 'object' || transaction === null) {
      throw new TypeError('Sync UnitOfWork must provide a transaction object.');
    }
    callbackResult = await work(transaction);
    return callbackResult;
  }, scope), 'Sync UnitOfWork execute');
  if (invocations !== 1 || callbackResult === undefined) {
    throw new TypeError('Sync UnitOfWork must invoke its callback exactly once.');
  }
  if (outcome !== callbackResult) {
    throw new TypeError('Sync UnitOfWork returned a forged transaction callback result.');
  }
  // Callback results and their nested data are frozen inside the transaction.
  // Do not introduce a new aggregate budget after durable commit.
  return outcome;
}

function localAtomicReuse(request: PushTransactionRequest): {
  readonly code: 'sequence_reuse' | 'op_id_reused';
  readonly attempted: SyncOperationClaim;
  readonly stored: SyncOperationClaim;
} | undefined {
  // Nested maps avoid JSON.stringify composite keys while preserving tuple identity.
  const firstByReplica = new Map<string, Map<string, Map<number, SyncOperationClaim>>>();
  for (const item of request.operations) {
    const claim = claimForItem(item);
    let byScope = firstByReplica.get(claim.replicaId);
    if (byScope === undefined) {
      byScope = new Map();
      firstByReplica.set(claim.replicaId, byScope);
    }
    let bySequence = byScope.get(claim.sequenceScope);
    if (bySequence === undefined) {
      bySequence = new Map<number, SyncOperationClaim>();
      byScope.set(claim.sequenceScope, bySequence);
    }
    const first = bySequence.get(claim.sequence);
    if (first === undefined) {
      bySequence.set(claim.sequence, claim);
    } else if (first.digest !== claim.digest) {
      return Object.freeze({ code: 'sequence_reuse', attempted: claim, stored: first });
    } else if (!syncOperationClaimsMatch(first, claim)) {
      return Object.freeze({ code: 'sequence_reuse', attempted: claim, stored: first });
    } else {
      throw new TypeError('Atomic Push cannot contain the same Operation more than once.');
    }
  }

  const firstByOperation = new Map<string, SyncOperationClaim>();
  for (const item of request.operations) {
    const claim = claimForItem(item);
    const first = firstByOperation.get(claim.operationId);
    if (first === undefined) {
      firstByOperation.set(claim.operationId, claim);
    } else if (first.digest !== claim.digest) {
      return Object.freeze({ code: 'op_id_reused', attempted: claim, stored: first });
    } else {
      throw new TypeError('Atomic Push repeats an Operation ID with inconsistent Sequence identity.');
    }
  }
  return undefined;
}

async function denialForExistingClaim<
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
  Transaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>,
>(
  transaction: Transaction,
  attempted: SyncOperationClaim,
  stored: SyncOperationClaim,
): Promise<PushReuseDenial> {
  if (stored.digest === attempted.digest) {
    throw new SyncOperationReceiptUnavailableError(
      'Lifetime Operation claim exists without a complete indexed Push receipt.',
      stored,
    );
  }
  return appendSyncOperationReuseAudit(transaction.reuseAudits, 'op_id_reused', attempted, stored);
}

function committedReuseError(denial: PushReuseDenial): SyncOperationReuseError {
  return new SyncOperationReuseError(denial.key, denial.audit);
}

/**
 * Coordinates Push persistence but deliberately supplies no in-memory atomicity or locking.
 * The adapter must provide cross-process serialization of the Sequence lanes named by each
 * `execute` scope, one real transaction for every child store and business resource touched by
 * a callback, and resolve execute only after commit is known (see {@link SyncUnitOfWork.execute}).
 *
 * **Composition:** this coordinator does not call
 * `verifySyncSessionContext`, does not bind `batchId` to a Session, and does
 * not enforce Sequence lane continuity (`sequence_gap` / `sequence_blocked`).
 * It is an alternative top-level opId reservation owner to
 * `coordinateSequenceOperation` and MUST NOT nest that coordinator in preflight
 * or transaction callbacks. Prefer `coordinateSessionBoundPush` when a Session
 * gate and session-bound `batchId` are required (or bind `batchId` at the HTTP
 * layer). Hosts that need lane continuity must use Sequence as the sole owner
 * for that path instead.
 */
export async function coordinatePushTransaction<
  Conflict extends PushConflictRecord,
  Audit,
  Outbox,
  Transaction extends SyncTransaction<Operation, OperationResult, Conflict, Audit, Outbox>,
>(
  unitOfWork: SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, Transaction>
    & PushOperationIdOwner,
  candidateRequest: PushTransactionRequest,
  preflight: PurePushPreflight<Transaction, Conflict, Audit, Outbox>,
): Promise<PushTransactionResult> {
  if (typeof preflight !== 'function') throw new TypeError('Push preflight must be a function.');
  const request = immutableRequest(candidateRequest);
  const results: OperationResult[] = [];
  let serverCursor = request.serverCursor;
  if (request.atomic) {
    // Every lane of the batch, in lock order, covers admission, commit and the
    // reuse-denial audit alike.
    const batchScope = pushExecutionScope(request.operations);
    const localReuse = localAtomicReuse(request);
    if (localReuse !== undefined) {
      const denial = await executeExactlyOnce<PushReuseDenial, Transaction>(
        (work, scope) => unitOfWork.execute(work, scope),
        batchScope,
        (transaction) => appendSyncOperationReuseAudit(
          transaction.reuseAudits,
          localReuse.code,
          localReuse.attempted,
          localReuse.stored,
        ),
      );
      throw committedReuseError(denial);
    }

    const outcome = await executeExactlyOnce<
      | { readonly kind: 'committed'; readonly operations: readonly CommittedOperation[] }
      | { readonly kind: 'denied'; readonly denial: PushReuseDenial },
      Transaction
    >(
      (work, scope) => unitOfWork.execute(work, scope),
      batchScope,
      async (transaction) => {
        const inspections: PushInspection[] = [];
        const pendingClaims: SyncOperationClaim[] = [];
        for (let index = 0; index < request.operations.length; index += 1) {
          const inspection = await inspectPushOperation(
            transaction,
            request.operations[index]!,
            request.reevaluateDeferred === true,
          );
          inspections.push(inspection);
          if (inspection.kind === 'denied') {
            return Object.freeze({ kind: 'denied' as const, denial: inspection.denial });
          }
          if (inspection.kind === 'replay') assertAtomicCommittable(inspection.committed.result.status);
          if (inspection.kind === 'new') pendingClaims.push(claimForItem(request.operations[index]!));
        }
        if (pendingClaims.length > 0) {
          const claimResult = await claimSyncOperations(transaction, pendingClaims);
          if (claimResult.kind === 'existing') {
            const denial = await denialForExistingClaim(
              transaction,
              claimResult.attempted,
              claimResult.claim,
            );
            return Object.freeze({ kind: 'denied' as const, denial });
          }
        }

        const atomicBatch = Object.freeze({});
        const plans: Array<PushPreparedOperation<Transaction, Conflict, Audit, Outbox> | undefined> = [];
        for (let index = 0; index < request.operations.length; index += 1) {
          const inspection = inspections[index]!;
          plans.push(inspection.kind === 'new' || inspection.kind === 'reevaluate'
            ? immutablePlan(await requirePromise(
              preflight(
                mutableData(request.operations[index]!),
                index,
                inspection.kind === 'reevaluate'
                  ? { atomicBatch, previousDeferredReceipt: inspection.previousDeferredReceipt }
                  : { atomicBatch },
              ),
              'Push preflight',
            ))
            : undefined);
        }
        for (const plan of plans) if (plan !== undefined) assertAtomicCommittable(plan.status);

        const batch: CommittedOperation[] = [];
        for (let index = 0; index < request.operations.length; index += 1) {
          const inspection = inspections[index]!;
          batch.push(inspection.kind === 'replay'
            ? inspection.committed
            : await commitOperation(
              transaction,
              request.operations[index]!,
              plans[index]!,
              inspection.kind === 'reevaluate' ? inspection.previousDeferredReceipt : undefined,
            ));
        }
        return Object.freeze({ kind: 'committed' as const, operations: Object.freeze(batch) });
      },
    );
    if (outcome.kind === 'denied') throw committedReuseError(outcome.denial);
    for (const item of outcome.operations) {
      results.push(item.result);
      if (item.cursor !== undefined) serverCursor = item.cursor;
    }
  } else {
    for (let index = 0; index < request.operations.length; index += 1) {
      const outcome = await executeExactlyOnce<
        | { readonly kind: 'committed'; readonly operation: CommittedOperation }
        | { readonly kind: 'denied'; readonly denial: PushReuseDenial },
        Transaction
      >(
        (work, scope) => unitOfWork.execute(work, scope),
        pushExecutionScope([request.operations[index]!]),
        async (transaction) => {
          const item = request.operations[index]!;
          const inspection = await inspectPushOperation(
            transaction,
            item,
            request.reevaluateDeferred === true,
          );
          if (inspection.kind === 'denied') {
            return Object.freeze({ kind: 'denied' as const, denial: inspection.denial });
          }
          if (inspection.kind === 'replay') {
            return Object.freeze({ kind: 'committed' as const, operation: inspection.committed });
          }
          if (inspection.kind === 'reevaluate') {
            const plan = immutablePlan(await requirePromise(
              preflight(
                mutableData(item),
                index,
                { previousDeferredReceipt: inspection.previousDeferredReceipt },
              ),
              'Push preflight',
            ));
            if (plan.status === 'deferred') {
              // Sequence parity: a re-evaluation that stays deferred replays the
              // stored receipt — apply is not re-run and no new receipt is written.
              return Object.freeze({
                kind: 'committed' as const,
                operation: Object.freeze({ result: inspection.previousDeferredReceipt.result }),
              });
            }
            const committed = await commitOperation(
              transaction, item, plan, inspection.previousDeferredReceipt,
            );
            return Object.freeze({ kind: 'committed' as const, operation: committed });
          }
          const attempted = claimForItem(item);
          const claimResult = await claimSyncOperation(transaction, attempted);
          if (claimResult.kind === 'existing') {
            const denial = await denialForExistingClaim(transaction, attempted, claimResult.claim);
            return Object.freeze({ kind: 'denied' as const, denial });
          }
          const plan = immutablePlan(await requirePromise(
            preflight(mutableData(item), index),
            'Push preflight',
          ));
          const committed = await commitOperation(transaction, item, plan);
          return Object.freeze({ kind: 'committed' as const, operation: committed });
        },
      );
      if (outcome.kind === 'denied') {
        const item = request.operations[index]!;
        throw new PushOperationReuseError(outcome.denial.key, outcome.denial.audit, {
          batchId: request.batchId,
          results: [...results],
          failed: {
            index,
            opId: item.operation.opId,
            replicaId: item.operation.replicaId,
            sequenceScope: item.sequenceScope,
            sequence: item.operation.sequence,
            digest: item.digest,
          },
          serverCursor,
        });
      }
      results.push(outcome.operation.result);
      if (outcome.operation.cursor !== undefined) serverCursor = outcome.operation.cursor;
    }
  }

  return Object.freeze({ batchId: request.batchId, results: Object.freeze(results), serverCursor });
}
