import { describe, expect, it, vi } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import type { Operation, OperationResult } from '../../src/types/index.js';
import {
  AtomicPushNotCommittableError,
  type PushPreparedOperation,
  type PushTransactionRequest,
  type SyncUnitOfWork,
} from '../../src/sync/index.js';
import {
  coordinatePushTransaction,
  coordinatePushTransaction as syncCoordinatePushTransaction,
} from '../../src/sync/unsafe.js';
import {
  DurableContractHandle,
  SharedDurableBackend,
  emptyState,
  evidence,
  operation,
  plan,
  request,
  type Audit,
  type Conflict,
  type Outbox,
  type TestTransaction,
} from './push-transaction-harness.js';

describe(`SYNC-0004 Push batch transaction contract ${evidence}`, () => {
  it(`runs every pure atomic preflight inside one UnitOfWork and rolls back on failure ${evidence} [evidence:sync.operation-id-lifetime]`, async () => {
    const adapter = new DurableContractHandle();
    const preflight = vi.fn(async (_item, index: number) => {
      adapter.trace.push(`preflight:${index}`);
      if (index === 1) throw new Error('preflight denied');
      return plan('applied', index + 1);
    });

    await expect(coordinatePushTransaction(adapter, request(true), preflight)).rejects.toThrow('preflight denied');
    expect(adapter.executeCount).toBe(1);
    expect(adapter.backend.state).toEqual(emptyState());
    expect(adapter.trace).toEqual(['tx:1:begin', 'preflight:0', 'preflight:1', 'tx:1:reject']);
  });

  it(`commits an atomic multi-operation batch in one transaction and input order ${evidence}`, async () => {
    const adapter = new DurableContractHandle();
    const result = await coordinatePushTransaction(adapter, request(true), async (_item, index) => plan('applied', index + 1));

    expect(adapter.executeCount).toBe(1);
    expect(result.results.map((item) => item.opId)).toEqual(['operation-1', 'operation-2']);
    expect(adapter.backend.state.business).toEqual(['business-1', 'business-2']);
    expect(adapter.backend.state.operations.map((item) => item.opId)).toEqual(['operation-1', 'operation-2']);
    expect(adapter.backend.state.receipts.map((item) => item.operationId)).toEqual(['operation-1', 'operation-2']);
    expect(adapter.backend.state.conflicts).toEqual([]);
    expect(adapter.backend.state.cursors).toEqual(['cursor-1', 'cursor-2']);
    expect(adapter.backend.state.audits.map((item) => item.id)).toEqual(['audit-1', 'audit-2']);
    expect(adapter.backend.state.outbox.map((item) => item.id)).toEqual(['outbox-1', 'outbox-2']);
    expect(adapter.trace.filter((entry) => entry.includes(':business:'))).toEqual([
      'tx:1:business:business-1', 'tx:1:business:business-2',
    ]);
    expect(result.serverCursor).toBe('cursor-2');
  });

  it(`preserves canonical JSON-safe decimals through preflight, Operation, receipt, and result ${evidence}`, async () => {
    const adapter = new DurableContractHandle();
    const decimalOperation: Operation = {
      opId: 'operation-1',
      replicaId: 'replica-1',
      sequence: 1,
      type: 'update_annotation',
      occurredAt: '2026-07-18T00:00:00Z',
      collectionId: 'collection-1',
      targetId: 'annotation-1',
      baseRevision: 'revision-1',
      payload: {
        base: { value: 1.5, extensions: { 'https://example.com/score': 2.25 } },
        value: { value: 2.25, extensions: { 'https://example.com/score': 1.5 } },
      },
    };
    const candidate: PushTransactionRequest = {
      ...request(true, 1),
      operations: [{
        operation: decimalOperation,
        sequenceScope: 'collection-1',
        digest: 'digest-1',
      }],
    };
    expect(createValidatorRegistry().validate('operation', decimalOperation)).toEqual({ valid: true, errors: [] });

    const result = await coordinatePushTransaction(adapter, candidate, async (item) => {
      expect(item.operation.payload).toEqual(decimalOperation.payload);
      const prepared = plan('rebased', 1);
      return {
        ...prepared,
        apply: async (transaction: TestTransaction) => {
          await transaction.putBusiness('business-1');
          return {
            opId: 'operation-1', sequence: 1, status: 'rebased', warnings: [],
            revision: 'revision-rebased-1', transform: { before: 1.5, after: 2.25 },
          };
        },
      } as PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>;
    });

    expect(adapter.backend.state.operations[0]!.payload).toEqual(decimalOperation.payload);
    expect(adapter.backend.state.receipts[0]!.result).toMatchObject({
      transform: { before: 1.5, after: 2.25 },
    });
    expect(result.results[0]).toMatchObject({ transform: { before: 1.5, after: 2.25 } });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    `rejects a non-JSON-safe number before preflight (%s) ${evidence}`,
    async (invalidNumber) => {
      const adapter = new DurableContractHandle();
      const candidate = request(true, 1);
      (candidate.operations[0]!.operation.payload as Record<string, unknown>).value = invalidNumber;
      const preflight = vi.fn(async () => plan('applied', 1));
      await expect(coordinatePushTransaction(adapter, candidate, preflight))
        .rejects.toThrow(/JSON-safe number|safe integer|non-finite|number/i);
      expect(preflight).not.toHaveBeenCalled();
      expect(adapter.executeCount).toBe(0);
    },
  );

  it(`commits non-atomic items in separate sequential transactions ${evidence}`, async () => {
    const adapter = new DurableContractHandle();
    await coordinatePushTransaction(adapter, request(false, 3), async (_item, index) => plan('applied', index + 1));

    expect(adapter.executeCount).toBe(3);
    expect(adapter.trace.filter((entry) => entry.endsWith(':commit'))).toEqual([
      'tx:1:commit', 'tx:2:commit', 'tx:3:commit',
    ]);
    expect(adapter.backend.state.operations.map((item) => item.opId)).toEqual([
      'operation-1', 'operation-2', 'operation-3',
    ]);
  });

  it.each(['business', 'operation', 'receipt', 'conflict', 'cursor', 'audit', 'outbox'] as const)(
    `rolls back business, Operation, receipt, Conflict, Cursor, Audit, and Outbox after a %s write failure ${evidence}`,
    async (point) => {
      const adapter = new DurableContractHandle();
      if (point !== 'business') adapter.failure = point;
      const status = point === 'conflict' ? 'conflicted' : 'applied';
      await expect(coordinatePushTransaction(
        adapter,
        request(true, 1),
        async () => plan(status, 1, { businessFailure: point === 'business' }),
      )).rejects.toThrow(`injected ${point} failure`);
      expect(adapter.backend.state).toEqual(emptyState());
    },
  );

  it(`rejects an atomic deferred batch inside one UnitOfWork and rolls back every item ${evidence} [evidence:sync.operation-id-lifetime]`, async () => {
    const adapter = new DurableContractHandle();
    const pending = coordinatePushTransaction(adapter, request(true), async (_item, index) => (
      index === 0 ? plan('applied', 1) : plan('deferred', 2)
    ));
    await expect(pending).rejects.toBeInstanceOf(AtomicPushNotCommittableError);
    expect(adapter.executeCount).toBe(1);
    expect(adapter.backend.state).toEqual(emptyState());
  });

  it(`persists a non-atomic deferred result in the minimal transaction ${evidence}`, async () => {
    const adapter = new DurableContractHandle();
    const result = await coordinatePushTransaction(adapter, request(false, 1), async () => plan('deferred', 1));

    expect(result.results[0]).toMatchObject({ status: 'deferred', code: 'dependency_pending' });
    expect(adapter.backend.state).toMatchObject({
      business: [], operations: [], conflicts: [], cursors: [], audits: [], outbox: [],
    });
    expect(adapter.backend.state.receipts).toHaveLength(1);
  });

  it.each([
    ['applied', true, false], ['rebased', true, false], ['conflicted', true, true],
    ['noop', false, false], ['rejected', false, false], ['deferred', false, false],
  ] as const)(`enforces the %s Cursor and Conflict persistence matrix ${evidence}`, async (status, hasCursor, hasConflict) => {
    const adapter = new DurableContractHandle();
    const result = await coordinatePushTransaction(adapter, request(false, 1), async () => plan(status, 1));
    expect('cursor' in result.results[0]!).toBe(hasCursor);
    expect(adapter.backend.state.cursors).toHaveLength(hasCursor ? 1 : 0);
    expect(adapter.backend.state.conflicts).toHaveLength(hasConflict ? 1 : 0);
    expect(adapter.backend.state.business).toHaveLength(status === 'applied' || status === 'rebased' ? 1 : 0);
    expect(adapter.backend.state.operations).toHaveLength(status === 'deferred' ? 0 : 1);
    expect(adapter.backend.state.receipts).toHaveLength(1);
    expect(adapter.backend.state.audits).toHaveLength(status === 'deferred' ? 0 : 1);
    expect(adapter.backend.state.outbox).toHaveLength(hasCursor ? 1 : 0);
    if (status === 'conflicted') {
      expect(result.results[0]).toMatchObject({ conflictId: adapter.backend.state.conflicts[0]!.id });
    }
  });

  it(`persists a receipt whose result matches every returned field and allocated Cursor ${evidence}`, async () => {
    const adapter = new DurableContractHandle();
    const returned = await coordinatePushTransaction(adapter, request(true, 1), async () => plan('rebased', 1));
    const receipt = adapter.backend.state.receipts[0]!;
    expect(receipt).toMatchObject({
      operationId: 'operation-1', replicaId: 'replica-1', sequenceScope: 'collection-1',
      sequence: 1, digest: 'digest-1', status: 'rebased', result: returned.results[0],
    });
    expect(receipt.result).toEqual(returned.results[0]);
    expect(returned.serverCursor).toBe(receipt.result.cursor);
  });

  it(`rejects commit-unknown without reporting success and leaves the durable receipt for retry recovery ${evidence}`, async () => {
    const backend = new SharedDurableBackend();
    const adapter = new DurableContractHandle(backend);
    adapter.rejectAfterCommitOnce = true;
    await expect(coordinatePushTransaction(adapter, request(true, 1), async () => plan('applied', 1)))
      .rejects.toThrow('commit outcome unknown');
    expect(backend.state.receipts).toHaveLength(1);
    expect(backend.state.receipts[0]!.result).toMatchObject({ status: 'applied', cursor: 'cursor-1' });
  });

  it.each(['not-called', 'twice', 'forged'] as const)(
    `rejects a UnitOfWork whose callback is %s ${evidence}`,
    async (behavior) => {
      const base = new DurableContractHandle();
      const malicious: SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, TestTransaction> = {
        operationIdReservationOwner: 'push',
        execute: async <Value>(work: (transaction: TestTransaction) => Promise<Value>): Promise<Value> => {
          if (behavior === 'not-called') return [] as unknown as Value;
          let first: Value | undefined;
          await base.execute(async (transaction) => {
            first = await work(transaction);
            if (behavior === 'twice') await work(transaction);
            return first;
          });
          return behavior === 'forged' ? structuredClone(first) as Value : first!;
        },
      };
      await expect(coordinatePushTransaction(malicious, request(true, 1), async () => plan('applied', 1)))
        .rejects.toThrow(/callback exactly once|forged transaction callback result/);
    },
  );

  it(`rejects an adapter that acknowledges receipt save without staging either receipt index ${evidence}`, async () => {
    const base = new DurableContractHandle();
    const adapter: SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, TestTransaction> = {
      operationIdReservationOwner: 'push',
      execute: (work) => base.execute((transaction) => work({
        ...transaction,
        receipts: { ...transaction.receipts, save: async () => undefined },
      })),
    };
    await expect(coordinatePushTransaction(adapter, request(true, 1), async () => plan('applied', 1)))
      .rejects.toThrow('not durably staged under both receipt indexes');
    expect(base.backend.state).toEqual(emptyState());
  });


  it.each([
    'unit-of-work', 'apply', 'cursor', 'operation', 'receipt', 'conflict',
    'audit-builder', 'audit', 'outbox-builder', 'outbox',
  ] as const)(
    `rejects a synchronous %s boundary ${evidence}`,
    async (point) => {
      const base = new DurableContractHandle();
      if (point === 'unit-of-work') {
        await expect(coordinatePushTransaction(
          { operationIdReservationOwner: 'push', execute: (() => undefined) as never },
          request(true, 1), async () => plan('conflicted', 1),
        )).rejects.toThrow('must return a Promise');
        return;
      }
      const adapter: SyncUnitOfWork<Operation, OperationResult, Conflict, Audit, Outbox, TestTransaction> = {
        operationIdReservationOwner: 'push',
        execute: (work) => base.execute((transaction) => work({
          ...transaction,
          allocateCursor: point === 'cursor' ? (() => 'cursor-x') as never : transaction.allocateCursor,
          appendOperation: point === 'operation' ? (() => undefined) as never : transaction.appendOperation,
          receipts: point === 'receipt'
            ? { ...transaction.receipts, save: (() => undefined) as never }
            : transaction.receipts,
          saveConflict: point === 'conflict' ? (() => undefined) as never : transaction.saveConflict,
          appendAudit: point === 'audit' ? (() => undefined) as never : transaction.appendAudit,
          appendOutbox: point === 'outbox' ? (() => undefined) as never : transaction.appendOutbox,
        })),
      };
      const prepared = plan('conflicted', 1);
      const maliciousPlan = point === 'apply'
        ? { ...prepared, apply: (() => ({})) as never }
        : point === 'audit-builder'
          ? { ...prepared, audit: (() => ({})) as never }
          : point === 'outbox-builder'
            ? { ...prepared, outbox: (() => ({})) as never }
            : prepared;
      await expect(coordinatePushTransaction(
        adapter,
        request(true, 1),
        async () => maliciousPlan as PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>,
      ))
        .rejects.toThrow('must return a Promise');
      expect(base.backend.state).toEqual(emptyState());
    },
  );

  it(`shares one durable contract backend across independent handles ${evidence}`, async () => {
    const backend = new SharedDurableBackend();
    await coordinatePushTransaction(new DurableContractHandle(backend), request(false, 1), async () => plan('applied', 1));
    expect(new DurableContractHandle(backend).backend.state.receipts[0]).toMatchObject({ operationId: 'operation-1' });
  });

  it(`detaches input, returned values, commit contexts, and persisted state against mutation ${evidence}`, async () => {
    const adapter = new DurableContractHandle();
    const candidate = request(true, 1);
    let capturedContext: unknown;
    const output = await coordinatePushTransaction(adapter, candidate, async (item) => {
      (item.operation as unknown as { targetId: string }).targetId = 'preflight-mutated';
      const prepared = plan('rebased', 1, { nested: 'original' });
      return {
        ...prepared,
        audit: async (context) => {
          capturedContext = context;
          return { id: 'audit-1', result: { status: context.result.status } };
        },
      } as PushPreparedOperation<TestTransaction, Conflict, Audit, Outbox>;
    });
    (candidate.operations[0].operation as unknown as { targetId: string }).targetId = 'caller-mutated';
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.results)).toBe(true);
    expect(Object.isFrozen(capturedContext)).toBe(true);
    expect(() => ((output.results[0] as unknown as { status: string }).status = 'rejected')).toThrow();
    expect(adapter.backend.state.operations[0]!.targetId).toBe('node-1');
    expect(adapter.backend.state.receipts[0]!.result).toMatchObject({ transform: { nested: 'original' } });
  });

  it(`exports the coordinator from the explicit unsafe Sync entry ${evidence}`, () => {
    expect(coordinatePushTransaction).toBe(syncCoordinatePushTransaction);
  });

  it.each([
    null,
    [],
    { ...request(true), atomic: 'yes' },
    { ...request(true), operations: [] },
    { ...request(true), operations: [{ operation: null, sequenceScope: 'scope', digest: 'digest' }] },
    { ...request(true), operations: [{ operation: operation(1), sequenceScope: '', digest: 'digest' }] },
  ])(`rejects malformed Push request boundary %j ${evidence}`, async (candidate) => {
    const adapter = new DurableContractHandle();
    await expect(coordinatePushTransaction(
      adapter,
      candidate as never,
      async () => plan('applied', 1),
    )).rejects.toThrow();
    expect(adapter.executeCount).toBe(0);
  });

  it(`rejects a malformed preflight result and invalid canonical operation before opening a transaction ${evidence}`, async () => {
    const adapter = new DurableContractHandle();
    await expect(coordinatePushTransaction(
      adapter,
      request(true, 1),
      async () => null as never,
    )).rejects.toThrow();
    expect(adapter.executeCount).toBe(1);

    const invalidOperation = request(true, 1);
    (invalidOperation.operations[0]!.operation as unknown as { type: string }).type = 'not-an-operation';
    const invalidAdapter = new DurableContractHandle();
    await expect(coordinatePushTransaction(
      invalidAdapter,
      invalidOperation,
      async () => plan('applied', 1),
    )).rejects.toThrow(/canonical payload|operation/i);
    expect(invalidAdapter.executeCount).toBe(0);
  });

  it.each([
    ['mismatched status', { status: 'applied', apply: async () => ({ opId: 'operation-1', sequence: 1, status: 'rebased', warnings: [], revision: 'revision-1' }) }],
    ['missing audit', { status: 'applied', apply: async () => ({ opId: 'operation-1', sequence: 1, status: 'applied', warnings: [], revision: 'revision-1' }) }],
  ] as const)(`rejects an invalid prepared operation: %s ${evidence}`, async (_label, prepared) => {
    const adapter = new DurableContractHandle();
    await expect(coordinatePushTransaction(
      adapter,
      request(true, 1),
      async () => prepared as never,
    )).rejects.toThrow();
    expect(adapter.backend.state).toEqual(emptyState());
  });
});