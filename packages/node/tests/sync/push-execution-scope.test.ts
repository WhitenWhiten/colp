/**
 * Push execution scope and lane serialization through the public host.
 *
 * The adapter model serializes per Sequence lane (not globally) and enforces
 * uniqueness at commit, so these tests observe shared committed state rather
 * than coordinator internals.
 */
import { describe, expect, it } from 'vitest';

import type { Operation } from '../../src/types/index.js';
import {
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
  UniqueViolation,
  latch,
  type LaneAudit,
  type LaneConflict,
  type LaneOutbox,
  type LaneTransaction,
} from './push-lane-harness.js';
import { verifiedSession } from './verified-session-fixture.js';

type Plan = PushPreparedOperation<LaneTransaction, LaneConflict, LaneAudit, LaneOutbox>;

function item(opId: string, replicaId: string, sequence: number, digest = `digest-${opId}`): PushTransactionOperation {
  const operation: Operation = {
    opId, replicaId, sequence, type: 'delete_node', occurredAt: '2026-07-18T00:00:00Z',
    collectionId: 'collection-1', targetId: `node-${opId}`, baseRevision: 'revision-1', payload: {},
  };
  return { operation, sequenceScope: 'collection-1', digest } as PushTransactionOperation;
}

function pushRequest(
  sessionId: string,
  atomic: boolean,
  items: readonly PushTransactionOperation[],
): PushTransactionRequest {
  return {
    batchId: bindSyncPushBatchId(sessionId, 'batch'),
    atomic,
    serverCursor: 'cursor-0',
    operations: items as PushTransactionRequest['operations'],
  };
}

interface PreflightOptions {
  readonly beforeApply?: (operation: Operation) => Promise<void>;
  readonly failAfterBusiness?: boolean;
}

function appliedPreflight(calls: string[], options: PreflightOptions = {}) {
  return async (candidate: PushTransactionOperation): Promise<Plan> => {
    const { operation } = candidate;
    calls.push(operation.opId);
    return {
      status: 'applied',
      apply: async (transaction) => {
        await options.beforeApply?.(operation);
        await transaction.putBusiness(`business-${operation.opId}`);
        if (options.failAfterBusiness === true) throw new Error('injected business failure');
        return { opId: operation.opId, sequence: operation.sequence, status: 'applied', revision: 'r2', warnings: [] };
      },
      audit: async () => ({ id: `audit-${operation.opId}` }),
      outbox: async ({ cursor }) => ({ id: `outbox-${operation.opId}`, cursor: cursor! }),
    };
  };
}

async function pushHost(sessionId = 'session-1') {
  const session = await verifiedSession(sessionId, { authorizationScopes: ['sync:pull', 'sync:push'] });
  return { host: createSyncHost({ owner: 'push', session }), sessionId };
}

function withTimeout<Value>(promise: Promise<Value>, label: string): Promise<Value> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 1_000)),
  ]);
}

describe('Push execution scope', () => {
  it('hands an atomic batch every lane in deterministic lock order and one Collection', async () => {
    const db = new LaneSerializedDatabase();
    const { host, sessionId } = await pushHost();
    await host.push(new LaneSerializedUnitOfWork(db), pushRequest(sessionId, true, [
      item('op-1', 'replica-b', 1), item('op-2', 'replica-a', 1), item('op-3', 'replica-b', 2),
    ]), appliedPreflight([]));
    expect(db.scopes).toEqual([{
      collectionIds: ['collection-1'],
      lanes: [
        { replicaId: 'replica-a', sequenceScope: 'collection-1' },
        { replicaId: 'replica-b', sequenceScope: 'collection-1' },
      ],
    }]);
  });

  it('hands each non-atomic operation only its own lane', async () => {
    const db = new LaneSerializedDatabase();
    const { host, sessionId } = await pushHost();
    await host.push(new LaneSerializedUnitOfWork(db), pushRequest(sessionId, false, [
      item('op-1', 'replica-b', 1), item('op-2', 'replica-a', 1),
    ]), appliedPreflight([]));
    expect(db.scopes.map(scope => scope.lanes)).toEqual([
      [{ replicaId: 'replica-b', sequenceScope: 'collection-1' }],
      [{ replicaId: 'replica-a', sequenceScope: 'collection-1' }],
    ]);
  });

  it('scopes the atomic reuse-denial audit transaction to the batch lanes', async () => {
    const db = new LaneSerializedDatabase();
    const { host, sessionId } = await pushHost();
    const denied = host.push(new LaneSerializedUnitOfWork(db), pushRequest(sessionId, true, [
      item('op-1', 'replica-a', 1), item('op-2', 'replica-a', 1),
    ]), appliedPreflight([]));
    await expect(denied).rejects.toMatchObject({ code: 'sequence_reuse' });
    expect(db.scopes).toEqual([{
      collectionIds: ['collection-1'],
      lanes: [{ replicaId: 'replica-a', sequenceScope: 'collection-1' }],
    }]);
    expect([...db.state.reuseAudits.values()]).toHaveLength(1);
    expect(db.state.business).toEqual([]);
  });
});

