/**
 * Push durable-adapter contract: receipt/replica stores, the transaction
 * surface, and the unit of work with its typed execution scope.
 *
 * Re-exported from `./index.js`; import from there.
 */

import type { SequenceReceipt } from './index.js';
import type { SyncOperationReuseTransaction } from './operation-reuse.js';

/**
 * Precondition for a Push receipt write, mirroring Sequence's
 * `SequenceReceiptWriteCondition`.
 *
 * - `absent`: insert only; no receipt exists under this operation ID or this
 *   `(replicaId, sequenceScope, sequence)` tuple.
 * - `replace_deferred`: a `deferred` receipt for exactly this `operationId`,
 *   Sequence tuple and `digest` exists and is replaced by the terminal
 *   receipt. Terminal receipts are never overwritten.
 */
export type PushReceiptWriteCondition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'replace_deferred'; readonly operationId: string; readonly digest: string };

/**
 * Thrown by an adapter's `receipts.save` when its write condition does not
 * hold (typically a lost concurrent race). It is a retryable concurrency
 * outcome, not a protocol denial: the coordinator lets it propagate, the
 * transaction rolls back, and a retry observes the committed receipt and
 * replays or is denied. Report storage failures with their own errors; never
 * translate them into this class or into `SyncOperationReuseError`.
 */
export class PushReceiptConditionFailedError extends Error {
  readonly retryable = true as const;
  readonly condition: PushReceiptWriteCondition;

  constructor(condition: PushReceiptWriteCondition) {
    super(`Push receipt write condition ${condition.kind} did not hold.`);
    this.name = 'PushReceiptConditionFailedError';
    this.condition = Object.freeze({ ...condition });
  }
}

export interface OperationReceiptStore<Result> {
  findByOperationId(operationId: string): Promise<StoredOperationReceipt<Result> | undefined>;
  findBySequence(
    replicaId: string,
    sequenceScope: string,
    sequence: number,
  ): Promise<StoredOperationReceipt<Result> | undefined>;
  /**
   * Persist `receipt` only when `condition` holds, atomically with the check
   * (a conditional INSERT/UPDATE, not read-then-write). Throw
   * {@link PushReceiptConditionFailedError} when it does not. An insert-only
   * adapter that ignores `condition` cannot serve deferred re-evaluation.
   */
  save(receipt: StoredOperationReceipt<Result>, condition: PushReceiptWriteCondition): Promise<void>;
}

export interface StoredOperationReceipt<Result> extends SequenceReceipt<Result> {
  readonly operationId: string;
  readonly replicaId: string;
  readonly sequenceScope: string;
}

/**
 * Transaction surface the Push coordinator actually uses. Replica, purge
 * boundary and deletion-watermark ports belong to the lifecycle and
 * Tombstone purge transactions, not here.
 */
export interface SyncTransaction<Operation, Result, Conflict, Audit, Outbox>
  extends SyncOperationReuseTransaction {
  readonly receipts: OperationReceiptStore<Result>;
  appendOperation(operation: Operation): Promise<void>;
  saveConflict(conflict: Conflict): Promise<void>;
  allocateCursor(): Promise<string>;
  appendAudit(event: Audit): Promise<void>;
  appendOutbox(message: Outbox): Promise<void>;
}

/** One Replica Sequence lane: the unit whose receipts must be serialized. */
export interface PushSequenceLane {
  readonly replicaId: string;
  readonly sequenceScope: string;
}

/**
 * What one Push transaction may touch, derived from the validated request.
 *
 * - `collectionIds`: distinct Collections of the covered operations, sorted.
 *   Empty only when every covered operation is `create_collection`, which has
 *   no Collection yet (session-bound Push always yields exactly one).
 * - `lanes`: distinct Sequence lanes, sorted by `replicaId` then
 *   `sequenceScope` (UTF-16 code-unit order). Acquire lane locks in exactly
 *   this order to avoid deadlocks between overlapping atomic batches.
 *
 * An atomic batch (including its reuse-denial audit transaction) covers every
 * lane in the batch; each non-atomic operation covers only its own lane.
 */
