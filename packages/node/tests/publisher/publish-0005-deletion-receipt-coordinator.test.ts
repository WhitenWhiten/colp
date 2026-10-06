import { describe, expect, it, vi } from 'vitest';

import {
  createCanonicalRequestDigest,
  executePublisherDelete,
  type IdempotencyBinding,
  type IdempotencyClaim,
  type PublisherDeleteRequest,
  type PublisherDeletionAdapterResult,
  type PublisherDeletionTransaction,
  type PublisherUnitOfWork,
  type StoredPublisherResponse,
} from '../../src/publisher/index.js';

const evidence = 'schema.deletion-receipt';
const deletedAt = '2026-07-19T07:08:09.123Z';
const purgeAfter = '2026-08-18T07:08:09.123Z';

function request(overrides: Partial<PublisherDeleteRequest> = {}): PublisherDeleteRequest {
  return {
    resourceType: 'node',
    targetId: 'node-1',
    collectionId: 'collection-1',
    scope: 'single',
    ...overrides,
  };
}

function resourceIdentity(candidate: PublisherDeleteRequest): string {
  return candidate.resourceType === 'collection'
    ? candidate.collectionId
    : `${candidate.collectionId}/${candidate.targetId}`;
}

function bindingFor(
  candidate: PublisherDeleteRequest,
  overrides: Partial<IdempotencyBinding> = {},
): IdempotencyBinding {
  const endpointKey = candidate.resourceType === 'collection' ? 'collection' : candidate.resourceType;
  return {
    principalId: 'service:publisher-test',
    protocolVersion: '0.1',
    method: 'DELETE',
    endpointKey,
    resourceIdentity: resourceIdentity(candidate),
    key: `delete-${candidate.resourceType}-${candidate.targetId}`,
    requestDigest: createCanonicalRequestDigest({
      principalId: 'service:publisher-test',
      protocolVersion: '0.1',
      method: 'DELETE',
      endpointKey,
      resourceIdentity: resourceIdentity(candidate),
      query: candidate.resourceType === 'node' ? { recursive: candidate.scope === 'subtree' } : {},
      mediaType: 'application/json',
      body: null,
    }),
    ...overrides,
  };
}

function adapterResult(
  candidate: PublisherDeleteRequest,
  overrides: {
    readonly receipt?: Record<string, unknown>;
    readonly watermark?: Record<string, unknown>;
  } = {},
): PublisherDeletionAdapterResult {
  const affectedCount = candidate.scope === 'subtree' ? 3 : 1;
  const receipt = {
    resourceType: candidate.resourceType,
    targetId: candidate.targetId,
    collectionId: candidate.collectionId,
    scope: candidate.scope,
    deletedAt,
    deletedBy: 'service:publisher-test',
    deleteRevision: 'revision-delete-1',
    operationId: 'operation-delete-1',
    affectedCount,
    purgeAfter,
    ...overrides.receipt,
  };
  const watermark = {
    resourceType: candidate.resourceType,
    targetId: candidate.targetId,
    collectionId: candidate.collectionId,
    scope: candidate.scope,
    deletedAt,
    deleteRevision: 'revision-delete-1',
    operationId: 'operation-delete-1',
    affectedCount,
    ...overrides.watermark,
  };
  return { receipt, watermark } as PublisherDeletionAdapterResult;
}

interface State {
  deleted: boolean;
  record?: { requestDigest: string; response: StoredPublisherResponse | null };
}

class TransactionalDeletionAdapter implements PublisherUnitOfWork<PublisherDeletionTransaction> {
  state: State = { deleted: false };
  deleteCalls = 0;
  transactionCalls = 0;
  observedRequest: PublisherDeleteRequest | undefined;
  resultFactory: (candidate: PublisherDeleteRequest) => unknown = adapterResult;

  async execute<Result>(work: (transaction: PublisherDeletionTransaction) => Promise<Result>): Promise<Result> {
    this.transactionCalls += 1;
    const draft = structuredClone(this.state);
    const transaction: PublisherDeletionTransaction = {
      resources: {
        deleteResource: async (candidate) => {
          this.deleteCalls += 1;
          this.observedRequest = candidate;
          draft.deleted = true;
          return this.resultFactory(candidate) as PublisherDeletionAdapterResult;
        },
      },
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      idempotency: {
        claim: async (binding): Promise<IdempotencyClaim> => {
          if (draft.record === undefined) {
            draft.record = { requestDigest: binding.requestDigest, response: null };
            return { state: 'claimed' };
          }
          if (draft.record.requestDigest !== binding.requestDigest) {
            return { state: 'conflict', storedRequestDigest: draft.record.requestDigest };
          }
          return draft.record.response === null
            ? { state: 'in-progress' }
            : { state: 'replay', response: structuredClone(draft.record.response) };
        },
        complete: async (_binding, response) => {
          if (draft.record === undefined || draft.record.response !== null) {
            throw new Error('Deletion idempotency completion is inconsistent.');
          }
          draft.record.response = structuredClone(response);
        },
      },
      operations: { append: async () => undefined },
      audit: { append: async () => undefined },
      outbox: { append: async () => undefined },
    };
    const result = await work(transaction);
    this.state = draft;
    return result;
  }
}

