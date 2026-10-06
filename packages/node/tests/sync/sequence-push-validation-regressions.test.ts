/**
 * U-4 Sync mutation survivors — priority 2 (sequence / push).
 * Distinguishing public observations for bounds, idempotency, and
 * validation error shape (no secret reflection).
 */

import { describe, expect, it } from 'vitest';

import type {
  PushTransactionRequest,
  SequenceCoordinatorTransaction,
  SequenceCoordinatorUnitOfWork,
  SequenceLaneKey,
  SequenceLaneState,
  SequenceOperationRequest,
  SequenceReceiptWriteCondition,
  StoredOperationReceipt,
  SyncOperationClaim,
  SyncOperationReuseAudit,
  SyncTransaction,
  SyncUnitOfWork,
  TerminalOperationStatus,
} from '../../src/sync/index.js';
import {
  coordinatePushTransaction,
  coordinateSequenceOperation,
} from '../../src/sync/unsafe.js';
import type { Operation, OperationResult } from '../../src/types/index.js';

const evidence = '[review:sync.mutation-survivors-u4-p2]';

type OpResult = Readonly<Record<string, unknown>> & {
  readonly status: TerminalOperationStatus | 'deferred';
};

interface SeqState {
  readonly lanes: Map<string, SequenceLaneState>;
  readonly receipts: Map<string, StoredOperationReceipt<OpResult>>;
  readonly operationClaims: Map<string, SyncOperationClaim>;
  readonly reuseAudits: Map<string, SyncOperationReuseAudit>;
}

function laneIdentity(lane: SequenceLaneKey): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope]);
}

function receiptIdentity(lane: SequenceLaneKey, sequence: number): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope, sequence]);
}

function cloneState(state: SeqState): SeqState {
  return {
    lanes: new Map([...state.lanes].map(([key, value]) => [key, structuredClone(value)])),
    receipts: new Map([...state.receipts].map(([key, value]) => [key, structuredClone(value)])),
    operationClaims: new Map(
      [...state.operationClaims].map(([key, value]) => [key, structuredClone(value)]),
    ),
    reuseAudits: new Map([...state.reuseAudits].map(([key, value]) => [key, structuredClone(value)])),
  };
}

class SeqBackend {
  state: SeqState = {
    lanes: new Map(),
    receipts: new Map(),
    operationClaims: new Map(),
    reuseAudits: new Map(),
  };
  readonly laneTails = new Map<string, Promise<void>>();
}

class SeqHandle implements SequenceCoordinatorUnitOfWork<OpResult> {
  readonly operationIdReservationOwner = 'sequence' as const;

  constructor(readonly backend = new SeqBackend()) {}

  execute<Value>(
    lane: SequenceLaneKey,
    work: (transaction: SequenceCoordinatorTransaction<OpResult>) => Promise<Value>,
  ): Promise<Value> {
    const identity = laneIdentity(lane);
    const previous = this.backend.laneTails.get(identity) ?? Promise.resolve();
    const run = async (): Promise<Value> => {
      const draft = cloneState(this.backend.state);
      const result = await work({
        idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
        operationClaims: {
          load: async (id: string) => structuredClone(draft.operationClaims.get(id)),
          save: async (claim: SyncOperationClaim) => {
            draft.operationClaims.set(claim.operationId, structuredClone(claim));
          },
        },
        reuseAudits: {
          append: async (audit: SyncOperationReuseAudit) => {
            const key = `reuse-${draft.reuseAudits.size + 1}`;
            draft.reuseAudits.set(key, structuredClone(audit));
            return key;
          },
          load: async (key: string) => structuredClone(draft.reuseAudits.get(key)),
        },
        loadLaneState: async (target) => {
          const state = draft.lanes.get(laneIdentity(target));
          return state === undefined ? undefined : structuredClone(state);
        },
        saveLaneState: async (target, state) => {
          draft.lanes.set(laneIdentity(target), structuredClone(state));
        },
        receipts: {
          load: async (target, sequence) => {
            const receipt = draft.receipts.get(receiptIdentity(target, sequence));
            return receipt === undefined ? undefined : structuredClone(receipt);
          },
          save: async (receipt, _condition: SequenceReceiptWriteCondition) => {
            draft.receipts.set(receiptIdentity(receipt, receipt.sequence), structuredClone(receipt));
          },
        },
      });
      this.backend.state = draft;
      return result;
    };
    const outcome = previous.then(run, run);
    this.backend.laneTails.set(
      identity,
      outcome.then(
        () => undefined,
        () => undefined,
      ),
    );
    return outcome;
  }
}

