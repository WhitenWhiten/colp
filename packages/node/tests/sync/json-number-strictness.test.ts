import { describe, expect, it, vi } from 'vitest';

import {
  type PushPreparedOperation,
  type PushTransactionRequest,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceEvaluation,
  type SequenceLaneKey,
  type SequenceLaneState,
  type SequenceOperationRequest,
  type SequenceReceiptWriteCondition,
  type StoredOperationReceipt,
  type SyncTransaction,
  type SyncUnitOfWork,
  type TerminalOperationStatus,
} from '../../src/sync/index.js';
import {
  coordinatePushTransaction,
  coordinateSequenceOperation,
} from '../../src/sync/unsafe.js';
import type { Operation, OperationResult } from '../../src/types/index.js';

/**
 * SYNC-V-012 — unified JSON number cloning strictness across Push and Sequence.
 *
 * Shared policy (I-JSON style):
 * - reject non-finite numbers (NaN, ±Infinity)
 * - reject unsafe integers (Number.MAX_SAFE_INTEGER + 1, …)
 * - preserve finite safe decimals (e.g. 1.5) used by typed-update payloads
 *
 * Tests hit both durable coordinators so a shared helper fix is not tied to one path.
 */

const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
const unsafeCases = [
  { label: 'unsafe integer', value: unsafeInteger },
  { label: 'NaN', value: Number.NaN },
  { label: '+Infinity', value: Number.POSITIVE_INFINITY },
  { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
] as const;

// ---------------------------------------------------------------------------
// Minimal Push harness
// ---------------------------------------------------------------------------

interface Conflict { readonly id: string }
interface Audit { readonly id: string }
interface Outbox { readonly id: string }

interface PushState {
  readonly operations: Operation[];
  readonly receipts: StoredOperationReceipt<OperationResult>[];
  readonly cursors: string[];
  readonly audits: Audit[];
  readonly outbox: Outbox[];
  readonly operationClaims: Map<string, unknown>;
  readonly reuseAudits: Map<string, unknown>;
}

interface TestPushTransaction extends SyncTransaction<
  Operation,
  OperationResult,
  Conflict,
  Audit,
  Outbox
> {}

function emptyPushState(): PushState {
  return {
    operations: [],
    receipts: [],
    cursors: [],
    audits: [],
    outbox: [],
    operationClaims: new Map(),
    reuseAudits: new Map(),
  };
}

class PushBackend {
  state = emptyPushState();
}

class PushHandle implements SyncUnitOfWork<
  Operation,
  OperationResult,
  Conflict,
  Audit,
  Outbox,
  TestPushTransaction
> {
  readonly operationIdReservationOwner = 'push' as const;
  executeCount = 0;

  constructor(readonly backend = new PushBackend()) {}

  async execute<Value>(work: (transaction: TestPushTransaction) => Promise<Value>): Promise<Value> {
    this.executeCount += 1;
    const draft = structuredClone(this.backend.state) as PushState;
    const result = await work(this.transaction(draft));
    this.backend.state = draft;
    return result;
  }

  private transaction(draft: PushState): TestPushTransaction {
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      operationClaims: {
        load: async (id) => structuredClone(draft.operationClaims.get(id)) as never,
        save: async (claim) => {
          draft.operationClaims.set(claim.operationId, structuredClone(claim));
        },
      },
      reuseAudits: {
        append: async (audit) => {
          const key = `reuse-${draft.reuseAudits.size + 1}`;
          draft.reuseAudits.set(key, structuredClone(audit));
          return key;
        },
        load: async (key) => structuredClone(draft.reuseAudits.get(key)) as never,
      },
      receipts: {
        findByOperationId: async (operationId) => structuredClone(
          draft.receipts.find((receipt) => receipt.operationId === operationId),
        ),
        findBySequence: async (replicaId, sequenceScope, sequence) => structuredClone(
          draft.receipts.find((receipt) => (
            receipt.replicaId === replicaId
            && receipt.sequenceScope === sequenceScope
            && receipt.sequence === sequence
          )),
        ),
        save: async (receipt) => {
          draft.receipts.push(structuredClone(receipt));
        },
      },
      appendOperation: async (operation) => {
        draft.operations.push(structuredClone(operation));
      },
      saveConflict: async () => undefined,
      allocateCursor: async () => {
        const cursor = `cursor-${draft.cursors.length + 1}`;
        draft.cursors.push(cursor);
        return cursor;
      },
      appendAudit: async (audit) => {
        draft.audits.push(structuredClone(audit));
      },
      appendOutbox: async (message) => {
        draft.outbox.push(structuredClone(message));
      },
    };
  }
}