describe(`PUBLISH-0005 deletion coordinator [evidence:${evidence}]`, () => {
  it(`commits a matched receipt and internal watermark as one immutable response [evidence:${evidence}]`, async () => {
    const candidate = request();
    const adapter = new TransactionalDeletionAdapter();

    const result = await executePublisherDelete(adapter, bindingFor(candidate), candidate);

    expect(result).toEqual({
      state: 'committed',
      response: { status: 200, headers: {}, body: { receipt: adapterResult(candidate).receipt } },
    });
    expect(adapter.state.deleted).toBe(true);
    expect(adapter.state.record?.response).toEqual(result.state === 'committed' ? result.response : undefined);
    expect(adapter.observedRequest).toEqual(candidate);
    expect(Object.isFrozen(adapter.observedRequest)).toBe(true);
    if (result.state !== 'committed') throw new Error('Expected a committed deletion.');
    expect(Object.isFrozen(result.response)).toBe(true);
    expect(Object.isFrozen(result.response.body)).toBe(true);
  });

  it(`replays the first response without deleting twice [evidence:${evidence}]`, async () => {
    const candidate = request({ scope: 'subtree' });
    const adapter = new TransactionalDeletionAdapter();
    const binding = bindingFor(candidate);

    await expect(executePublisherDelete(adapter, binding, candidate)).resolves.toMatchObject({ state: 'committed' });
    await expect(executePublisherDelete(adapter, binding, candidate)).resolves.toEqual({
      state: 'replayed',
      response: { status: 200, headers: {}, body: { receipt: adapterResult(candidate).receipt } },
    });
    expect(adapter.deleteCalls).toBe(1);
  });

  it(`rejects a replay whose receipt identity differs from the current request [evidence:${evidence}]`, async () => {
    const candidate = request();
    const binding = bindingFor(candidate);
    const adapter = new TransactionalDeletionAdapter();
    adapter.state.record = {
      requestDigest: binding.requestDigest,
      response: {
        status: 200,
        headers: {},
        body: { receipt: adapterResult(request({ targetId: 'node-other' })).receipt },
      },
    };

    await expect(executePublisherDelete(adapter, binding, candidate)).rejects.toThrow(/does not match/u);
    expect(adapter.deleteCalls).toBe(0);
  });

  it(`returns in-progress without trying to validate a deletion response [evidence:${evidence}]`, async () => {
    const candidate = request();
    const binding = bindingFor(candidate);
    const adapter = new TransactionalDeletionAdapter();
    adapter.state.record = { requestDigest: binding.requestDigest, response: null };

    await expect(executePublisherDelete(adapter, binding, candidate)).resolves.toEqual({ state: 'in-progress' });
    expect(adapter.deleteCalls).toBe(0);
  });

  it.each([
    [
      'resource type',
      {
        receipt: { resourceType: 'annotation' },
        watermark: { resourceType: 'annotation' },
      },
    ],
    [
      'target identity',
      {
        receipt: { targetId: 'node-other' },
        watermark: { targetId: 'node-other' },
      },
    ],
    [
      'collection identity',
      {
        receipt: { collectionId: 'collection-other' },
        watermark: { collectionId: 'collection-other' },
      },
    ],
    [
      'scope',
      {
        receipt: { scope: 'subtree', affectedCount: 3 },
        watermark: { scope: 'subtree', affectedCount: 3 },
      },
    ],
    ['watermark count', { watermark: { affectedCount: 2 } }],
    ['watermark operation', { watermark: { operationId: 'operation-other' } }],
    ['forged Sync cursor', { receipt: { cursor: 'forged-cursor' } }],
    ['unknown watermark member', { watermark: { memberNodeIds: ['node-1'] } }],
    ['purge before deletion', { receipt: { purgeAfter: '2026-07-18T07:08:09.123Z' } }],
    ['invalid affected count', { receipt: { affectedCount: 0 }, watermark: { affectedCount: 0 } }],
  ] as const)(`rolls back deletion and idempotency on mismatched %s [evidence:${evidence}]`, async (_label, overrides) => {
    const candidate = request();
    const adapter = new TransactionalDeletionAdapter();
    adapter.resultFactory = (value) => adapterResult(value, overrides);

    await expect(executePublisherDelete(adapter, bindingFor(candidate), candidate)).rejects.toThrow(TypeError);
    expect(adapter.state).toEqual({ deleted: false });
  });

  it.each([
    ['missing receipt', { watermark: adapterResult(request()).watermark }],
    ['missing watermark', { receipt: adapterResult(request()).receipt }],
  ])(`rolls back an adapter result with %s [evidence:${evidence}]`, async (_label, result) => {
    const candidate = request();
    const adapter = new TransactionalDeletionAdapter();
    adapter.resultFactory = () => result;

    await expect(executePublisherDelete(adapter, bindingFor(candidate), candidate)).rejects.toThrow(TypeError);
    expect(adapter.state).toEqual({ deleted: false });
  });

  it.each([
    ['method', { method: 'POST' }],
    ['endpoint', { endpointKey: 'annotation' }],
    ['resource identity', { resourceIdentity: 'collection-1/node-other' }],
  ] as const)(`rejects a mismatched binding %s before opening a transaction [evidence:${evidence}]`, async (_label, overrides) => {
    const candidate = request();
    const adapter = new TransactionalDeletionAdapter();

    await expect(executePublisherDelete(adapter, bindingFor(candidate, overrides), candidate))
      .rejects.toThrow(/binding does not match/u);
    expect(adapter.transactionCalls).toBe(0);
    expect(adapter.deleteCalls).toBe(0);
  });

  it.each([
    request({ resourceType: 'collection', targetId: 'collection-1', scope: 'single' }),
    request({ resourceType: 'node', scope: 'subtree' }),
    request({ resourceType: 'annotation', targetId: 'annotation-1', scope: 'single' }),
    request({ resourceType: 'attachment', targetId: 'attachment-1', scope: 'single' }),
    request({ resourceType: 'relation', targetId: 'relation-1', scope: 'single' }),
  ])(`binds and commits $resourceType/$scope deletion [evidence:${evidence}]`, async (candidate) => {
    const adapter = new TransactionalDeletionAdapter();
    await expect(executePublisherDelete(adapter, bindingFor(candidate), candidate))
      .resolves.toMatchObject({ state: 'committed' });
  });

  it.each([
    request({ resourceType: 'collection', targetId: 'other-collection' }),
    request({ resourceType: 'annotation', targetId: 'annotation-1', scope: 'subtree' }),
    request({ targetId: 'node/invalid' }),
    { ...request(), futureField: true },
  ])(`rejects an invalid request envelope before adapter access [evidence:${evidence}]`, async (candidate) => {
    const adapter = new TransactionalDeletionAdapter();
    await expect(executePublisherDelete(adapter, bindingFor(request()), candidate as PublisherDeleteRequest))
      .rejects.toThrow(TypeError);
    expect(adapter.transactionCalls).toBe(0);
  });

  it(`snapshots caller input before asynchronous adapter work [evidence:${evidence}]`, async () => {
    const candidate = request() as { -readonly [Key in keyof PublisherDeleteRequest]: PublisherDeleteRequest[Key] };
    const adapter = new TransactionalDeletionAdapter();
    const pending = executePublisherDelete(adapter, bindingFor(candidate), candidate);
    candidate.targetId = 'node-mutated';

    await expect(pending).resolves.toMatchObject({ state: 'committed' });
    expect(adapter.observedRequest?.targetId).toBe('node-1');
  });

  it(`rejects accessor, Proxy, and non-Promise resource adapters without completion [evidence:${evidence}]`, async () => {
    const candidate = request();
    const binding = bindingFor(candidate);
    const complete = vi.fn(async () => undefined);
    const base = {
      idReservations: { reserveAll: async () => ({ state: 'reserved' as const }) },
      idempotency: { claim: async () => ({ state: 'claimed' as const }), complete },
      operations: { append: async () => undefined },
      audit: { append: async () => undefined },
      outbox: { append: async () => undefined },
    };
    const cases = [
      { ...base, get resources() { throw new Error('getter must not execute'); } },
      { ...base, resources: new Proxy({}, {}) },
      { ...base, resources: { deleteResource: () => adapterResult(candidate) } },
    ];

    for (const transaction of cases) {
      const unitOfWork: PublisherUnitOfWork<PublisherDeletionTransaction> = {
        execute: async (work) => work(transaction as never),
      };
      await expect(executePublisherDelete(unitOfWork, binding, candidate)).rejects.toThrow(TypeError);
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it(`rejects a Proxy adapter result without consulting its traps [evidence:${evidence}]`, async () => {
    const candidate = request();
    const adapter = new TransactionalDeletionAdapter();
    const trap = vi.fn(() => { throw new Error('trap must not execute'); });
    adapter.resultFactory = () => new Proxy({}, { getPrototypeOf: trap });

    await expect(executePublisherDelete(adapter, bindingFor(candidate), candidate)).rejects.toThrow(TypeError);
    expect(trap).not.toHaveBeenCalled();
    expect(adapter.state).toEqual({ deleted: false });
  });

  it(`rejects a Proxy binding without consulting its traps [evidence:${evidence}]`, async () => {
    const candidate = request();
    const adapter = new TransactionalDeletionAdapter();
    const trap = vi.fn(() => { throw new Error('binding trap must not execute'); });
    const binding = new Proxy(bindingFor(candidate), { get: trap });

    await expect(executePublisherDelete(adapter, binding, candidate)).rejects.toThrow(TypeError);
    expect(trap).not.toHaveBeenCalled();
    expect(adapter.transactionCalls).toBe(0);
  });
});
