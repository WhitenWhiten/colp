import { describe, expect, it } from 'vitest';
import {
  PushSequenceBlockedError,
  PushSequenceGapError,
  PushSequenceStateUnavailableError,
  type SyncUnitOfWork,
  type PushTransactionRequest,
} from '../../src/sync/index.js';
import {
  coordinatePushTransaction,
} from '../../src/sync/unsafe.js';
import {
  DurableContractHandle,
  plan,
  request,
  type Audit,
  type Conflict,
  type Outbox,
  type TestTransaction,
} from './push-transaction-harness.js';
import type { Operation, OperationResult } from '../../src/types/index.js';

const one = (sequence: number, atomic = false) => ({
  ...request(atomic, 1),
  operations: [{
    ...request(atomic, 1).operations[0]!,
    operation: { ...request(atomic, 1).operations[0]!.operation, sequence, opId: `operation-${sequence}` },
    digest: `digest-${sequence}`,
  }] as unknown as PushTransactionRequest['operations'],
} as PushTransactionRequest);

describe('Push-owned Sequence continuity [evidence:sync.composition]', () => {
  it('rejects a gap before claims or preflight', async () => {
    const unit = new DurableContractHandle();
    let preflightCalls = 0;
    await expect(coordinatePushTransaction(unit, one(2), async () => {
      preflightCalls += 1;
      return plan('applied', 2);
    })).rejects.toBeInstanceOf(PushSequenceGapError);
    expect(preflightCalls).toBe(0);
    expect(unit.backend.state.receipts).toEqual([]);
  });

  it('blocks a larger sequence while the expected receipt is deferred', async () => {
    const unit = new DurableContractHandle();
    await coordinatePushTransaction(unit, one(1), async () => plan('deferred', 1));
    await expect(coordinatePushTransaction(unit, one(2), async () => plan('applied', 2)))
      .rejects.toMatchObject({ expectedSequence: 1 });
    await expect(coordinatePushTransaction(unit, one(2), async () => plan('applied', 2)))
      .rejects.toBeInstanceOf(PushSequenceBlockedError);
  });

  it('advances lane state only after terminal results', async () => {
    const unit = new DurableContractHandle();
    await coordinatePushTransaction(unit, one(1), async () => plan('applied', 1));
    await expect(coordinatePushTransaction(unit, one(2), async () => plan('applied', 2)))
      .resolves.toMatchObject({ results: [{ sequence: 2, status: 'applied' }] });
    expect(unit.backend.state.laneStates.get(JSON.stringify(['replica-1', 'collection-1'])))
      .toEqual({ nextSequence: 3 });
  });

  it('admits contiguous atomic operations and checks the lane before writes', async () => {
    const unit = new DurableContractHandle();
    const batch = request(true, 2);
    await expect(coordinatePushTransaction(unit, batch, async (_item: unknown, index: number) => plan('applied', index + 1)))
      .resolves.toMatchObject({ results: [{ sequence: 1 }, { sequence: 2 }] });
    expect(unit.backend.state.laneStates.get(JSON.stringify(['replica-1', 'collection-1'])))
      .toEqual({ nextSequence: 3 });
  });

  it('keeps durable state monotonic for reverse-ordered contiguous operations', async () => {
    const unit = new DurableContractHandle();
    const ordered = request(true, 2);
    const reversed = Object.freeze({
      ...ordered,
      operations: Object.freeze([...ordered.operations].reverse()),
    }) as unknown as PushTransactionRequest;
    await expect(coordinatePushTransaction(unit, reversed, async (item) => plan('applied', item.operation.sequence)))
      .resolves.toMatchObject({ results: [{ sequence: 2 }, { sequence: 1 }] });
    expect(unit.backend.state.laneStates.get(JSON.stringify(['replica-1', 'collection-1'])))
      .toEqual({ nextSequence: 3 });
    await expect(coordinatePushTransaction(unit, one(3), async () => plan('applied', 3)))
      .resolves.toMatchObject({ results: [{ sequence: 3, status: 'applied' }] });
  });

  it('fails closed when a marked production adapter omits the lane store', async () => {
    const base = new DurableContractHandle();
    const unit: SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, TestTransaction> = {
      operationIdReservationOwner: 'push',
      pushSequenceContinuity: true,
      execute: (work, scope) => (base.execute as any)(async (transaction: TestTransaction) => {
        const { sequenceLanes: _ignored, ...withoutLaneStore } = transaction;
        return work(withoutLaneStore as TestTransaction);
      }, scope),
    };
    await expect(coordinatePushTransaction(unit, one(1), async () => plan('applied', 1)))
      .rejects.toBeInstanceOf(PushSequenceStateUnavailableError);
  });
});