function seqRequest(overrides: Partial<SequenceOperationRequest> = {}): SequenceOperationRequest {
  return {
    operationId: 'operation-u4-1',
    replicaId: 'replica-1',
    sequenceScope: 'collection-1',
    sequence: 1,
    digest: 'sha-256:operation-u4-1',
    ...overrides,
  };
}

describe(`U-4 P2 sequence replay / bounds ${evidence}`, () => {
  it(`mutants ~3370/3453: sequence 0 rejected on request; forged receipt sequence 0 rejected on load ${evidence}`, async () => {
    const handle = new SeqHandle();
    const appliedEval = {
      status: 'applied' as const,
      result: { status: 'applied' as const, revision: 'revision-1', cursor: 'cursor-1', warnings: [] },
    };
    await expect(
      coordinateSequenceOperation<OpResult>(handle, seqRequest({ sequence: 0 }), async () => appliedEval),
    ).rejects.toThrow(/positive safe integer/i);
    expect(handle.backend.state.lanes.size).toBe(0);
    expect(handle.backend.state.receipts.size).toBe(0);

    const handleReceipt = new SeqHandle();
    handleReceipt.backend.state.lanes.set(laneIdentity(seqRequest()), { nextSequence: 1 });
    handleReceipt.backend.state.receipts.set(receiptIdentity(seqRequest(), 1), {
      operationId: 'operation-u4-1',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 0,
      digest: 'sha-256:operation-u4-1',
      status: 'applied',
      result: { status: 'applied', revision: 'revision-1', cursor: 'cursor-1', warnings: [] },
    });
    await expect(
      coordinateSequenceOperation<OpResult>(handleReceipt, seqRequest({ sequence: 1 }), async () => appliedEval),
    ).rejects.toThrow(/positive safe integer/i);

    const applied = await coordinateSequenceOperation<OpResult>(
      handle,
      seqRequest({ sequence: 1 }),
      async () => appliedEval,
    );
    expect(applied).toMatchObject({
      kind: 'executed',
      receipt: { sequence: 1, status: 'applied' },
    });
    expect(handle.backend.state.lanes.get(laneIdentity(seqRequest()))).toEqual({ nextSequence: 2 });
  });

  it(`mutants ~3310/idempotent replay: same digest returns prior receipt; divergent array result rejects ${evidence}`, async () => {
    const handle = new SeqHandle();
    let executions = 0;
    const run = () =>
      coordinateSequenceOperation<OpResult>(handle, seqRequest(), async () => {
        executions += 1;
        return {
          status: 'applied' as const,
          result: {
            status: 'applied' as const,
            revision: 'revision-1',
            cursor: 'cursor-1',
            warnings: ['a'],
          },
        };
      });
    const first = await run();
    const second = await run();
    expect(executions).toBe(1);
    expect(second).toMatchObject({ kind: 'replayed' });
    expect(
      second.kind === 'replayed' && first.kind === 'executed' ? second.receipt : undefined,
    ).toEqual(first.kind === 'executed' ? first.receipt : undefined);

    // Seed a conflicting prior result array to exercise equalData array && vs ||.
    const handle2 = new SeqHandle();
    handle2.backend.state.lanes.set(laneIdentity(seqRequest()), { nextSequence: 2 });
    handle2.backend.state.receipts.set(receiptIdentity(seqRequest(), 1), {
      operationId: 'operation-u4-1',
      replicaId: 'replica-1',
      sequenceScope: 'collection-1',
      sequence: 1,
      digest: 'sha-256:operation-u4-1',
      status: 'applied',
      result: { status: 'applied', revision: 'revision-1', cursor: 'cursor-1', warnings: ['a'] },
    });
    await expect(
      coordinateSequenceOperation<OpResult>(handle2, seqRequest(), async () => ({
        status: 'applied' as const,
        result: {
          status: 'applied' as const,
          revision: 'revision-1',
          cursor: 'cursor-1',
          warnings: ['b'],
        },
      })),
    ).rejects.toThrow();
  });
});

interface PushState {
  business: string[];
  operations: Operation[];
  receipts: StoredOperationReceipt<OperationResult>[];
  conflicts: { id: string }[];
  cursors: string[];
  audits: { id: string }[];
  outbox: { id: string }[];
  operationClaims: Map<string, SyncOperationClaim>;
  reuseAudits: Map<string, SyncOperationReuseAudit>;
}