export interface PushExecutionScope {
  readonly collectionIds: readonly string[];
  readonly lanes: readonly [PushSequenceLane, ...PushSequenceLane[]];
}

/** Adapters must commit every mutation made through one callback, or roll all of them back. */
export interface SyncUnitOfWork<
  Operation,
  Result,
  Conflict,
  Audit,
  Outbox,
  Transaction extends SyncTransaction<Operation, Result, Conflict, Audit, Outbox> = SyncTransaction<
    Operation,
    Result,
    Conflict,
    Audit,
    Outbox
  >,
> {
  /**
   * Push is the sole operation-ID reservation owner for this unit-of-work boundary.
   *
   * Type-level ownership brand only. Runtime exclusivity is host +
   * durable claim-store discipline — there is no cross-coordinator mutex between
   * Push and Sequence. Do not nest the other owner on the same request boundary.
   */
  readonly operationIdReservationOwner: 'push';
  /**
   * Run `work` in one transaction. Resolve only after commit is known to have
   * succeeded. Reject if the commit outcome is uncertain; callers retry
   * through persisted Sequence/Operation receipts.
   *
   * Invoke `work` exactly once per `execute` call; a second invocation throws.
   * Do not wrap it in a helper that re-runs the callback on a transient error
   * (a retrying `withTransaction`, a serialization-failure loop). Let the error
   * reject `execute` and retry the whole coordinator call instead: persisted
   * receipts make that retry replay what already committed.
   *
   * `scope` names the Sequence lanes this transaction reads and writes. The
   * adapter must:
   * - serialize transactions per lane across processes (for example
   *   `SELECT … FOR UPDATE` on lane rows or advisory locks taken in `scope`
   *   order); transactions on disjoint lanes need not wait for each other;
   * - keep `(replicaId, sequenceScope, sequence)` receipts unique;
   * - keep operation IDs globally unique across lanes (a unique index on the
   *   lifetime claim), since lane locks alone do not cover cross-lane opId reuse;
   * - persist receipt, business, audit and outbox writes atomically;
   * - on a uniqueness race or an uncertain commit, reject rather than resolve,
   *   so the retry observes the durable receipt and replays.
   *
   * The parameter is additive: an adapter that ignores it and serializes all
   * Push transactions globally, or that binds one request per transaction,
   * still satisfies the contract.
   */
  execute<T>(
    work: (transaction: Transaction) => Promise<T>,
    scope: PushExecutionScope,
  ): Promise<T>;
}

interface ScopedItem {
  readonly operation: { readonly collectionId?: string; readonly replicaId: string };
  readonly sequenceScope: string;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic scope for the given validated Push items (at least one). */
export function pushExecutionScope(items: readonly ScopedItem[]): PushExecutionScope {
  if (items.length === 0) throw new TypeError('Push execution scope requires at least one operation.');
  const collectionIds = [...new Set(items.flatMap(item =>
    item.operation.collectionId === undefined ? [] : [item.operation.collectionId]))].sort(compareCodeUnits);
  const lanes = new Map<string, PushSequenceLane>();
  for (const item of items) {
    // JSON tuple keys cannot collide for distinct (replicaId, sequenceScope) pairs.
    const key = JSON.stringify([item.operation.replicaId, item.sequenceScope]);
    if (!lanes.has(key)) {
      lanes.set(key, Object.freeze({ replicaId: item.operation.replicaId, sequenceScope: item.sequenceScope }));
    }
  }
  const ordered = [...lanes.values()].sort((left, right) =>
    compareCodeUnits(left.replicaId, right.replicaId)
    || compareCodeUnits(left.sequenceScope, right.sequenceScope));
  return Object.freeze({
    collectionIds: Object.freeze(collectionIds),
    lanes: Object.freeze(ordered) as unknown as PushExecutionScope['lanes'],
  });
}
