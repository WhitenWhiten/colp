import { describe, expect, it } from 'vitest';
import { createTypedUpdateMergePushPreflight } from '../../src/sync/index.js';
import { coordinatePushTransaction } from '../../src/sync/unsafe.js';
import { DurableContractHandle, request, plan, type TestTransaction, type Conflict, type Audit, type Outbox } from './push-transaction-harness.js';

function setup() {
  const adapter = new DurableContractHandle();
  const preflight = createTypedUpdateMergePushPreflight<TestTransaction, Conflict, Audit, Outbox>({
    loadCurrent: async () => JSON.parse(adapter.backend.state.business.at(-1) ?? '{"tags":[]}') as Record<string, unknown>,
    planMerged: async ({ merged, operation }) => ({
      status: 'applied',
      apply: async tx => {
        await tx.putBusiness(JSON.stringify(merged));
        return { opId: operation.opId, sequence: operation.sequence, status: 'applied', revision: 'r1', warnings: [] };
      },
      audit: async () => ({ id: 'audit', result: { status: 'applied' } }),
      outbox: async ({ cursor }) => ({ id: 'outbox', cursor: cursor! }),
    }),
    planConflict: async () => { throw new Error('unexpected conflict'); },
    planOther: async (_item, index) => plan('applied', index + 1),
  });
  const input = request(true, 2);
  input.operations.forEach((item, i) => {
    Object.assign(item.operation, { type: 'update_node_content', targetId: 'node-1', payload: { base: { tags: i === 0 ? [] : ['a'] }, value: { tags: i === 0 ? ['a'] : ['a', 'b'] } } });
  });
  return { adapter, preflight, input };
}

describe('atomic typed update projections [evidence:sync.batch]', () => {
  it.each([
    { atomic: true, sameParent: true },
    { atomic: true, sameParent: false },
    { atomic: false, sameParent: true },
    { atomic: false, sameParent: false },
  ])('creates independent nodes: $atomic atomic, $sameParent same parent', async ({ atomic, sameParent }) => {
    const { adapter, preflight, input } = setup();
    const operations = input.operations.map((item, index) => ({
      ...item,
      operation: {
        opId: item.operation.opId, replicaId: item.operation.replicaId,
        sequence: item.operation.sequence, collectionId: 'collection-1',
        type: 'create_node' as const, baseRevision: null,
        occurredAt: item.operation.occurredAt,
        payload: { parentId: sameParent ? 'parent-1' : `parent-${index}`,
          node: { kind: 'folder' as const, title: `Created ${index}` } },
      },
    }));
    const result = await coordinatePushTransaction(adapter, {
      ...input, atomic, operations: [operations[0]!, operations[1]!],
    }, preflight);
    expect(result.results.map(value => value.status)).toEqual(['applied', 'applied']);
    expect(adapter.backend.state.business).toEqual(['business-1', 'business-2']);
    expect(adapter.backend.state.receipts).toHaveLength(2);
    expect(adapter.backend.state.outbox).toHaveLength(2);
  });

  it('keeps new operation IDs separate from existing resource target IDs', async () => {
    const { adapter, preflight, input } = setup();
    const first = input.operations[0]!;
    const create = { ...first, operation: {
      opId: first.operation.opId, replicaId: first.operation.replicaId, sequence: 1,
      collectionId: 'collection-1', type: 'create_node' as const, baseRevision: null,
      occurredAt: first.operation.occurredAt,
      payload: { parentId: 'parent-1', node: { kind: 'folder' as const, title: 'Created' } },
    } };
    const update = { ...input.operations[1]!, operation: { ...input.operations[1]!.operation,
      targetId: first.operation.opId, type: 'update_node_content' as const, baseRevision: 'r1',
      collectionId: 'collection-1', payload: { base: { tags: [] }, value: { tags: ['b'] } },
    } };
    const result = await coordinatePushTransaction(adapter, { ...input, operations: [create, update] }, preflight);
    expect(result.results.map(value => value.status)).toEqual(['applied', 'applied']);
    expect(adapter.backend.state.business).toEqual(['business-1', JSON.stringify({ tags: ['b'] })]);
  });

  it.each([true, false])('preserves ordered same-target additions, atomic=%s', async atomic => {
    const { adapter, preflight, input } = setup();
    const result = await coordinatePushTransaction(adapter, { ...input, atomic }, preflight);
    expect(result.results.map(value => value.status)).toEqual(['applied', 'applied']);
    expect(JSON.parse(adapter.backend.state.business.at(-1)!)).toEqual({ tags: ['a', 'b'] });
  });

  it('merges independent additions based on the same revision', async () => {
    const { adapter, preflight, input } = setup();
    Object.assign(input.operations[1]!.operation, { payload: { base: { tags: [] }, value: { tags: ['b'] } } });
    await coordinatePushTransaction(adapter, input, preflight);
    expect(JSON.parse(adapter.backend.state.business.at(-1)!)).toEqual({ tags: ['a', 'b'] });
  });

  it('honors an observed removal in a later update', async () => {
    const { adapter, preflight, input } = setup();
    Object.assign(input.operations[1]!.operation, { payload: { base: { tags: ['a'] }, value: { tags: ['b'] } } });
    await coordinatePushTransaction(adapter, input, preflight);
    expect(JSON.parse(adapter.backend.state.business.at(-1)!)).toEqual({ tags: ['b'] });
  });

  it('does not reuse projected state after rollback', async () => {
    const { adapter, preflight, input } = setup();
    adapter.failure = 'outbox';
    await expect(coordinatePushTransaction(adapter, input, preflight)).rejects.toThrow();
    expect(adapter.backend.state.business).toEqual([]);
    adapter.failure = undefined;
    Object.assign(input.operations[0]!.operation, { payload: { base: { tags: [] }, value: { tags: ['c'] } } });
    Object.assign(input.operations[1]!.operation, { payload: { base: { tags: ['c'] }, value: { tags: ['c', 'd'] } } });
    await coordinatePushTransaction(adapter, input, preflight);
    expect(JSON.parse(adapter.backend.state.business.at(-1)!)).toEqual({ tags: ['c', 'd'] });
  });

  it('isolates different targets within one batch', async () => {
    const { adapter, preflight, input } = setup();
    Object.assign(input.operations[1]!.operation, { targetId: 'node-2' });
    Object.assign(input.operations[1]!.operation, { payload: { base: { tags: [] }, value: { tags: ['b'] } } });
    await coordinatePushTransaction(adapter, input, preflight);
    expect(adapter.backend.state.business.map(value => JSON.parse(value))).toEqual([{ tags: ['a'] }, { tags: ['b'] }]);
  });

  it.each([0, 1])('rejects unprojectable mixed same-target changes before apply (index %s)', async index => {
    const { adapter, preflight, input } = setup();
    Object.assign(input.operations[index]!.operation, { type: 'delete_node', payload: {} });
    await expect(coordinatePushTransaction(adapter, input, preflight)).rejects.toThrow('host-provided projected preflight');
    expect(adapter.backend.state.business).toEqual([]);
    expect(adapter.backend.state.receipts).toEqual([]);
  });
});
