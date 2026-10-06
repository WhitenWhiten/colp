import { describe, expect, it } from 'vitest';
import { coordinatePushTransaction } from '../../src/sync/unsafe.js';
import { DurableContractHandle, request, plan } from './push-transaction-harness.js';

describe('Push response head versus receipt cursor [evidence:sync.batch]', () => {
  it.each([true, false])('keeps the current head on an old replay, atomic=%s', async atomic => {
    const adapter = new DurableContractHandle();
    const committed = await coordinatePushTransaction(adapter, request(false, 2), async (_item, i) => plan('applied', i + 1));
    const replay = await coordinatePushTransaction(adapter, { ...request(atomic, 1), serverCursor: 'opaque-current-head' }, async () => { throw new Error('must replay'); });
    expect(replay.results).toEqual([committed.results[0]]);
    expect(replay.serverCursor).toBe('opaque-current-head');
  });

  it.each([true, false])('does not let an old replay overwrite a newly allocated cursor, atomic=%s', async atomic => {
    const adapter = new DurableContractHandle();
    await coordinatePushTransaction(adapter, request(false, 1), async () => plan('applied', 1));
    const both = request(atomic, 2);
    const mixed = { ...both, serverCursor: 'cursor-1', operations: [both.operations[1]!, both.operations[0]!] as const };
    const result = await coordinatePushTransaction(adapter, mixed, async item => plan('applied', item.operation.sequence));
    expect(result.results.map(item => item.cursor)).toEqual(['cursor-2', 'cursor-1']);
    expect(result.serverCursor).toBe('cursor-2');
  });
});
