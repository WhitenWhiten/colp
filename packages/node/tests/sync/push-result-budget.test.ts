import { describe, expect, it } from 'vitest';

import { type PushPreparedOperation } from '../../src/sync/index.js';
import { coordinatePushTransaction } from '../../src/sync/unsafe.js';
import {
  DurableContractHandle,
  request,
  type Audit,
  type Conflict,
  type Outbox,
  type TestTransaction,
} from './push-transaction-harness.js';

describe('committed batch response budgets', () => {
  it.each([[true, 'wide'], [false, 'wide'], [true, 'deep'], [false, 'deep']] as const)(
    'returns and replays individually valid results (atomic=%s, shape=%s)', async (atomic, shape) => {
    const adapter = new DurableContractHandle();
    const req = request(atomic, 20);
    const preflight = async (_item: unknown, index: number): Promise<PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>> => ({
      status: 'rebased',
      apply: async (tx) => {
        await tx.putBusiness(`business-${index}`);
        return {
          opId: `operation-${index + 1}`, sequence: index + 1, status: 'rebased',
          warnings: [], revision: 'revision-2',
          transform: shape === 'wide'
            ? Object.fromEntries(Array.from({ length: 600 }, (_, key) => [`k${key}`, key]))
            : Array.from({ length: 60 }).reduce<Record<string, unknown>>((value) => ({ nested: value }), { leaf: 1 }),
        };
      },
      audit: async () => ({ id: `audit-${index}`, result: { status: 'rebased' } }),
      outbox: async ({ cursor }) => ({ id: `outbox-${index}`, cursor: cursor! }),
    });
    const result = await coordinatePushTransaction(adapter, req, preflight);
    expect(result.results).toHaveLength(20);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.results)).toBe(true);
    expect(Object.isFrozen(result.results[0])).toBe(true);
    expect(await coordinatePushTransaction(adapter, { ...req, serverCursor: result.serverCursor }, preflight)).toEqual(result);
    expect(adapter.backend.state.business).toHaveLength(20);
    expect(adapter.backend.state.receipts).toHaveLength(20);
  });
});