function pushOperation(nestedNumber: number): Operation {
  // Typed-update payload: nest the number under value so schema accepts the Operation.
  return {
    opId: 'operation-1',
    replicaId: 'replica-1',
    sequence: 1,
    type: 'update_annotation',
    occurredAt: '2026-07-18T00:00:00Z',
    collectionId: 'collection-1',
    targetId: 'annotation-1',
    baseRevision: 'revision-1',
    payload: {
      base: { value: nestedNumber },
      value: { value: nestedNumber },
    },
  } as Operation;
}

function pushRequest(nestedNumber: number): PushTransactionRequest {
  return {
    batchId: 'batch-1',
    atomic: true,
    serverCursor: 'cursor-0',
    operations: [{
      operation: pushOperation(nestedNumber),
      sequenceScope: 'collection-1',
      digest: 'digest-1',
    }] as unknown as PushTransactionRequest['operations'],
  };
}

function appliedPlan(): PushPreparedOperation<TestPushTransaction, Conflict, Audit, Outbox> {
  return {
    status: 'applied',
    apply: async () => ({
      opId: 'operation-1',
      sequence: 1,
      status: 'applied' as const,
      warnings: [],
      revision: 'revision-applied-1',
    }),
    audit: async () => ({ id: 'audit-1' }),
    outbox: async () => ({ id: 'outbox-1' }),
  };
}

// ---------------------------------------------------------------------------
// Minimal Sequence harness
// ---------------------------------------------------------------------------

type SequenceResult = {
  readonly status: TerminalOperationStatus | 'deferred';
  readonly revision?: string;
  readonly cursor?: string;
  readonly warnings?: readonly string[];
  readonly code?: string;
  readonly score?: number;
  readonly metric?: number;
  readonly [key: string]: unknown;
};

interface SequenceState {
  readonly lanes: Map<string, SequenceLaneState>;
  readonly receipts: Map<string, StoredOperationReceipt<SequenceResult>>;
  readonly operationClaims: Map<string, unknown>;
  readonly reuseAudits: Map<string, unknown>;
}

function laneIdentity(lane: SequenceLaneKey): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope]);
}

function receiptIdentity(lane: SequenceLaneKey, sequence: number): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope, sequence]);
}

function cloneSequenceState(state: SequenceState): SequenceState {
  return {
    lanes: new Map([...state.lanes].map(([key, value]) => [key, structuredClone(value)])),
    receipts: new Map([...state.receipts].map(([key, value]) => [key, structuredClone(value)])),
    operationClaims: new Map(
      [...state.operationClaims].map(([key, value]) => [key, structuredClone(value)]),
    ),
    reuseAudits: new Map(
      [...state.reuseAudits].map(([key, value]) => [key, structuredClone(value)]),
    ),
  };
}

class SequenceBackend {
  state: SequenceState = {
    lanes: new Map(),
    receipts: new Map(),
    operationClaims: new Map(),
    reuseAudits: new Map(),
  };
}

class SequenceHandle implements SequenceCoordinatorUnitOfWork<SequenceResult> {
  readonly operationIdReservationOwner = 'sequence' as const;

  constructor(readonly backend = new SequenceBackend()) {}

  execute<Value>(
    lane: SequenceLaneKey,
    work: (transaction: SequenceCoordinatorTransaction<SequenceResult>) => Promise<Value>,
  ): Promise<Value> {
    return (async () => {
      const draft = cloneSequenceState(this.backend.state);
      const result = await work(this.transaction(draft));
      this.backend.state = draft;
      return result;
    })();
  }

  private transaction(
    draft: SequenceState,
  ): SequenceCoordinatorTransaction<SequenceResult> {
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      operationClaims: {
        load: async (id) => structuredClone(draft.operationClaims.get(id)) as never,
        save: async (claim) => {
          draft.operationClaims.set(claim.operationId, structuredClone(claim));
        },
      },
      reuseAudits: {
        append: async (audit) => {
          const key = `reuse-${draft.reuseAudits.size + 1}`;
          draft.reuseAudits.set(key, structuredClone(audit));
          return key;
        },
        load: async (key) => structuredClone(draft.reuseAudits.get(key)) as never,
      },
      loadLaneState: async (lane) => {
        const state = draft.lanes.get(laneIdentity(lane));
        return state === undefined ? undefined : structuredClone(state);
      },
      saveLaneState: async (lane, state) => {
        draft.lanes.set(laneIdentity(lane), structuredClone(state));
      },
      receipts: {
        load: async (lane, sequence) => {
          const receipt = draft.receipts.get(receiptIdentity(lane, sequence));
          return receipt === undefined ? undefined : structuredClone(receipt);
        },
        save: async (receipt, _condition: SequenceReceiptWriteCondition) => {
          draft.receipts.set(
            receiptIdentity(receipt, receipt.sequence),
            structuredClone(receipt),
          );
        },
      },
    };
  }
}

