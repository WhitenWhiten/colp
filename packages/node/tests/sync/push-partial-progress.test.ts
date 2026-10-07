/**
 * Non-atomic Push keeps its committed prefix visible when a later operation is
 * denied for reuse; atomic batches expose no newly committed prefix.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Operation } from '../../src/types/index.js';
import {
  PushOperationReuseError,
  SyncOperationReuseError,
  bindSyncPushBatchId,
  createSyncHost,
  type PushPreparedOperation,
  type PushTransactionOperation,
  type PushTransactionRequest,
} from '../../src/sync/index.js';
import {
  LaneSerializedDatabase,
  LaneSerializedUnitOfWork,
  type LaneAudit,
  type LaneConflict,
  type LaneOutbox,
  type LaneTransaction,
} from './push-lane-harness.js';
import { verifiedSession } from './verified-session-fixture.js';

type Plan = PushPreparedOperation<LaneTransaction, LaneConflict, LaneAudit, LaneOutbox>;

function item(opId: string, sequence: number): PushTransactionOperation {
  const operation: Operation = {
    opId, replicaId: 'replica-1', sequence, type: 'delete_node', occurredAt: '2026-07-18T00:00:00Z',
    collectionId: 'collection-1', targetId: `node-${opId}`, baseRevision: 'revision-1', payload: {},
  };
  return { operation, sequenceScope: 'collection-1', digest: `digest-${opId}` } as PushTransactionOperation;
}

function batch(sessionId: string, atomic: boolean, items: readonly PushTransactionOperation[]): PushTransactionRequest {
  return {
    batchId: bindSyncPushBatchId(sessionId, 'batch'), atomic, serverCursor: 'cursor-0',
    operations: items as PushTransactionRequest['operations'],
  };
}

function applied(calls: string[]) {
  return async ({ operation }: PushTransactionOperation): Promise<Plan> => {
    calls.push(operation.opId);
    return {
      status: 'applied',
      apply: async (transaction) => {
        await transaction.putBusiness(`business-${operation.opId}`);
        return { opId: operation.opId, sequence: operation.sequence, status: 'applied', revision: 'r2', warnings: [] };
      },
      audit: async () => ({ id: `audit-${operation.opId}` }),
      outbox: async ({ cursor }) => ({ id: `outbox-${operation.opId}`, cursor: cursor! }),
    };
  };
}

async function setup() {
  const session = await verifiedSession('session-1', { authorizationScopes: ['sync:pull', 'sync:push'] });
  const db = new LaneSerializedDatabase();
  const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier: () => true });
  const push = (request: PushTransactionRequest, calls: string[] = []) =>
    host.push(new LaneSerializedUnitOfWork(db), request, applied(calls)).then(({ result }) => result);
  return { db, push, sessionId: session.sessionId };
}

async function denial(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a reuse denial');
}

describe('non-atomic Push reuse denial after progress', () => {
  it.each(['wide', 'deep', 'bytes'] as const)('preserves 409 and replayable progress for individually valid results (%s)', async (shape) => {
    const session = await verifiedSession('session-1', { authorizationScopes: ['sync:push'] });
    const db = new LaneSerializedDatabase();
    const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier: () => true });
    const prefix = Array.from({ length: 20 }, (_, index) => item(`op-${index + 1}`, index + 1));
    const transform = shape === 'wide'
      ? Object.fromEntries(Array.from({ length: 600 }, (_, key) => [`k${key}`, key]))
      : shape === 'bytes' ? { value: 'x'.repeat(500_000) }
        : Array.from({ length: 60 }).reduce<Record<string, unknown>>((value) => ({ nested: value }), { leaf: 1 });
    const preflight = async ({ operation }: PushTransactionOperation): Promise<Plan> => ({
      status: 'rebased',
      apply: async (transaction) => {
        await transaction.putBusiness(`business-${operation.opId}`);
        return { opId: operation.opId, sequence: operation.sequence, status: 'rebased',
          revision: 'r2', warnings: [], transform };
      },
      audit: async () => ({ id: `audit-${operation.opId}` }),
      outbox: async ({ cursor }) => ({ id: `outbox-${operation.opId}`, cursor: cursor! }),
    });
    const error = await denial(host.push(new LaneSerializedUnitOfWork(db),
      batch(session.sessionId, false, [...prefix, item('denied', 1)]), preflight));
    expect(error).toBeInstanceOf(PushOperationReuseError);
    const reuse = error as PushOperationReuseError;
    expect(reuse).toMatchObject({ status: 409, code: 'sequence_reuse', progress: {
      results: expect.any(Array), failed: { index: 20, opId: 'denied' }, serverCursor: 'cursor-20',
    } });
    expect(reuse.progress.results).toHaveLength(20);
    expect(Object.isFrozen(reuse.progress)).toBe(true);
    const first = reuse.progress.results[0];
    if (first?.status !== 'rebased') throw new Error('Expected rebased prefix result');
    expect(Object.isFrozen(first.transform)).toBe(true);
    expect(db.state.business).toHaveLength(20);
    expect(db.state.receipts).toHaveLength(20);
    expect(db.state.reuseAudits.get(reuse.auditKey)).toEqual(reuse.audit);
    const replay = vi.fn(async (): Promise<Plan> => { throw new Error('prefix must replay without preflight'); });
    const retried = await host.push(new LaneSerializedUnitOfWork(db), batch(session.sessionId, false, prefix), replay);
    expect(retried.result.results).toEqual(reuse.progress.results);
    expect(replay).not.toHaveBeenCalled();
    expect(db.state.business).toHaveLength(20);
  });

  it('exposes the committed prefix, failed identity, latest cursor and persisted audit', async () => {
    const { db, push, sessionId } = await setup();
    const error = await denial(push(batch(sessionId, false, [item('op-1', 1), item('op-2', 1)])));
    expect(error).toBeInstanceOf(PushOperationReuseError);
    expect(error).toBeInstanceOf(SyncOperationReuseError);
    const reuse = error as PushOperationReuseError;
    expect(reuse).toMatchObject({ status: 409, code: 'sequence_reuse' });
    expect(reuse.progress).toEqual({
      batchId: bindSyncPushBatchId(sessionId, 'batch'),
      results: [expect.objectContaining({ opId: 'op-1', status: 'applied', cursor: 'cursor-1' })],
      failed: {
        index: 1, opId: 'op-2', replicaId: 'replica-1', sequenceScope: 'collection-1', sequence: 1,
        digest: 'digest-op-2',
      },
      serverCursor: 'cursor-1',
    });
    expect(Object.isFrozen(reuse.progress.results)).toBe(true);
    expect(db.state.reuseAudits.get(reuse.auditKey)).toEqual(reuse.audit);
    expect(db.state.business).toEqual(['business-op-1']);
  });

  it('replays the committed operation on retry without another business write', async () => {
    const { db, push, sessionId } = await setup();
    const reuse = await denial(push(batch(sessionId, false, [item('op-1', 1), item('op-2', 1)]))) as PushOperationReuseError;
    const calls: string[] = [];
    const retry = await push(batch(sessionId, false, [item('op-1', 1)]), calls);
    expect(retry.results).toEqual(reuse.progress.results);
    expect(calls).toEqual([]);
    expect(db.state.business).toEqual(['business-op-1']);
    expect(db.state.receipts).toHaveLength(1);
  });

  it('reports an empty prefix and the request cursor when the first operation is denied', async () => {
    const { push, sessionId } = await setup();
    await push(batch(sessionId, false, [item('op-1', 1)]));
    const reuse = await denial(push(batch(sessionId, false, [item('op-2', 1)]))) as PushOperationReuseError;
    expect(reuse.progress).toMatchObject({ results: [], failed: { index: 0, opId: 'op-2' }, serverCursor: 'cursor-0' });
  });
});

describe('atomic Push reuse denial', () => {
  it('commits and exposes no prefix for an in-batch or stored reuse', async () => {
    const { db, push, sessionId } = await setup();
    const local = await denial(push(batch(sessionId, true, [item('op-1', 1), item('op-2', 1)])));
    expect(local).toBeInstanceOf(SyncOperationReuseError);
    expect(local).not.toBeInstanceOf(PushOperationReuseError);
    expect(db.state.business).toEqual([]);

    await push(batch(sessionId, false, [item('op-x', 2)]));
    const stored = await denial(push(batch(sessionId, true, [item('op-1', 1), item('op-3', 2)])));
    expect(stored).toBeInstanceOf(SyncOperationReuseError);
    expect(stored).not.toBeInstanceOf(PushOperationReuseError);
    expect(db.state.business).toEqual(['business-op-x']);
    expect(db.state.receipts.map(receipt => receipt.operationId)).toEqual(['op-x']);
  });
});
