import type {
  OperationReceiptStatus,
  StoredOperationReceipt,
} from './index.js';
import {
  assertPlainDataObject,
  requirePromise,
} from './internal-guards.js';
import {
  appendSyncOperationReuseAudit,
  claimSyncOperation,
  loadSyncOperationClaim,
  SyncOperationReceiptUnavailableError,
  syncOperationClaimsMatch,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
  type SyncOperationReuseTransaction,
} from './operation-reuse.js';
import {
  claimForReceipt,
  claimForRequest,
  immutableEvaluation,
  immutableLane,
  immutableLaneState,
  immutableReceipt,
  immutableRequest,
  mutableData,
  receiptMatches,
} from './sequence-validation.js';

export interface SequenceLaneKey {
  readonly replicaId: string;
  readonly sequenceScope: string;
}

export interface SequenceLaneState {
  readonly nextSequence: number;
}

export type SequenceReceiptWriteCondition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'replace_deferred'; readonly digest: string };

export interface SequenceCoordinatorReceiptStore<Result> {
  load(
    lane: SequenceLaneKey,
    sequence: number,
  ): Promise<StoredOperationReceipt<Result> | undefined>;
  save(
    receipt: StoredOperationReceipt<Result>,
    condition: SequenceReceiptWriteCondition,
  ): Promise<void>;
}

export interface SequenceCoordinatorTransaction<Result> extends SyncOperationReuseTransaction {
  readonly receipts: SequenceCoordinatorReceiptStore<Result>;
  loadLaneState(lane: SequenceLaneKey): Promise<SequenceLaneState | undefined>;
  saveLaneState(lane: SequenceLaneKey, state: SequenceLaneState): Promise<void>;
}

export interface SequenceCoordinatorUnitOfWork<
  Result,
  Transaction extends SequenceCoordinatorTransaction<Result> = SequenceCoordinatorTransaction<Result>,
> {
  /**
   * Prevents one unit of work from also acting as a Push ownership boundary.
   *
   * Compile-time ownership brand only — not a runtime cross-coordinator
   * mutex. Host + durable claim-store discipline must ensure Sequence **or** Push (never
   * both) is the exclusive operation-ID reservation owner for a write path. Nesting the
   * other coordinator on the same boundary is a composition contract violation.
   */
  readonly operationIdReservationOwner: 'sequence';
  /**
   * The adapter MUST serialize callbacks for the same lane across all processes and
   * atomically commit every receipt, lane-state, and business write made by work.
   * It MUST resolve only after commit is known to have succeeded and reject after a
   * rollback or when the commit outcome is uncertain.
   *
   * It MUST invoke `work` exactly once per call; a second invocation throws. Do
   * not use a transaction helper that re-runs the callback on a transient error.
   * Reject instead and retry the whole coordinator call, which replays through
   * the persisted receipt.
   */
  execute<Value>(
    lane: SequenceLaneKey,
    work: (transaction: Transaction) => Promise<Value>,
  ): Promise<Value>;
}

/**
 * Logical Operation identity for Sequence: replica, sequence scope/number, opId,
 * and canonical digest. HTTP Session, Bearer, client/server batch, request date,
 * and tracing belong to the transport attempt and MUST NOT change this identity.
 */
export interface SequenceOperationRequest {
  readonly operationId: string;
  readonly replicaId: string;
  readonly sequenceScope: string;
  readonly sequence: number;
  readonly digest: string;
  /** Explicitly permits a persisted deferred receipt to be evaluated again. */
  readonly reevaluateDeferred?: boolean;
}

export interface SequenceEvaluation<Result> {
  readonly status: OperationReceiptStatus;
  readonly result: Result;
}

export interface SequenceEvaluationContext<Result> {
  readonly request: SequenceOperationRequest;
  readonly previousDeferredReceipt?: StoredOperationReceipt<Result>;
}

export type SequenceCoordinatorResult<Result> =
  | { readonly kind: 'executed'; readonly receipt: StoredOperationReceipt<Result> }
  | { readonly kind: 'replayed'; readonly receipt: StoredOperationReceipt<Result> }
  /** Reuse denial; `auditKey` / `audit` identify the audit persisted with it. */
  | {
      readonly kind: 'sequence_reuse' | 'op_id_reused';
      readonly auditKey: string;
      readonly audit: SyncOperationReuseAudit;
    }
  | { readonly kind: 'sequence_gap'; readonly expectedSequence: number }
  | { readonly kind: 'sequence_blocked'; readonly expectedSequence: number };

