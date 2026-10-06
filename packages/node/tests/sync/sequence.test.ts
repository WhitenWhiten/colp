import { describe, expect, it, vi } from 'vitest';

import {
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceEvaluation,
  type SequenceLaneKey,
  type SequenceLaneState,
  type SequenceOperationRequest,
  type SequenceReceiptWriteCondition,
  type StoredOperationReceipt,
  type TerminalOperationStatus,
  SyncOperationReceiptUnavailableError,
} from '../../src/sync/index.js';
import {
  coordinateSequenceOperation,
} from '../../src/sync/unsafe.js';

const evidence = '[evidence:sync.sequence]';

type OperationResult = Readonly<Record<string, unknown>> & {
  readonly status: TerminalOperationStatus | 'deferred';
};

interface DurableState {
  readonly lanes: Map<string, SequenceLaneState>;
  readonly receipts: Map<string, StoredOperationReceipt<OperationResult>>;
  readonly operationClaims: Map<string, any>;
  readonly reuseAudits: Map<string, any>;
}

function laneIdentity(lane: SequenceLaneKey): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope]);
}

function receiptIdentity(lane: SequenceLaneKey, sequence: number): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope, sequence]);
}

function cloneState(state: DurableState): DurableState {
  const result = {
    lanes: new Map([...state.lanes].map(([key, value]) => [key, structuredClone(value)])),
    receipts: new Map([...state.receipts].map(([key, value]) => [key, structuredClone(value)])),
    operationClaims: new Map([...state.operationClaims].map(([key, value]) => [key, structuredClone(value)])),
    reuseAudits: new Map([...state.reuseAudits].map(([key, value]) => [key, structuredClone(value)])),
  } as DurableState;
  Object.defineProperties(result, { operationClaims: { enumerable: false }, reuseAudits: { enumerable: false } });
  return result;
}

class SharedDurableBackend {
  state: DurableState = { lanes: new Map(), receipts: new Map(), operationClaims: new Map(), reuseAudits: new Map() };
  readonly laneTails = new Map<string, Promise<void>>();

  snapshot(): DurableState {
    return cloneState(this.state);
  }
}

class DurableSequenceHandle implements SequenceCoordinatorUnitOfWork<OperationResult> {
  readonly operationIdReservationOwner = 'sequence' as const;
  failReceiptSave = false;
  failLaneSave = false;
  ignoreLaneSave = false;
  rejectAfterCommitOnce = false;
  ignoreReceiptSave = false;
  replaceSavedReceipt?: (
    receipt: StoredOperationReceipt<OperationResult>,
  ) => StoredOperationReceipt<OperationResult>;
  mutateReceiptSaveInputAfterCopy = false;

  constructor(readonly backend = new SharedDurableBackend()) {}

  execute<Value>(
    lane: SequenceLaneKey,
    work: (transaction: SequenceCoordinatorTransaction<OperationResult>) => Promise<Value>,
  ): Promise<Value> {
    const identity = laneIdentity(lane);
    const previous = this.backend.laneTails.get(identity) ?? Promise.resolve();
    const run = async (): Promise<Value> => {
      const draft = cloneState(this.backend.state);
      const result = await work(this.transaction(draft));
      this.backend.state = draft;
      if (this.rejectAfterCommitOnce) {
        this.rejectAfterCommitOnce = false;
        throw new Error('commit outcome unknown');
      }
      return result;
    };
    const outcome = previous.then(run, run);
    this.backend.laneTails.set(identity, outcome.then(() => undefined, () => undefined));
    return outcome;
  }

  private transaction(draft: DurableState): SequenceCoordinatorTransaction<OperationResult> {
    return {
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      operationClaims: {
        load: async (id: string) => structuredClone(draft.operationClaims.get(id)),
        save: async (claim: any) => { draft.operationClaims.set(claim.operationId, structuredClone(claim)); },
      },
      reuseAudits: {
        append: async (audit: any) => { const key = `reuse-${draft.reuseAudits.size + 1}`; draft.reuseAudits.set(key, structuredClone(audit)); return key; },
        load: async (key: string) => structuredClone(draft.reuseAudits.get(key)),
      },
      loadLaneState: async (lane) => {
        const state = draft.lanes.get(laneIdentity(lane));
        return state === undefined ? undefined : structuredClone(state);
      },
      saveLaneState: async (lane, state) => {
        if (this.failLaneSave) throw new Error('injected lane-state save failure');
        if (this.ignoreLaneSave) return;
        draft.lanes.set(laneIdentity(lane), structuredClone(state));
      },
      receipts: {
        load: async (lane, sequence) => {
          const receipt = draft.receipts.get(receiptIdentity(lane, sequence));
          return receipt === undefined ? undefined : structuredClone(receipt);
        },
        save: async (receipt, condition) => {
          if (this.failReceiptSave) throw new Error('injected receipt save failure');
          if (this.ignoreReceiptSave) return;
          this.assertWriteCondition(draft, receipt, condition);
          const saved = this.replaceSavedReceipt?.(receipt) ?? receipt;
          draft.receipts.set(receiptIdentity(receipt, receipt.sequence), structuredClone(saved));
          if (this.mutateReceiptSaveInputAfterCopy) {
            const nested = (receipt.result as { nested?: string[] }).nested;
            if (nested !== undefined) nested[0] = 'adapter-mutated-input';
          }
        },
      },
    };
  }