function sequenceRequest(
  overrides: Partial<SequenceOperationRequest> = {},
): SequenceOperationRequest {
  return {
    operationId: 'operation-1',
    replicaId: 'replica-1',
    sequenceScope: 'collection-1',
    sequence: 1,
    digest: 'sha-256:operation-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('SYNC-V-012 shared JSON number strictness (Push + Sequence)', () => {
  describe('Push coordinator cloned payloads', () => {
    it.each(unsafeCases)(
      'rejects $label nested in the operation payload before preflight',
      async ({ value }) => {
        const handle = new PushHandle();
        const preflight = vi.fn(async () => appliedPlan());

        await expect(
          coordinatePushTransaction(
            handle,
            pushRequest(value),
            preflight,
          ),
        ).rejects.toThrow(/unsafe|non-finite|safe integer|JSON-safe|number/i);
        expect(preflight).not.toHaveBeenCalled();
        expect(handle.executeCount).toBe(0);
      },
    );

    it('preserves a finite safe decimal through Push clone and commit', async () => {
      const handle = new PushHandle();
      const result = await coordinatePushTransaction(
        handle,
        pushRequest(1.5),
        async () => appliedPlan(),
      );

      expect(handle.backend.state.operations[0]?.payload).toEqual({
        base: { value: 1.5 },
        value: { value: 1.5 },
      });
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.status).toBe('applied');
    });
  });

  describe('Sequence coordinator cloned evaluation results', () => {
    it.each(unsafeCases)(
      'rejects $label nested in the evaluation result',
      async ({ value }) => {
        const handle = new SequenceHandle();
        const evaluation: SequenceEvaluation<SequenceResult> = {
          status: 'applied',
          result: {
            status: 'applied',
            revision: 'revision-2',
            cursor: 'cursor-11',
            warnings: [],
            metric: value,
          },
        };
        const evaluator = vi.fn(async (): Promise<SequenceEvaluation<SequenceResult>> => evaluation);

        await expect(
          coordinateSequenceOperation(handle, sequenceRequest(), evaluator),
        ).rejects.toThrow(/unsafe|non-finite|safe integer|number/i);
        // Evaluator may run before result cloning; durable lane must not advance.
        expect(handle.backend.state.lanes.size).toBe(0);
        expect(handle.backend.state.receipts.size).toBe(0);
      },
    );

    it('preserves a finite safe decimal in a Sequence evaluation result', async () => {
      const handle = new SequenceHandle();
      const evaluation: SequenceEvaluation<SequenceResult> = {
        status: 'applied',
        result: {
          status: 'applied',
          revision: 'revision-2',
          cursor: 'cursor-11',
          warnings: [],
          score: 1.5,
        },
      };

      const outcome = await coordinateSequenceOperation(
        handle,
        sequenceRequest(),
        async () => evaluation,
      );

      expect(outcome).toMatchObject({
        kind: 'executed',
        receipt: { result: { score: 1.5, status: 'applied' } },
      });
    });
  });

  it('applies the same rejection surface on both coordinators for unsafe integers', async () => {
    const pushHandle = new PushHandle();
    const sequenceHandle = new SequenceHandle();
    const pushPreflight = vi.fn(async () => appliedPlan());
    const sequenceEvaluator = vi.fn(async (): Promise<SequenceEvaluation<SequenceResult>> => ({
      status: 'applied',
      result: {
        status: 'applied',
        revision: 'revision-2',
        cursor: 'cursor-11',
        warnings: [],
        metric: unsafeInteger,
      },
    }));

    const pushRejection = coordinatePushTransaction(
      pushHandle,
      pushRequest(unsafeInteger),
      pushPreflight,
    );
    const sequenceRejection = coordinateSequenceOperation(
      sequenceHandle,
      sequenceRequest(),
      sequenceEvaluator,
    );

    await expect(pushRejection).rejects.toThrow(/unsafe|safe integer|number/i);
    await expect(sequenceRejection).rejects.toThrow(/unsafe|safe integer|number/i);
    expect(pushPreflight).not.toHaveBeenCalled();
  });
});