function resultMatches<Result>(
  left: SequenceCoordinatorResult<Result>,
  right: SequenceCoordinatorResult<Result>,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'executed' || left.kind === 'replayed') {
    return (right.kind === 'executed' || right.kind === 'replayed')
      && receiptMatches(left.receipt, right.receipt);
  }
  if (left.kind === 'sequence_gap' || left.kind === 'sequence_blocked') {
    return (right.kind === 'sequence_gap' || right.kind === 'sequence_blocked')
      && left.expectedSequence === right.expectedSequence;
  }
  return (right.kind === 'sequence_reuse' || right.kind === 'op_id_reused')
    && left.auditKey === right.auditKey
    && left.audit === right.audit;
}

function publicResult<Result>(result: SequenceCoordinatorResult<Result>): SequenceCoordinatorResult<Result> {
  if (typeof result !== 'object' || result === null) {
    throw new TypeError('Sequence UnitOfWork returned an invalid callback result.');
  }
  assertPlainDataObject(
    result,
    new Set(['kind', 'receipt', 'expectedSequence', 'auditKey', 'audit']),
    'Sequence UnitOfWork callback result',
  );
  if (
    result.kind !== 'executed'
    && result.kind !== 'replayed'
    && result.kind !== 'sequence_reuse'
    && result.kind !== 'op_id_reused'
    && result.kind !== 'sequence_gap'
    && result.kind !== 'sequence_blocked'
  ) {
    throw new TypeError('Sequence UnitOfWork returned an unknown callback result kind.');
  }
  assertPlainDataObject(
    result,
    result.kind === 'executed' || result.kind === 'replayed'
      ? new Set(['kind', 'receipt'])
      : result.kind === 'sequence_gap' || result.kind === 'sequence_blocked'
        ? new Set(['kind', 'expectedSequence'])
        : new Set(['kind', 'auditKey', 'audit']),
    'Sequence UnitOfWork callback result',
  );
  if (result.kind === 'executed' || result.kind === 'replayed') {
    const lane = immutableLane({
      replicaId: result.receipt.replicaId,
      sequenceScope: result.receipt.sequenceScope,
    });
    return Object.freeze({ kind: result.kind, receipt: immutableReceipt(result.receipt, lane) });
  }
  if (result.kind === 'sequence_gap' || result.kind === 'sequence_blocked') {
    return Object.freeze({ kind: result.kind, expectedSequence: result.expectedSequence });
  }
  // The audit was validated and frozen by appendSyncOperationReuseAudit.
  return Object.freeze({ kind: result.kind, auditKey: result.auditKey, audit: result.audit });
}

async function verifiedReceiptClaim<Result>(
  transaction: SequenceCoordinatorTransaction<Result>,
  receipt: StoredOperationReceipt<Result>,
): Promise<SyncOperationClaim> {
  const expected = claimForReceipt(receipt);
  const stored = await loadSyncOperationClaim(transaction.operationClaims, receipt.operationId);
  if (stored === undefined || !syncOperationClaimsMatch(stored, expected)) {
    throw new TypeError('Sequence receipt and lifetime Operation claim are inconsistent.');
  }
  return stored;
}

function consumedNextSequence(sequence: number): number {
  if (sequence === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('A terminal result cannot advance beyond the safe integer Sequence range.');
  }
  return sequence + 1;
}

async function persistAndVerify<Result>(
  transaction: SequenceCoordinatorTransaction<Result>,
  lane: SequenceLaneKey,
  receipt: StoredOperationReceipt<Result>,
  condition: SequenceReceiptWriteCondition,
  nextSequence: number,
): Promise<StoredOperationReceipt<Result>> {
  await requirePromise(
    transaction.receipts.save(
      mutableData(receipt),
      mutableData(condition),
    ),
    'Sequence receipt save',
  );
  await requirePromise(
    transaction.saveLaneState(mutableData(lane), { nextSequence }),
    'Sequence lane-state save',
  );
  const reloadedReceiptRaw = await requirePromise(
    transaction.receipts.load(mutableData(lane), receipt.sequence),
    'Sequence receipt transaction-local read-back',
  );
  if (reloadedReceiptRaw === undefined) {
    throw new TypeError('Sequence receipt was not persisted by the adapter.');
  }
  const reloadedReceipt = immutableReceipt(reloadedReceiptRaw, lane, receipt.sequence);
  if (!receiptMatches(receipt, reloadedReceipt)) {
    throw new TypeError('Sequence receipt was replaced or changed by the adapter.');
  }
  const reloadedStateRaw = await requirePromise(
    transaction.loadLaneState(mutableData(lane)),
    'Sequence lane-state transaction-local read-back',
  );
  if (reloadedStateRaw === undefined) {
    throw new TypeError('Sequence lane state was not persisted by the adapter.');
  }
  const reloadedState = immutableLaneState(reloadedStateRaw);
  if (reloadedState.nextSequence !== nextSequence) {
    throw new TypeError('Sequence lane state was not persisted by the adapter.');
  }
  return reloadedReceipt;
}

