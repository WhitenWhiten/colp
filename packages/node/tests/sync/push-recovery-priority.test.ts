import { describe, expect, it, vi } from 'vitest';

import {
  SyncOperationReceiptUnavailableError,
  type PushTransactionRequest,
} from '../../src/sync/index.js';
import { coordinatePushTransaction } from '../../src/sync/unsafe.js';
import { DurableContractHandle, plan, request } from './push-transaction-harness.js';

function reuseAcrossGap(atomic: boolean): PushTransactionRequest {
  const initial = request(atomic, 1);
  const item = initial.operations[0]!;
  const operation = item.operation;
  if (operation.type !== 'delete_node') throw new Error('Expected delete_node fixture.');
  return {
    ...initial,
    operations: [{
      ...item, operation: { ...operation, sequence: 3 }, digest: 'changed-digest',
    }],
  };
}

describe('Push reuse and recovery precede new Sequence admission [evidence:sync.sequence]', () => {
  it.each([false, true])('audits opId reuse across a Sequence gap (atomic=%s)', async (atomic) => {
    const adapter = new DurableContractHandle();
    await coordinatePushTransaction(adapter, request(false, 1), async () => plan('applied', 1));
    const preflight = vi.fn(async () => { throw new Error('reuse must not execute'); });
    await expect(coordinatePushTransaction(adapter, reuseAcrossGap(atomic), preflight))
      .rejects.toMatchObject({ code: 'op_id_reused', status: 409 });
    expect([...adapter.backend.state.reuseAudits.values()]).toMatchObject([{
      code: 'op_id_reused',
      attempted: { operationId: 'operation-1', sequence: 3, digest: 'changed-digest' },
      stored: { operationId: 'operation-1', sequence: 1, digest: 'digest-1' },
    }]);
    expect(preflight).not.toHaveBeenCalled();
    expect(adapter.backend.state.business).toEqual(['business-1']);
    expect(adapter.backend.state.receipts).toHaveLength(1);
  });

  it.each([false, true])('keeps reuse auditing after receipt retention (atomic=%s)', async (atomic) => {
    const adapter = new DurableContractHandle();
    await coordinatePushTransaction(adapter, request(false, 1), async () => plan('applied', 1));
    adapter.backend.state.receipts.splice(0);
    const preflight = vi.fn(async () => { throw new Error('retained identity must not execute'); });
    await expect(coordinatePushTransaction(adapter, reuseAcrossGap(atomic), preflight))
      .rejects.toMatchObject({ code: 'op_id_reused', status: 409 });
    expect(adapter.backend.state.reuseAudits.size).toBe(1);
    expect(adapter.backend.state.operationClaims.get('operation-1')).toMatchObject({ digest: 'digest-1' });
    expect(adapter.backend.state.receipts).toEqual([]);
    expect(preflight).not.toHaveBeenCalled();
  });

  it.each([false, true])('routes a consumed retry with a purged receipt to recovery (atomic=%s)', async (atomic) => {
    const adapter = new DurableContractHandle();
    await coordinatePushTransaction(adapter, request(false, 1), async () => plan('applied', 1));
    adapter.backend.state.receipts.splice(0);
    const preflight = vi.fn(async () => { throw new Error('consumed operation must not rerun'); });
    const error = await coordinatePushTransaction(adapter, request(atomic, 1), preflight)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SyncOperationReceiptUnavailableError);
    expect(error).toMatchObject({
      code: 'receipt_unavailable',
      claim: { operationId: 'operation-1', replicaId: 'replica-1', sequence: 1, digest: 'digest-1' },
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(adapter.backend.state.business).toEqual(['business-1']);
    expect(adapter.backend.state.receipts).toEqual([]);
    expect(adapter.backend.state.operationClaims.size).toBe(1);
  });
});