describe('Push under lane-serialized concurrency', () => {
  it('commits one of two concurrent same-lane requests and denies the other as sequence reuse', async () => {
    const db = new LaneSerializedDatabase();
    const { host, sessionId } = await pushHost();
    const calls: string[] = [];
    const outcomes = await Promise.allSettled([
      host.push(new LaneSerializedUnitOfWork(db), pushRequest(sessionId, false, [item('op-a', 'replica-1', 1)]),
        appliedPreflight(calls)),
      host.push(new LaneSerializedUnitOfWork(db), pushRequest(sessionId, false, [item('op-b', 'replica-1', 1)]),
        appliedPreflight(calls)),
    ]);
    const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(SyncOperationReuseError);
    expect(rejected[0]!.reason).toMatchObject({ code: 'sequence_reuse' });
    expect(db.maxActive).toBe(1);
    expect(calls).toHaveLength(1);
    expect(db.state.business).toEqual([`business-${calls[0]}`]);
    expect(db.state.receipts.map(receipt => receipt.operationId)).toEqual(calls);
    expect(db.state.operations.map(operation => operation.opId)).toEqual(calls);
    expect([...db.state.claims.keys()]).toEqual(calls);
    expect([...db.state.reuseAudits.values()]).toEqual([expect.objectContaining({ code: 'sequence_reuse' })]);
  });

  it('executes one of two concurrent identical requests and replays the persisted result for the other', async () => {
    const db = new LaneSerializedDatabase();
    const { host, sessionId } = await pushHost();
    const calls: string[] = [];
    const request = pushRequest(sessionId, false, [item('op-a', 'replica-1', 1)]);
    const [first, second] = await Promise.all([
      host.push(new LaneSerializedUnitOfWork(db), request, appliedPreflight(calls)),
      host.push(new LaneSerializedUnitOfWork(db), request, appliedPreflight(calls)),
    ]);
    expect(calls).toEqual(['op-a']);
    expect(second.result.results).toEqual(first.result.results);
    expect(db.state.business).toEqual(['business-op-a']);
    expect(db.state.receipts).toHaveLength(1);
    expect(db.state.operations).toHaveLength(1);
    expect(db.state.outbox).toHaveLength(1);
  });

  it('runs requests on different lanes concurrently without a global lock', async () => {
    const db = new LaneSerializedDatabase();
    const { host, sessionId } = await pushHost();
    const bothBegan = latch();
    let began = 0;
    db.onBegin = async () => {
      began += 1;
      if (began === 2) bothBegan.open();
      await bothBegan.wait();
    };
    await withTimeout(Promise.all([
      host.push(new LaneSerializedUnitOfWork(db), pushRequest(sessionId, false, [item('op-a', 'replica-a', 1)]),
        appliedPreflight([])),
      host.push(new LaneSerializedUnitOfWork(db), pushRequest(sessionId, false, [item('op-b', 'replica-b', 1)]),
        appliedPreflight([])),
    ]), 'disjoint-lane Push');
    expect(db.maxActive).toBe(2);
    expect([...db.state.business].sort()).toEqual(['business-op-a', 'business-op-b']);
    expect(db.state.receipts).toHaveLength(2);
  });

  it('rolls back the loser of a cross-lane operation-ID race; its retry is denied as op_id_reused', async () => {
    const db = new LaneSerializedDatabase();
    const { host, sessionId } = await pushHost();
    const bothStaged = latch();
    let staged = 0;
    db.beforeCommit = async () => {
      staged += 1;
      if (staged === 2) bothStaged.open();
      await bothStaged.wait();
    };
    const racing = [
      pushRequest(sessionId, false, [item('op-shared', 'replica-a', 1, 'digest-a')]),
      pushRequest(sessionId, false, [item('op-shared', 'replica-b', 1, 'digest-b')]),
    ];
    const outcomes = await withTimeout(Promise.allSettled(racing.map(request =>
      host.push(new LaneSerializedUnitOfWork(db), request, appliedPreflight([])))), 'cross-lane race');
    const rejected = outcomes.findIndex(outcome => outcome.status === 'rejected');
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((outcomes[rejected] as PromiseRejectedResult).reason).toBeInstanceOf(UniqueViolation);
    expect(db.state.business).toHaveLength(1);
    expect(db.state.receipts).toHaveLength(1);
    expect(db.state.claims.size).toBe(1);

    db.beforeCommit = undefined;
    await expect(host.push(new LaneSerializedUnitOfWork(db), racing[rejected]!, appliedPreflight([])))
      .rejects.toMatchObject({ code: 'op_id_reused' });
    expect(db.state.business).toHaveLength(1);
    expect(db.state.receipts).toHaveLength(1);
  });

  it('leaves no partial business, receipt, claim or operation writes when a transaction fails', async () => {
    const db = new LaneSerializedDatabase();
    const { host, sessionId } = await pushHost();
    const request = pushRequest(sessionId, true, [item('op-a', 'replica-a', 1), item('op-b', 'replica-b', 1)]);
    await expect(host.push(new LaneSerializedUnitOfWork(db), request, appliedPreflight([], {
      beforeApply: async (operation) => {
        if (operation.opId === 'op-b') throw new Error('injected business failure');
      },
    }))).rejects.toThrow('injected business failure');
    expect(db.state).toMatchObject({ business: [], receipts: [], operations: [], audits: [], outbox: [] });
    expect(db.state.claims.size).toBe(0);
    expect(db.rollbacks).toBe(1);

    await host.push(new LaneSerializedUnitOfWork(db), request, appliedPreflight([]));
    expect(db.state.business).toEqual(['business-op-a', 'business-op-b']);
    expect(db.state.receipts).toHaveLength(2);
  });
});