function emptyPush(): PushState {
  return {
    business: [],
    operations: [],
    receipts: [],
    conflicts: [],
    cursors: [],
    audits: [],
    outbox: [],
    operationClaims: new Map(),
    reuseAudits: new Map(),
  };
}

class PushHandle implements SyncUnitOfWork<
  Operation,
  OperationResult,
  { id: string },
  { id: string },
  { id: string }
> {
  readonly operationIdReservationOwner = 'push' as const;

  constructor(readonly state: PushState = emptyPush()) {}

  async execute<Value>(
    work: (
      transaction: SyncTransaction<
        Operation,
        OperationResult,
        { id: string },
        { id: string },
        { id: string }
      >,
    ) => Promise<Value>,
  ): Promise<Value> {
    await Promise.resolve();
    const draft: PushState = {
      ...structuredClone({
        business: this.state.business,
        operations: this.state.operations,
        receipts: this.state.receipts,
        conflicts: this.state.conflicts,
        cursors: this.state.cursors,
        audits: this.state.audits,
        outbox: this.state.outbox,
      }),
      operationClaims: new Map(this.state.operationClaims),
      reuseAudits: new Map(this.state.reuseAudits),
    };
    try {
      const result = await work({
        idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
        operationClaims: {
          load: async (id) => structuredClone(draft.operationClaims.get(id)),
          save: async (claim: SyncOperationClaim) => {
            draft.operationClaims.set(claim.operationId, structuredClone(claim));
          },
        },
        reuseAudits: {
          append: async (audit) => {
            const key = `a-${draft.reuseAudits.size + 1}`;
            draft.reuseAudits.set(key, structuredClone(audit));
            return key;
          },
          load: async (key) => structuredClone(draft.reuseAudits.get(key)),
        },
        receipts: {
          findByOperationId: async (operationId) =>
            structuredClone(draft.receipts.find((receipt) => receipt.operationId === operationId)),
          findBySequence: async (replicaId, sequenceScope, sequence) =>
            structuredClone(
              draft.receipts.find(
                (receipt) =>
                  receipt.replicaId === replicaId &&
                  receipt.sequenceScope === sequenceScope &&
                  receipt.sequence === sequence,
              ),
            ),
          save: async (receipt) => {
            draft.receipts.push(structuredClone(receipt));
          },
        },
        putBusiness: async (value: string) => {
          draft.business.push(value);
        },
        appendOperation: async (operation) => {
          draft.operations.push(structuredClone(operation));
        },
        saveConflict: async (conflict) => {
          draft.conflicts.push(structuredClone(conflict));
        },
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
      } as SyncTransaction<
        Operation,
        OperationResult,
        { id: string },
        { id: string },
        { id: string }
      >);
      Object.assign(this.state, {
        business: draft.business,
        operations: draft.operations,
        receipts: draft.receipts,
        conflicts: draft.conflicts,
        cursors: draft.cursors,
        audits: draft.audits,
        outbox: draft.outbox,
      });
      this.state.operationClaims = draft.operationClaims;
      this.state.reuseAudits = draft.reuseAudits;
      return result;
    } catch (error) {
      throw error;
    }
  }
}

describe(`U-4 P2 push validation / non-reflection ${evidence}`, () => {
  it(`mutant ~1441: invalid operation error uses '/' for empty instancePath; store idle; secret not reflected ${evidence}`, async () => {
    const handle = new PushHandle();
    const secret = 'super-secret-token-value';
    const invalidOperation = {
      batchId: 'batch-u4-1',
      atomic: true,
      serverCursor: 'cursor-0',
      operations: [
        {
          operation: {
            opId: 'operation-1',
            replicaId: 'replica-1',
            sequence: 1,
            type: 'not-an-operation',
            occurredAt: '2026-07-18T00:00:00Z',
            collectionId: 'collection-1',
            targetId: 'node-1',
            baseRevision: 'revision-1',
            payload: { token: secret },
          },
          sequenceScope: 'collection-1',
          digest: 'digest-1',
        },
      ],
    } as unknown as PushTransactionRequest;

    let caught: unknown;
    try {
      await coordinatePushTransaction(handle, invalidOperation, async () => {
        throw new Error('preflight must not run');
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // Original maps only empty instancePath to '/'; mutant `!== ''` maps every
    // non-empty path (e.g. /type) to '/' and loses the JSON pointer.
    expect(String(caught)).toMatch(/at \/type:/);
    expect(String(caught)).not.toMatch(/at \/:/);
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(handle.state.operations).toEqual([]);
    expect(handle.state.receipts).toEqual([]);
    expect(handle.state.business).toEqual([]);
  });
});