/**
 * Coordinates one operation in a durable, lane-serialized adapter transaction.
 * The evaluator runs only for the current expected Sequence, or for an explicitly
 * re-evaluated deferred receipt with the same digest.
 *
 * This is an alternative top-level owner to {@link coordinatePushTransaction} and
 * MUST NOT be invoked from that coordinator's preflight or transaction callbacks.
 * Hosts choose **exactly one** of Sequence or Push as the opId reservation owner
 * for a write path. Sequence alone enforces `sequence_gap` /
 * `sequence_blocked`; Push does not embed those decisions. There is intentionally
 * no dual-owner sequenced-push facade — see `composition.ts` host notes.
 *
 * Session authz is also not embedded: call `verifySyncSessionContext` (or
 * `coordinateSessionBoundSequence`) before this coordinator on HTTP surfaces.
 */
export async function coordinateSequenceOperation<
  Result,
  Transaction extends SequenceCoordinatorTransaction<Result> = SequenceCoordinatorTransaction<Result>,
>(
  unitOfWork: SequenceCoordinatorUnitOfWork<Result, Transaction>,
  candidateRequest: SequenceOperationRequest,
  evaluate: (
    context: SequenceEvaluationContext<Result>,
    transaction: Transaction,
  ) => Promise<SequenceEvaluation<Result>>,
): Promise<SequenceCoordinatorResult<Result>> {
  if (typeof evaluate !== 'function') throw new TypeError('Sequence evaluator must be a function.');
  const request = immutableRequest(candidateRequest);
  const lane = immutableLane({
    replicaId: request.replicaId,
    sequenceScope: request.sequenceScope,
  });
  let callbackInvocations = 0;
  let callbackResult: SequenceCoordinatorResult<Result> | undefined;

  const outcome = await requirePromise(unitOfWork.execute(mutableData(lane), async (transaction) => {
    callbackInvocations += 1;
    if (callbackInvocations !== 1) {
      throw new TypeError('Sequence UnitOfWork must invoke its callback exactly once.');
    }
    if (typeof transaction !== 'object' || transaction === null) {
      throw new TypeError('Sequence UnitOfWork must provide a transaction object.');
    }
    const state = immutableLaneState(await requirePromise(
      transaction.loadLaneState(mutableData(lane)),
      'Sequence lane-state load',
    ));
    const storedRaw = await requirePromise(
      transaction.receipts.load(mutableData(lane), request.sequence),
      'Sequence receipt load',
    );
    const stored = storedRaw === undefined
      ? undefined
      : immutableReceipt(storedRaw, lane, request.sequence);

    if (stored !== undefined) {
      const storedClaim = await verifiedReceiptClaim(transaction, stored);
      if (stored.sequence < state.nextSequence && stored.status === 'deferred') {
        throw new TypeError('Adapter returned a deferred receipt below the expected Sequence.');
      }
      if (stored.sequence >= state.nextSequence && stored.status !== 'deferred') {
        throw new TypeError('Adapter returned an unconsumed terminal Sequence receipt.');
      }
      if (stored.sequence > state.nextSequence) {
        throw new TypeError('Adapter returned a receipt beyond the expected Sequence.');
      }
      if (stored.digest !== request.digest) {
        const denial = await appendSyncOperationReuseAudit(
          transaction.reuseAudits,
          'sequence_reuse',
          claimForRequest(request),
          storedClaim,
        );
        callbackResult = Object.freeze({
          kind: 'sequence_reuse' as const, auditKey: denial.key, audit: denial.audit,
        });
        return callbackResult;
      }
      if (stored.operationId !== request.operationId) {
        const denial = await appendSyncOperationReuseAudit(
          transaction.reuseAudits,
          'sequence_reuse',
          claimForRequest(request),
          storedClaim,
        );
        callbackResult = Object.freeze({
          kind: 'sequence_reuse' as const, auditKey: denial.key, audit: denial.audit,
        });
        return callbackResult;
      }
      if (stored.status !== 'deferred' || request.reevaluateDeferred !== true) {
        callbackResult = Object.freeze({ kind: 'replayed' as const, receipt: stored });
        return callbackResult;
      }

      const context: SequenceEvaluationContext<Result> = Object.freeze({
        request,
        previousDeferredReceipt: stored,
      });
      const evaluation = immutableEvaluation(await requirePromise(
        evaluate(context, transaction),
        'Sequence evaluator',
      ));
      if (evaluation.status === 'deferred') {
        callbackResult = Object.freeze({ kind: 'replayed' as const, receipt: stored });
        return callbackResult;
      }
      const replacement = immutableReceipt({
        ...stored,
        status: evaluation.status,
        result: evaluation.result,
      }, lane, request.sequence);
      const persisted = await persistAndVerify(
        transaction,
        lane,
        replacement,
        { kind: 'replace_deferred', digest: request.digest },
        consumedNextSequence(request.sequence),
      );
      callbackResult = Object.freeze({ kind: 'executed' as const, receipt: persisted });
      return callbackResult;
    }

    const retainedClaim = await loadSyncOperationClaim(
      transaction.operationClaims,
      request.operationId,
    );
    if (retainedClaim !== undefined) {
      if (retainedClaim.digest !== request.digest) {
        const denial = await appendSyncOperationReuseAudit(
          transaction.reuseAudits,
          'op_id_reused',
          claimForRequest(request),
          retainedClaim,
        );
        callbackResult = Object.freeze({
          kind: 'op_id_reused' as const, auditKey: denial.key, audit: denial.audit,
        });
        return callbackResult;
      }
      throw new SyncOperationReceiptUnavailableError(
        'Lifetime Operation claim exists without its Sequence receipt.',
        retainedClaim,
      );
    }

    if (request.sequence < state.nextSequence) {
      throw new SyncOperationReceiptUnavailableError('Adapter is missing a consumed Sequence receipt.');
    }
    if (request.sequence > state.nextSequence) {
      const blockerRaw = await requirePromise(
        transaction.receipts.load(mutableData(lane), state.nextSequence),
        'Expected Sequence receipt load',
      );
      if (blockerRaw !== undefined) {
        const blocker = immutableReceipt(blockerRaw, lane, state.nextSequence);
        if (blocker.status !== 'deferred') {
          throw new TypeError('Adapter returned a terminal receipt at the expected Sequence.');
        }
        callbackResult = Object.freeze({
          kind: 'sequence_blocked' as const,
          expectedSequence: state.nextSequence,
        });
        return callbackResult;
      }
      callbackResult = Object.freeze({
        kind: 'sequence_gap' as const,
        expectedSequence: state.nextSequence,
      });
      return callbackResult;
    }

    const claimResult = await claimSyncOperation(transaction, claimForRequest(request));
    if (claimResult.kind === 'existing') {
      if (claimResult.claim.digest !== request.digest) {
        const denial = await appendSyncOperationReuseAudit(
          transaction.reuseAudits,
          'op_id_reused',
          claimForRequest(request),
          claimResult.claim,
        );
        callbackResult = Object.freeze({
          kind: 'op_id_reused' as const, auditKey: denial.key, audit: denial.audit,
        });
        return callbackResult;
      }
      throw new SyncOperationReceiptUnavailableError(
        'Lifetime Operation claim exists without its Sequence receipt.',
        claimResult.claim,
      );
    }
    const context: SequenceEvaluationContext<Result> = Object.freeze({ request });
    const evaluation = immutableEvaluation(await requirePromise(
      evaluate(context, transaction),
      'Sequence evaluator',
    ));
    const receipt = immutableReceipt({
      operationId: request.operationId,
      replicaId: lane.replicaId,
      sequenceScope: lane.sequenceScope,
      sequence: request.sequence,
      digest: request.digest,
      status: evaluation.status,
      result: evaluation.result,
    }, lane, request.sequence);
    const persisted = await persistAndVerify(
      transaction,
      lane,
      receipt,
      { kind: 'absent' },
      evaluation.status === 'deferred' ? request.sequence : consumedNextSequence(request.sequence),
    );
    callbackResult = Object.freeze({ kind: 'executed' as const, receipt: persisted });
    return callbackResult;
  }), 'Sequence UnitOfWork execute');

  if (callbackInvocations !== 1 || callbackResult === undefined) {
    throw new TypeError('Sequence UnitOfWork must invoke its callback exactly once.');
  }
  const normalizedOutcome = publicResult(outcome);
  if (!resultMatches(normalizedOutcome, callbackResult)) {
    throw new TypeError('Sequence UnitOfWork returned a result other than its transaction callback result.');
  }
  return publicResult(normalizedOutcome);
}
