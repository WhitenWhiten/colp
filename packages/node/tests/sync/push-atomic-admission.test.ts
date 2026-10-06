import { describe, expect, it, vi } from 'vitest';
import { AtomicPushNotCommittableError } from '../../src/sync/index.js';
import { coordinatePushTransaction } from '../../src/sync/unsafe.js';
import { DurableContractHandle, emptyState, plan, request } from './push-transaction-harness.js';

describe('atomic Push admission [evidence:sync.batch]', () => {
  it.each(['deferred', 'rejected'] as const)('rejects a stored %s without consuming another operation', async status => {
    const adapter = new DurableContractHandle();
    await coordinatePushTransaction(adapter, request(false, 1), async () => plan(status, 1));
    const before = structuredClone(adapter.backend.state);
    const preflight = vi.fn(async (_item: unknown, index: number) => plan('applied', index + 1));
    await expect(coordinatePushTransaction(adapter, request(true, 2), preflight)).rejects.toBeInstanceOf(AtomicPushNotCommittableError);
    expect(adapter.backend.state).toEqual(before);
    expect(preflight).not.toHaveBeenCalled();
  });

  it.each(['deferred', 'rejected'] as const)('rolls back all claims and never applies plans when a new item is %s', async status => {
    const adapter = new DurableContractHandle();
    await expect(coordinatePushTransaction(adapter, request(true, 2), async (_item, index) => plan(index === 1 ? status : 'applied', index + 1))).rejects.toBeInstanceOf(AtomicPushNotCommittableError);
    expect(adapter.backend.state).toEqual(emptyState());
    expect(adapter.trace.some(value => value.includes(':business:'))).toBe(false);
  });

  it.each(['noop', 'conflicted'] as const)('still commits a valid %s outcome and a later write', async status => {
    const adapter = new DurableContractHandle();
    const result = await coordinatePushTransaction(adapter, request(true, 2), async (_item, index) => plan(index === 0 ? status : 'applied', index + 1));
    expect(result.results.map(item => item.status)).toEqual([status, 'applied']);
    expect(adapter.backend.state.receipts).toHaveLength(2);
    expect(adapter.backend.state.business).toEqual(['business-2']);
  });

  it('preserves non-atomic rejected receipts and later independent commits', async () => {
    const adapter = new DurableContractHandle();
    const result = await coordinatePushTransaction(adapter, request(false, 2), async (_item, index) => plan(index === 0 ? 'rejected' : 'applied', index + 1));
    expect(result.results.map(item => item.status)).toEqual(['rejected', 'applied']);
    expect(adapter.backend.state.receipts).toHaveLength(2);
    expect(adapter.backend.state.business).toEqual(['business-2']);
  });
});
