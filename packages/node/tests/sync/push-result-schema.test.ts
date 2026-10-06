import { describe, expect, it } from 'vitest';

import type { OperationResult } from '../../src/types/index.js';
import { type PushPreparedOperation } from '../../src/sync/index.js';
import { coordinatePushTransaction } from '../../src/sync/unsafe.js';
import {
  DurableContractHandle,
  emptyState,
  evidence,
  plan,
  request,
  type Audit,
  type Conflict,
  type Outbox,
  type TestTransaction,
} from './push-transaction-harness.js';

  it.each([
    ['applied', { conflictId: 'conflict-1' }],
    ['applied', { warnings: [{}] }],
    ['applied', { transform: 42 }],
    ['applied', { boundCollection: {} }],
    ['applied', { targetId: 'invalid\nidentifier' }],
    ['applied', { cursor: 'forged-cursor' }],
    ['rebased', { boundCollection: { collectionId: 'collection-1', revision: 'revision-1', cursor: 'cursor-1' } }],
    ['noop', { cursor: 'forged-cursor' }],
    ['conflicted', { revision: 'forged-revision' }],
    ['rejected', { retryAfterSeconds: 1 }],
    ['deferred', { conflictId: 'conflict-1' }],
  ] as const)(`rejects fields forbidden for a %s result ${evidence}`, async (status, forbidden) => {
    const adapter = new DurableContractHandle();
    const prepared = plan(status, 1);
    const invalid = {
      ...prepared,
      apply: async (transaction: TestTransaction, cursor: string | undefined) => {
        const apply = prepared.apply as (
          transaction: TestTransaction,
          cursor: string | undefined,
        ) => Promise<unknown>;
        const raw = await apply(transaction, cursor);
        if (status === 'conflicted') {
          const pair = raw as { readonly result: OperationResult; readonly conflict: Conflict };
          return { ...pair, result: { ...pair.result, ...forbidden } };
        }
        return { ...(raw as object), ...forbidden };
      },
    } as PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>;
    await expect(coordinatePushTransaction(adapter, request(false, 1), async () => invalid))
      .rejects.toThrow(/invalid members/);
    expect(adapter.backend.state).toEqual(emptyState());
  });

describe('canonical Push result boundary', () => {
  it.each(['applied', 'rebased', 'noop', 'conflicted', 'rejected', 'deferred'] as const)(
    'rejects invalid warning members for %s before commit', async (status) => {
      const adapter = new DurableContractHandle();
      const prepared = plan(status, 1);
      const invalid = {
        ...prepared,
        apply: async (transaction: TestTransaction, cursor: string | undefined) => {
          const raw = await (prepared.apply as (tx: TestTransaction, cursor: string | undefined) => Promise<unknown>)(transaction, cursor);
          if (status === 'conflicted') {
            const pair = raw as { result: OperationResult; conflict: Conflict };
            return { ...pair, result: { ...pair.result, warnings: [42] } };
          }
          return { ...(raw as object), warnings: [42] };
        },
      } as PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>;
      await expect(coordinatePushTransaction(adapter, request(false, 1), async () => invalid))
        .rejects.toThrow('invalid members');
      expect(adapter.backend.state).toEqual(emptyState());
    },
  );

  it('rejects a historical receipt with invalid nested protocol data', async () => {
    const adapter = new DurableContractHandle();
    await coordinatePushTransaction(adapter, request(true, 1), async () => plan('applied', 1));
    const receipt = adapter.backend.state.receipts[0]!;
    adapter.backend.state.receipts[0] = { ...receipt, result: { ...receipt.result, warnings: [42] } as unknown as OperationResult };
    await expect(coordinatePushTransaction(adapter, request(true, 1), async () => plan('applied', 1)))
      .rejects.toThrow('inconsistent with its stored Operation result');
    expect(adapter.backend.state.business).toHaveLength(1);
  });
});