  private assertWriteCondition(
    draft: DurableState,
    receipt: StoredOperationReceipt<OperationResult>,
    condition: SequenceReceiptWriteCondition,
  ): void {
    const current = draft.receipts.get(receiptIdentity(receipt, receipt.sequence));
    if (condition.kind === 'absent') {
      if (current !== undefined) throw new Error('receipt already exists');
      return;
    }
    if (current?.status !== 'deferred' || current.digest !== condition.digest) {
      throw new Error('deferred receipt replacement precondition failed');
    }
  }
}

function request(overrides: Partial<SequenceOperationRequest> = {}): SequenceOperationRequest {
  return {
    operationId: 'operation-1',
    replicaId: 'replica-1',
    sequenceScope: 'collection-1',
    sequence: 1,
    digest: 'sha-256:operation-1',
    ...overrides,
  };
}

function terminalResult(status: TerminalOperationStatus): OperationResult {
  switch (status) {
    case 'applied':
      return { status, revision: 'revision-2', cursor: 'cursor-11', warnings: [] };
    case 'rebased':
      return { status, revision: 'revision-3', cursor: 'cursor-12', warnings: ['rebased'] };
    case 'noop':
      return { status, revision: 'revision-3', cursor: 'cursor-12', warnings: [] };
    case 'conflicted':
      return { status, conflictId: 'conflict-1', cursor: 'cursor-13', warnings: ['manual'] };
    case 'rejected':
      return { status, code: 'policy_denied', warnings: ['not allowed'] };
  }
}

async function evaluateOnce(
  adapter: SequenceCoordinatorUnitOfWork<OperationResult>,
  operation: SequenceOperationRequest,
  evaluation: SequenceEvaluation<OperationResult>,
) {
  return coordinateSequenceOperation(adapter, operation, async () => evaluation);
}

