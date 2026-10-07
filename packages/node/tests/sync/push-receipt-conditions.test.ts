/**
 * Conditional Push receipt writes through the public host: first evaluation
 * inserts only when absent, a terminal re-evaluation replaces only the
 * matching deferred receipt, replays never write, and a failed condition
 * rolls back every business effect of its transaction.
 */
import { describe, expect, it } from 'vitest';

import type { Operation, OperationResult } from '../../src/types/index.js';
import {
  PushReceiptConditionFailedError,
  SyncOperationReuseError,
  bindSyncPushBatchId,
  createSyncHost,
  type PushPreflightContext,
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

const operation: Operation = {
  opId: 'op-1', replicaId: 'replica-1', sequence: 1, type: 'delete_node', occurredAt: '2026-07-18T00:00:00Z',
  collectionId: 'collection-1', targetId: 'node-1', baseRevision: 'revision-1', payload: {},
};

function request(sessionId: string, options: { atomic?: boolean; reevaluateDeferred?: boolean } = {}) {
  return {
    batchId: bindSyncPushBatchId(sessionId, 'batch'),
    atomic: options.atomic ?? false,
    serverCursor: 'cursor-0',
    ...(options.reevaluateDeferred === undefined ? {} : { reevaluateDeferred: options.reevaluateDeferred }),
    operations: [{ operation, sequenceScope: 'collection-1', digest: 'digest-1' }],
  } as PushTransactionRequest;
}

function preflight(status: 'applied' | 'deferred', seen: Array<PushPreflightContext | undefined> = []) {
  return async (item: PushTransactionOperation, _index: number, context?: PushPreflightContext): Promise<Plan> => {
    seen.push(context);
    const base = { opId: item.operation.opId, sequence: item.operation.sequence, warnings: [] as const };
    if (status === 'deferred') {
      return { status, apply: async () => ({ ...base, status, code: 'dependency_pending' }) } as Plan;
    }
    return {
      status,
      apply: async (transaction) => {
        await transaction.putBusiness(`business-${item.operation.opId}`);
        return { ...base, status, revision: 'r2' };
      },
      audit: async () => ({ id: `audit-${item.operation.opId}` }),
      outbox: async ({ cursor }) => ({ id: `outbox-${item.operation.opId}`, cursor: cursor! }),
    };
  };
}

async function setup() {
  const session = await verifiedSession('session-1', { authorizationScopes: ['sync:pull', 'sync:push'] });
  const db = new LaneSerializedDatabase();
  const host = createSyncHost({ owner: 'push', session, pushOwnershipVerifier: () => true });
  const push = (candidate: PushTransactionRequest, plan: ReturnType<typeof preflight>) =>
    host.push(new LaneSerializedUnitOfWork(db), candidate, plan).then(({ result }) => result);
  return { db, push, sessionId: session.sessionId };
}

function statuses(receipts: readonly { readonly status: OperationResult['status'] }[]) {
  return receipts.map(receipt => receipt.status);
}

describe('Push receipt write conditions', () => {
  it('inserts on first evaluation only when absent', async () => {
    const { db, push, sessionId } = await setup();
    await push(request(sessionId), preflight('applied'));
    expect(db.receiptConditions).toEqual([{ kind: 'absent' }]);
    expect(statuses(db.state.receipts)).toEqual(['applied']);
  });

  it('replaces only the matching deferred receipt when re-evaluation becomes terminal', async () => {
    for (const atomic of [false, true]) {
      const { db, push, sessionId } = await setup();
      await push(request(sessionId), preflight('deferred'));
      const result = await push(request(sessionId, { atomic, reevaluateDeferred: true }), preflight('applied'));
      expect(result.results[0]).toMatchObject({ status: 'applied', cursor: expect.any(String) });
      expect(db.receiptConditions).toEqual([
        { kind: 'absent' },
        { kind: 'replace_deferred', operationId: 'op-1', digest: 'digest-1' },
      ]);
      expect(statuses(db.state.receipts)).toEqual(['applied']);
      expect(db.state.business).toEqual(['business-op-1']);
      expect(db.state.operations).toHaveLength(1);
    }
  });

  it('preserves the original deferred receipt when re-evaluation stays deferred', async () => {
    const { db, push, sessionId } = await setup();
    const first = await push(request(sessionId), preflight('deferred'));
    const before = structuredClone(db.state.receipts);
    const seen: Array<PushPreflightContext | undefined> = [];
    const again = await push(request(sessionId, { reevaluateDeferred: true }), preflight('deferred', seen));
    expect(seen[0]?.previousDeferredReceipt).toMatchObject({ operationId: 'op-1', status: 'deferred' });
    expect(again.results).toEqual(first.results);
    expect(db.receiptConditions).toEqual([{ kind: 'absent' }]);
    expect(db.state.receipts).toEqual(before);
  });

  it('writes nothing when replaying a terminal receipt, even with reevaluateDeferred', async () => {
    const { db, push, sessionId } = await setup();
    const first = await push(request(sessionId), preflight('applied'));
    const replay = await push(request(sessionId, { reevaluateDeferred: true }), preflight('deferred'));
    expect(replay.results).toEqual(first.results);
    expect(db.receiptConditions).toEqual([{ kind: 'absent' }]);
    expect(db.state.business).toEqual(['business-op-1']);
  });

  it('rolls back business effects and reports a retryable failure when the condition no longer holds', async () => {
    const { db, push, sessionId } = await setup();
    await push(request(sessionId), preflight('deferred'));
    // Another writer finalizes the receipt between this transaction's
    // snapshot and its commit; the conditional replace must fail.
    db.beforeCommit = async () => {
      db.state.receipts[0] = { ...db.state.receipts[0]!, status: 'rejected' };
      db.beforeCommit = undefined;
    };
    const failed = push(request(sessionId, { reevaluateDeferred: true }), preflight('applied'));
    await expect(failed).rejects.toBeInstanceOf(PushReceiptConditionFailedError);
    await expect(failed).rejects.not.toBeInstanceOf(SyncOperationReuseError);
    await expect(failed).rejects.toMatchObject({
      retryable: true,
      condition: { kind: 'replace_deferred', operationId: 'op-1', digest: 'digest-1' },
    });
    expect(db.state.business).toEqual([]);
    expect(db.state.operations).toEqual([]);
    expect(db.state.outbox).toEqual([]);
    expect(statuses(db.state.receipts)).toEqual(['rejected']);
  });
});