describe(`SYNC-0002 durable Sequence coordinator ${evidence}`, () => {
  it.each<TerminalOperationStatus>(['applied', 'rebased', 'noop', 'conflicted', 'rejected'])(
    `%s consumes exactly one Sequence and exact retry replays every field without executing ${evidence}`,
    async (status) => {
      const adapter = new DurableSequenceHandle();
      const result = terminalResult(status);
      const evaluator = vi.fn(async () => ({ status, result }));

      const first = await coordinateSequenceOperation(adapter, request(), evaluator);
      const replay = await coordinateSequenceOperation(adapter, request(), evaluator);
      const second = await evaluateOnce(adapter, request({
        operationId: 'operation-2', sequence: 2, digest: 'sha-256:operation-2',
      }), { status: 'applied', result: terminalResult('applied') });

      expect(first).toEqual({ kind: 'executed', receipt: expect.objectContaining({ status, result }) });
      expect(replay).toEqual({ kind: 'replayed', receipt: first.kind === 'executed' ? first.receipt : undefined });
      expect(evaluator).toHaveBeenCalledTimes(1);
      expect(second).toMatchObject({ kind: 'executed', receipt: { sequence: 2 } });
      expect(adapter.backend.snapshot().lanes.get(laneIdentity(request()))).toEqual({ nextSequence: 3 });
    },
  );

  it(`persists deferred without advancing, replays it exactly, rejects reuse, and blocks larger Sequence ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    const deferred: OperationResult = {
      status: 'deferred' as const,
      code: 'dependency_pending',
      retryAfterSeconds: 17,
      warnings: ['wait for dependency'],
    };
    const evaluator = vi.fn(async () => ({ status: 'deferred' as const, result: deferred }));
    const first = await coordinateSequenceOperation(adapter, request(), evaluator);
    const replay = await coordinateSequenceOperation(adapter, request(), evaluator);
    const reuse = await coordinateSequenceOperation(
      adapter,
      request({ digest: 'sha-256:different' }),
      vi.fn(async () => ({ status: 'applied' as const, result: terminalResult('applied') })),
    );
    const blocked = await coordinateSequenceOperation(
      adapter,
      request({ operationId: 'operation-2', sequence: 2, digest: 'sha-256:operation-2' }),
      vi.fn(async () => ({ status: 'applied' as const, result: terminalResult('applied') })),
    );

    expect(first).toMatchObject({ kind: 'executed', receipt: { result: deferred } });
    expect(replay).toEqual({ kind: 'replayed', receipt: first.kind === 'executed' ? first.receipt : undefined });
    expect(reuse).toMatchObject({ kind: 'sequence_reuse' });
    expect(blocked).toEqual({ kind: 'sequence_blocked', expectedSequence: 1 });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(adapter.backend.snapshot().lanes.get(laneIdentity(request()))).toEqual({ nextSequence: 1 });
  });

  it(`requires explicit same-digest deferred re-evaluation before replacing it with a terminal receipt ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    const deferred = { status: 'deferred' as const, code: 'dependency_pending', retryAfterSeconds: 2 };
    await evaluateOnce(adapter, request(), { status: 'deferred', result: deferred });
    const evaluator = vi.fn(async (context) => {
      expect(context.previousDeferredReceipt?.result).toEqual(deferred);
      return { status: 'applied' as const, result: terminalResult('applied') };
    });

    await expect(coordinateSequenceOperation(adapter, request(), evaluator)).resolves.toMatchObject({
      kind: 'replayed', receipt: { status: 'deferred' },
    });
    const terminal = await coordinateSequenceOperation(
      adapter,
      request({ reevaluateDeferred: true }),
      evaluator,
    );

    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(terminal).toMatchObject({ kind: 'executed', receipt: { status: 'applied', sequence: 1 } });
    expect(adapter.backend.snapshot().lanes.get(laneIdentity(request()))).toEqual({ nextSequence: 2 });
  });

  it(`reports a gap without evaluating or mutating durable state ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    const evaluator = vi.fn(async () => ({ status: 'applied' as const, result: terminalResult('applied') }));
    await expect(coordinateSequenceOperation(adapter, request({ sequence: 3 }), evaluator)).resolves.toEqual({
      kind: 'sequence_gap', expectedSequence: 1,
    });
    expect(evaluator).not.toHaveBeenCalled();
    expect(adapter.backend.snapshot()).toEqual({ lanes: new Map(), receipts: new Map() });
  });

  it(`fails closed when durable lane state says an older consumed receipt is missing ${evidence}`, async () => {
    const backend = new SharedDurableBackend();
    backend.state.lanes.set(laneIdentity(request()), { nextSequence: 2 });
    const evaluator = vi.fn();
    await expect(coordinateSequenceOperation(
      new DurableSequenceHandle(backend), request(), evaluator,
    )).rejects.toThrow('missing a consumed Sequence receipt');
    await expect(coordinateSequenceOperation(
      new DurableSequenceHandle(backend), request(), evaluator,
    )).rejects.toMatchObject({
      name: 'SyncOperationReceiptUnavailableError',
      code: 'receipt_unavailable',
      claim: undefined,
    });
    await expect(coordinateSequenceOperation(
      new DurableSequenceHandle(backend), request(), evaluator,
    )).rejects.toBeInstanceOf(SyncOperationReceiptUnavailableError);
    expect(evaluator).not.toHaveBeenCalled();
  });

  it(`keeps different collection scopes and Replica lanes independent ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    const operations = [
      request(),
      request({ operationId: 'operation-c2', sequenceScope: 'collection-2', digest: 'sha-256:c2' }),
      request({ operationId: 'operation-r2', replicaId: 'replica-2', digest: 'sha-256:r2' }),
    ];
    for (const operation of operations) {
      await expect(evaluateOnce(adapter, operation, {
        status: 'applied', result: terminalResult('applied'),
      })).resolves.toMatchObject({ kind: 'executed', receipt: { sequence: 1 } });
    }
    expect(adapter.backend.snapshot().lanes).toEqual(new Map(operations.map((operation) => [
      laneIdentity(operation), { nextSequence: 2 },
    ])));
  });

  it(`observes persisted receipts through independent coordinator handles sharing one durable adapter contract ${evidence}`, async () => {
    const backend = new SharedDurableBackend();
    const firstHandle = new DurableSequenceHandle(backend);
    const secondHandle = new DurableSequenceHandle(backend);
    const evaluator = vi.fn(async () => ({ status: 'applied' as const, result: terminalResult('applied') }));

    const original = await coordinateSequenceOperation(firstHandle, request(), evaluator);
    const replay = await coordinateSequenceOperation(secondHandle, request(), evaluator);

    expect(replay).toEqual({ kind: 'replayed', receipt: original.kind === 'executed' ? original.receipt : undefined });
    expect(evaluator).toHaveBeenCalledTimes(1);
  });

  it(`serializes concurrent same-lane attempts through the durable adapter contract ${evidence}`, async () => {
    const backend = new SharedDurableBackend();
    const evaluator = vi.fn(async () => ({
      status: 'applied' as const,
      result: terminalResult('applied'),
    }));

    const outcomes = await Promise.all([
      coordinateSequenceOperation(new DurableSequenceHandle(backend), request(), evaluator),
      coordinateSequenceOperation(new DurableSequenceHandle(backend), request(), evaluator),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual(['executed', 'replayed']);
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(backend.snapshot().lanes.get(laneIdentity(request()))).toEqual({ nextSequence: 2 });
  });

  it(`keeps the persisted deferred result when explicit re-evaluation remains deferred ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    const original: OperationResult = {
      status: 'deferred' as const,
      code: 'dependency_pending',
      retryAfterSeconds: 17,
      warnings: ['original'],
    };
    await evaluateOnce(adapter, request(), { status: 'deferred', result: original });
    const evaluator = vi.fn(async (): Promise<SequenceEvaluation<OperationResult>> => ({
      status: 'deferred' as const,
      result: { ...original, retryAfterSeconds: 99, warnings: ['changed'] },
    }));

    await expect(coordinateSequenceOperation(
      adapter,
      request({ reevaluateDeferred: true }),
      evaluator,
    )).resolves.toMatchObject({ kind: 'replayed', receipt: { result: original } });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(adapter.backend.snapshot().lanes.get(laneIdentity(request()))).toEqual({ nextSequence: 1 });
  });

  it.each([
    ['receipt save', 'injected receipt save failure'],
    ['lane-state save', 'injected lane-state save failure'],
  ] as const)(`rolls back atomically after %s failure and retry evaluates again ${evidence}`, async (point, message) => {
    const adapter = new DurableSequenceHandle();
    if (point === 'receipt save') adapter.failReceiptSave = true;
    else adapter.failLaneSave = true;
    const evaluator = vi.fn(async () => ({ status: 'applied' as const, result: terminalResult('applied') }));

    await expect(coordinateSequenceOperation(adapter, request(), evaluator)).rejects.toThrow(message);
    expect(adapter.backend.snapshot()).toEqual({ lanes: new Map(), receipts: new Map() });
    adapter.failReceiptSave = false;
    adapter.failLaneSave = false;
    await expect(coordinateSequenceOperation(adapter, request(), evaluator)).resolves.toMatchObject({ kind: 'executed' });
    expect(evaluator).toHaveBeenCalledTimes(2);
  });

  it(`does not report success for commit-unknown and resolves retry from the persisted receipt ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    adapter.rejectAfterCommitOnce = true;
    const evaluator = vi.fn(async () => ({ status: 'applied' as const, result: terminalResult('applied') }));

    await expect(coordinateSequenceOperation(adapter, request(), evaluator)).rejects.toThrow('commit outcome unknown');
    const committed = adapter.backend.snapshot();
    expect(committed.receipts.size).toBe(1);
    await expect(coordinateSequenceOperation(adapter, request(), evaluator)).resolves.toMatchObject({
      kind: 'replayed', receipt: { status: 'applied' },
    });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(adapter.backend.snapshot()).toEqual(committed);
  });

  it.each(['does not save', 'replaces'] as const)(
    `rejects an adapter that %s the receipt during transaction-local verification ${evidence}`,
    async (behavior) => {
      const adapter = new DurableSequenceHandle();
      if (behavior === 'does not save') adapter.ignoreReceiptSave = true;
      else adapter.replaceSavedReceipt = (receipt) => ({
        ...receipt,
        result: { ...receipt.result, code: 'adapter-forged' },
      });

      await expect(evaluateOnce(adapter, request(), {
        status: 'rejected', result: terminalResult('rejected'),
      })).rejects.toThrow(behavior === 'does not save' ? 'was not persisted' : 'replaced or changed');
      expect(adapter.backend.snapshot()).toEqual({ lanes: new Map(), receipts: new Map() });
    },
  );

  it(`rejects a store that silently drops a deferred lane-state write ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    adapter.ignoreLaneSave = true;

    await expect(evaluateOnce(adapter, request(), {
      status: 'deferred',
      result: { status: 'deferred', code: 'dependency_pending' },
    })).rejects.toThrow('lane state was not persisted');
    expect(adapter.backend.snapshot()).toEqual({ lanes: new Map(), receipts: new Map() });
  });

  it(`rejects a UnitOfWork that returns a forged result instead of its callback result ${evidence}`, async () => {
    const base = new DurableSequenceHandle();
    const malicious: SequenceCoordinatorUnitOfWork<OperationResult> = {
      operationIdReservationOwner: 'sequence',
      execute: async <Value>(lane: SequenceLaneKey, work: (
        transaction: SequenceCoordinatorTransaction<OperationResult>,
      ) => Promise<Value>): Promise<Value> => {
        await base.execute(lane, work);
        return { kind: 'sequence_gap', expectedSequence: 999 } as unknown as Value;
      },
    };

    await expect(evaluateOnce(malicious, request(), {
      status: 'applied', result: terminalResult('applied'),
    })).rejects.toThrow('other than its transaction callback result');
  });

  it.each([
    'unit of work',
    'lane-state load',
    'receipt load',
    'evaluator',
    'receipt save',
    'lane-state save',
  ] as const)(`rejects a synchronous %s adapter boundary ${evidence}`, async (point) => {
    const base = new DurableSequenceHandle();
    if (point === 'unit of work') {
      await expect(coordinateSequenceOperation(
        { operationIdReservationOwner: 'sequence', execute: (() => undefined) as never }, request(),
        async () => ({ status: 'applied', result: terminalResult('applied') }),
      )).rejects.toThrow('must return a Promise');
      return;
    }
    const unitOfWork: SequenceCoordinatorUnitOfWork<OperationResult> = {
      operationIdReservationOwner: 'sequence',
      execute: (lane, work) => base.execute(lane, async (transaction) => work({
        idReservations: transaction.idReservations,
        operationClaims: transaction.operationClaims,
        reuseAudits: transaction.reuseAudits,
        loadLaneState: point === 'lane-state load'
          ? (() => undefined) as never
          : transaction.loadLaneState,
        saveLaneState: point === 'lane-state save'
          ? (() => undefined) as never
          : transaction.saveLaneState,
        receipts: {
          load: point === 'receipt load' ? (() => undefined) as never : transaction.receipts.load,
          save: point === 'receipt save' ? (() => undefined) as never : transaction.receipts.save,
        },
      })),
    };
    const evaluator = point === 'evaluator'
      ? (() => ({ status: 'applied', result: terminalResult('applied') })) as never
      : async () => ({ status: 'applied' as const, result: terminalResult('applied') });
    await expect(coordinateSequenceOperation(unitOfWork, request(), evaluator)).rejects.toThrow(
      'must return a Promise',
    );
    expect(base.backend.snapshot()).toEqual({ lanes: new Map(), receipts: new Map() });
  });

  it(`detaches caller and evaluator input from adapter mutation ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    adapter.mutateReceiptSaveInputAfterCopy = true;
    const callerRequest = request();
    const evaluationResult: OperationResult = { status: 'applied', nested: ['original'] };
    const beforeRequest = structuredClone(callerRequest);
    const beforeResult = structuredClone(evaluationResult);

    const coordinated = await coordinateSequenceOperation(adapter, callerRequest, async (context) => {
      expect(Object.isFrozen(context.request)).toBe(true);
      return { status: 'applied', result: evaluationResult };
    });

    expect(callerRequest).toEqual(beforeRequest);
    expect(evaluationResult).toEqual(beforeResult);
    expect(coordinated).toMatchObject({ receipt: { result: beforeResult } });
  });

  it(`returns deeply frozen detached values whose mutation cannot alter persisted replay ${evidence}`, async () => {
    const adapter = new DurableSequenceHandle();
    const original = await evaluateOnce(adapter, request(), {
      status: 'applied', result: { status: 'applied', nested: [{ value: 'original' }] },
    });
    if (original.kind !== 'executed') throw new Error('Expected execution.');
    const nested = original.receipt.result.nested as Array<{ value: string }>;
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.receipt)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested[0])).toBe(true);
    expect(() => { nested[0]!.value = 'mutated'; }).toThrow(TypeError);

    const snapshot = adapter.backend.snapshot();
    const persisted = [...snapshot.receipts.values()][0]!;
    (persisted.result.nested as Array<{ value: string }>)[0]!.value = 'snapshot-mutated';
    await expect(coordinateSequenceOperation(
      adapter, request(), vi.fn(),
    )).resolves.toMatchObject({
      kind: 'replayed', receipt: { result: { nested: [{ value: 'original' }] } },
    });
  });
});
