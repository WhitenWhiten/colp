import { describe, expect, it } from 'vitest';

import {
  createCanonicalRequestDigest,
  executePublisherCollectionCreate,
  executeIdempotentPublisherCreation,
  executeIdempotentPublisherWrite,
  type IdempotencyBinding,
  type IdempotencyClaim,
  type OutboxEvent,
  type PublisherTransaction,
  type PublisherUnitOfWork,
  type StoredPublisherResponse,
} from '../../src/publisher/index.js';
import type { CollectionCreateResult } from '../../src/types/generated.js';
import type { AuditEvent, Operation } from '../../src/types/index.js';

type FailurePoint = 'claim' | 'resources' | 'operations' | 'audit' | 'outbox' | 'idempotency-result';

interface TestResourceStore {
  put(id: string, value: unknown): Promise<void>;
  createCollectionAndRoot(request: any): Promise<CollectionCreateResult>;
}

interface IdempotencyRecord {
  readonly requestDigest: string;
  response: StoredPublisherResponse | null;
}

interface TestState {
  readonly reservedIds: Map<string, string>;
  readonly resources: Map<string, unknown>;
  readonly idempotency: Map<string, IdempotencyRecord>;
  readonly operations: Operation[];
  readonly audit: AuditEvent[];
  readonly outbox: OutboxEvent[];
}

type TestTransaction = PublisherTransaction<TestResourceStore>;

function emptyState(): TestState {
  return {
    reservedIds: new Map(),
    resources: new Map(),
    idempotency: new Map(),
    operations: [],
    audit: [],
    outbox: [],
  };
}

function cloneResponse(response: StoredPublisherResponse): StoredPublisherResponse {
  return {
    status: response.status,
    headers: { ...response.headers },
    body: structuredClone(response.body),
  };
}

function cloneState(state: TestState): TestState {
  return {
    reservedIds: new Map(state.reservedIds),
    resources: new Map([...state.resources].map(([key, value]) => [key, structuredClone(value)])),
    idempotency: new Map(
      [...state.idempotency].map(([key, record]) => [
        key,
        {
          requestDigest: record.requestDigest,
          response: record.response === null ? null : cloneResponse(record.response),
        },
      ]),
    ),
    operations: [...state.operations],
    audit: [...state.audit],
    outbox: state.outbox.map((event) => ({ ...event })),
  };
}

function bindingIdentity(binding: IdempotencyBinding): string {
  return JSON.stringify([
    binding.principalId,
    binding.protocolVersion,
    binding.method,
    binding.endpointKey,
    binding.resourceIdentity,
    binding.key,
  ]);
}

class TransactionalMemoryPublisherAdapter implements PublisherUnitOfWork<TestTransaction> {
  private state = emptyState();
  private transactionQueue: Promise<void> = Promise.resolve();

  failurePoint: FailurePoint | null = null;
  rootCollectionOverride: string | null = null;

  snapshot(): TestState {
    return cloneState(this.state);
  }

  execute<Result>(work: (transaction: TestTransaction) => Promise<Result>): Promise<Result> {
    const run = async (): Promise<Result> => {
      const draft = cloneState(this.state);
      const result = await work(this.createTransaction(draft));
      this.state = draft;
      return result;
    };
    const result = this.transactionQueue.then(run, run);
    this.transactionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private createTransaction(draft: TestState): TestTransaction {
    return {
      idReservations: {
        reserveAll: async (reservations) => {
          const conflict = reservations.find(({ id }) => draft.reservedIds.has(id));
          if (conflict !== undefined) {
            return {
              state: 'conflict',
              conflict: {
                requested: conflict,
                existing: {
                  id: conflict.id,
                  resourceType: draft.reservedIds.get(conflict.id) as typeof conflict.resourceType,
                },
              },
            };
          }
          reservations.forEach(({ id, resourceType }) => draft.reservedIds.set(id, resourceType));
          return { state: 'reserved' };
        },
      },
      resources: {
        put: async (id, value) => {
          draft.resources.set(id, structuredClone(value));
          this.failAt('resources');
        },
        createCollectionAndRoot: async (request) => {
          if (request.collectionId === request.rootNodeId) throw new Error('collection/root IDs must differ');
          if (request.root.folderRole !== 'root') throw new Error('root kind must be root');
          const createdAt = '2026-07-19T08:00:00Z';
          const collection = {
            ...request.collection,
            schemaVersion: '0.1',
            id: request.collectionId,
            rootNodeId: request.rootNodeId,
            createdAt,
            updatedAt: createdAt,
            revision: 'revision-1',
          } as any;
          const root = {
            ...request.root,
            id: request.rootNodeId,
            collectionId: this.rootCollectionOverride ?? request.collectionId,
            kind: 'root',
            parentId: null,
            position: null,
            createdAt,
            updatedAt: createdAt,
            revision: 'revision-1',
          } as any;
          const result = {
            collection,
            root,
            links: {
              self: `https://publisher.example/collections/c/${request.collectionId}`,
              canonical: `https://publisher.example/collections/${request.collectionId}`,
              snapshot: `https://publisher.example/collections/c/${request.collectionId}/snapshot`,
            },
          } as CollectionCreateResult;
          draft.resources.set(request.collectionId, collection);
          draft.resources.set(request.rootNodeId, root);
          this.failAt('resources');
          return result;
        },
      },
      idempotency: {
        claim: async (binding): Promise<IdempotencyClaim> => {
          const identity = bindingIdentity(binding);
          const existing = draft.idempotency.get(identity);
          if (existing === undefined) {
            draft.idempotency.set(identity, { requestDigest: binding.requestDigest, response: null });
            this.failAt('claim');
            return { state: 'claimed' };
          }
          if (existing.requestDigest !== binding.requestDigest) {
            return { state: 'conflict', storedRequestDigest: existing.requestDigest };
          }
          if (existing.response === null) {
            return { state: 'in-progress' };
          }
          return { state: 'replay', response: cloneResponse(existing.response) };
        },
        complete: async (binding, response) => {
          const existing = draft.idempotency.get(bindingIdentity(binding));
          if (existing === undefined || existing.requestDigest !== binding.requestDigest || existing.response !== null) {
            throw new Error('Idempotency result cannot be completed for this claim.');
          }
          existing.response = cloneResponse(response);
          this.failAt('idempotency-result');
        },
      },
      operations: {
        append: async (operation) => {
          draft.operations.push(operation);
          this.failAt('operations');
        },
      },
      audit: {
        append: async (event) => {
          draft.audit.push(event);
          this.failAt('audit');
        },
      },
      outbox: {
        append: async (event) => {
          draft.outbox.push({ ...event });
          this.failAt('outbox');
        },
      },
    };
  }

  private failAt(point: FailurePoint): void {
    if (this.failurePoint === point) {
      throw new Error(`Injected failure at ${point}.`);
    }
  }
}

const binding: IdempotencyBinding = {
  principalId: 'publisher-key:alice',
  protocolVersion: '0.1',
  method: 'POST',
  endpointKey: 'nodes',
  resourceIdentity: 'collection-1',
  key: '019f-unit-of-work-contract',
  requestDigest: createCanonicalRequestDigest({
    principalId: 'publisher-key:alice',
    protocolVersion: '0.1', endpointKey: 'nodes', resourceIdentity: 'collection-1', method: 'POST',
    query: {}, mediaType: 'application/json', body: { node: { id: 'node-1', revision: 'revision-2' } },
  }),
};

const response: StoredPublisherResponse = {
  status: 201,
  headers: {
    'Cache-Control': 'no-store',
    ETag: '"revision-2"',
    Location: '/collections/c/collection-1/nodes/node-1',
  },
  body: { node: { id: 'node-1', revision: 'revision-2' } },
};

const operation: Operation = {
  opId: 'operation-1',
  replicaId: 'server',
  sequence: 1,
  collectionId: 'collection-1',
  type: 'create_node',
  occurredAt: '2026-07-16T10:00:00Z',
  baseRevision: null,
  payload: {
    parentId: 'root-1',
    node: { kind: 'bookmark', title: 'Contract test', url: 'https://example.com/' },
  },
};

const auditEvent: AuditEvent = {
  id: 'audit-1',
  time: '2026-07-16T10:00:00Z',
  actor: { principalId: 'publisher-key:alice' },
  action: 'node.create',
  target: 'node-1',
  result: 'success',
  risk: 'low',
};

async function writeCompleteMutation(transaction: TestTransaction): Promise<StoredPublisherResponse> {
  await transaction.resources.put('node-1', { id: 'node-1', revision: 'revision-2' });
  await transaction.operations.append(operation);
  await transaction.audit.append(auditEvent);
  await transaction.outbox.append({ id: 'outbox-1', topic: 'node.changed', payload: 'node-1' });
  return response;
}

function expectEmptyState(state: TestState): void {
  expect(state.resources.size).toBe(0);
  expect(state.idempotency.size).toBe(0);
  expect(state.operations).toEqual([]);
  expect(state.audit).toEqual([]);
  expect(state.outbox).toEqual([]);
}

describe('PublisherUnitOfWork contract', () => {
  it.each<FailurePoint>(['claim', 'resources', 'operations', 'audit', 'outbox', 'idempotency-result'])(
    'rolls back every store after an injected %s failure [evidence:publisher.idempotency]',
    async (failurePoint) => {
      const adapter = new TransactionalMemoryPublisherAdapter();
      adapter.failurePoint = failurePoint;

      await expect(executeIdempotentPublisherWrite(adapter, binding, writeCompleteMutation)).rejects.toThrow(
        `Injected failure at ${failurePoint}.`,
      );
      expectEmptyState(adapter.snapshot());

      adapter.failurePoint = null;
      await expect(executeIdempotentPublisherWrite(adapter, binding, writeCompleteMutation)).resolves.toEqual({
        state: 'committed',
        response,
      });
      const committed = adapter.snapshot();
      expect(committed.resources.size).toBe(1);
      expect(committed.idempotency.size).toBe(1);
      expect(committed.operations.map((item) => item.opId)).toEqual(['operation-1']);
      expect(committed.audit.map((item) => item.id)).toEqual(['audit-1']);
      expect(committed.outbox).toEqual([{ id: 'outbox-1', topic: 'node.changed', payload: 'node-1' }]);
    },
  );

  it('replays the first complete status, headers, and body without executing the mutation twice [evidence:publisher.idempotency]', async () => {
    const adapter = new TransactionalMemoryPublisherAdapter();
    let executions = 0;
    const write = async (transaction: TestTransaction): Promise<StoredPublisherResponse> => {
      executions += 1;
      return writeCompleteMutation(transaction);
    };

    await expect(executeIdempotentPublisherWrite(adapter, binding, write)).resolves.toEqual({
      state: 'committed',
      response,
    });
    await expect(executeIdempotentPublisherWrite(adapter, binding, write)).resolves.toEqual({
      state: 'replayed',
      response,
    });
    expect(executions).toBe(1);
    expect(adapter.snapshot().operations.map((item) => item.opId)).toEqual(['operation-1']);
  });

  it('rejects the same unique binding with a different request digest as idempotency_key_reused 409 [evidence:publisher.idempotency]', async () => {
    const adapter = new TransactionalMemoryPublisherAdapter();
    await executeIdempotentPublisherWrite(adapter, binding, writeCompleteMutation);

    const reusedBinding = {
      ...binding,
      requestDigest: createCanonicalRequestDigest({
        principalId: 'publisher-key:alice',
        protocolVersion: '0.1', endpointKey: 'nodes', resourceIdentity: 'collection-1', method: 'POST',
        query: {}, mediaType: 'application/json', body: { node: { id: 'node-1', revision: 'other' } },
      }),
    };
    await expect(executeIdempotentPublisherWrite(adapter, reusedBinding, writeCompleteMutation)).resolves.toEqual({
      state: 'conflict',
      storedRequestDigest: binding.requestDigest,
    });
    expect(adapter.snapshot().operations.map((item) => item.opId)).toEqual(['operation-1']);
  });

  it('relies on the adapter transaction to serialize concurrent claims [evidence:publisher.idempotency]', async () => {
    const adapter = new TransactionalMemoryPublisherAdapter();
    let executions = 0;
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = executeIdempotentPublisherWrite(adapter, binding, async (transaction) => {
      executions += 1;
      markStarted();
      await firstCanFinish;
      return writeCompleteMutation(transaction);
    });
    await firstStarted;
    const concurrent = executeIdempotentPublisherWrite(adapter, binding, async (transaction) => {
      executions += 1;
      return writeCompleteMutation(transaction);
    });
    releaseFirst();

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { state: 'committed', response },
      { state: 'replayed', response },
    ]);
    expect(executions).toBe(1);
    expect(adapter.snapshot().operations.map((item) => item.opId)).toEqual(['operation-1']);
  });

  it('isolates idempotency claims when any non-digest binding component changes [evidence:publisher.idempotency]', async () => {
    const dimensions: readonly (keyof IdempotencyBinding)[] = [
      'principalId', 'protocolVersion', 'method', 'endpointKey', 'resourceIdentity',
    ];
    for (const dimension of dimensions) {
      const adapter = new TransactionalMemoryPublisherAdapter();
      await expect(executeIdempotentPublisherWrite(adapter, binding, writeCompleteMutation)).resolves.toMatchObject({ state: 'committed' });
      const changed = {
        ...binding,
        [dimension]: dimension === 'method' ? 'PUT' : `${String(binding[dimension])}-other`,
      } as IdempotencyBinding;
      await expect(executeIdempotentPublisherWrite(adapter, changed, writeCompleteMutation)).resolves.toMatchObject({ state: 'committed' });
      expect(adapter.snapshot().operations).toHaveLength(2);
    }
  });

  it('uses RFC8785 canonical JSON for query and body and normalizes method/media type [evidence:publisher.idempotency]', () => {
    const base = {
      protocolVersion: '0.1', endpointKey: 'nodes', resourceIdentity: 'collection-1',
      method: 'post', query: { z: 1, a: ['x', 'y'] }, mediaType: 'Application/JSON; charset=utf-8',
      body: { beta: 2, alpha: 1 },
    } as const;
    const reordered = { ...base, query: { a: ['x', 'y'], z: 1 }, body: { alpha: 1, beta: 2 }, method: 'POST', mediaType: 'application/json;charset=utf-8' };
    expect(createCanonicalRequestDigest(base)).toBe(createCanonicalRequestDigest(reordered));
    expect(createCanonicalRequestDigest(base)).not.toBe(createCanonicalRequestDigest({ ...base, query: { ...base.query, z: 2 } }));
    expect(createCanonicalRequestDigest(base)).not.toBe(createCanonicalRequestDigest({ ...base, body: { ...base.body, alpha: 9 } }));
    expect(createCanonicalRequestDigest(base)).not.toBe(createCanonicalRequestDigest({ ...base, mediaType: 'application/cbor' }));
  });

  it('fails closed when transaction commit outcome is unknown and does not report success [evidence:publisher.idempotency]', async () => {
    const unitOfWork: PublisherUnitOfWork<TestTransaction> = {
      execute: async () => { throw new Error('commit outcome unknown'); },
    };
    await expect(executeIdempotentPublisherWrite(unitOfWork, binding, writeCompleteMutation)).rejects.toThrow('commit outcome unknown');
  });

  it('fails closed for an unknown adapter claim state [evidence:publisher.idempotency]', async () => {
    const transaction = {
      resources: { put: async () => undefined },
      idReservations: { reserveAll: async () => ({ state: 'reserved' as const }) },
      idempotency: {
        claim: async () => ({ state: 'future-state' } as never),
        complete: async () => undefined,
      },
      operations: { append: async () => undefined },
      audit: { append: async () => undefined },
      outbox: { append: async () => undefined },
    } as unknown as TestTransaction;
    const unitOfWork: PublisherUnitOfWork<TestTransaction> = { execute: async (work) => work(transaction) };
    await expect(executeIdempotentPublisherWrite(unitOfWork, binding, writeCompleteMutation)).rejects.toThrow(
      'unknown claim state',
    );
  });

  it('fails closed when a replay contains an invalid stored response [evidence:publisher.idempotency]', async () => {
    const transaction = {
      resources: { put: async () => undefined },
      idReservations: { reserveAll: async () => ({ state: 'reserved' as const }) },
      idempotency: {
        claim: async () => ({ state: 'replay', response: { status: 99, headers: {}, body: {} } }),
        complete: async () => undefined,
      },
      operations: { append: async () => undefined },
      audit: { append: async () => undefined },
      outbox: { append: async () => undefined },
    } as unknown as TestTransaction;
    const unitOfWork: PublisherUnitOfWork<TestTransaction> = { execute: async (work) => work(transaction) };
    await expect(executeIdempotentPublisherWrite(unitOfWork, binding, writeCompleteMutation)).rejects.toThrow(
      'response status is invalid',
    );
  });
});

describe('Publisher idempotency input guards', () => {
  it('rejects non-JSON bodies instead of creating an ambiguous digest [evidence:publisher.idempotency]', () => {
    expect(() => createCanonicalRequestDigest({
      protocolVersion: '0.1', endpointKey: 'nodes', resourceIdentity: 'collection-1', method: 'POST',
      query: {}, mediaType: 'application/json', body: undefined,
    })).toThrow(/I-JSON/);
  });

  it('rejects a digest that is not a complete SHA-256 base64url value [evidence:publisher.idempotency]', async () => {
    const unitOfWork: PublisherUnitOfWork<TestTransaction> = { execute: async () => { throw new Error('must not execute'); } };
    await expect(executeIdempotentPublisherWrite(unitOfWork, { ...binding, requestDigest: 'sha-256:fake' }, writeCompleteMutation))
      .rejects.toThrow(/canonical SHA-256 digest/u);
  });
});

/* PUBLISH-0003 evidence exercises the production collection-create coordinator. */
describe('PUBLISH-0003 atomic collection and root creation', () => {
  const creationBinding: IdempotencyBinding = {
    ...binding,
    endpointKey: 'collection-create',
    resourceIdentity: 'instance-publish-0003',
    key: '019f-publish-0003-create',
    requestDigest: createCanonicalRequestDigest({
      principalId: binding.principalId,
      protocolVersion: binding.protocolVersion,
      endpointKey: 'collection-create',
      resourceIdentity: 'instance-publish-0003',
      method: 'POST',
      query: {},
      mediaType: 'application/json',
      body: {
        collection: { kind: 'mixed', title: 'PUBLISH-0003', visibility: 'private' },
        root: { title: 'Root', folderRole: 'root' },
      },
    }),
  };

  const request = {
    collectionId: 'collection-publish-0003', rootNodeId: 'root-publish-0003',
    collection: { kind: 'mixed', title: 'PUBLISH-0003', visibility: 'private' },
    root: { title: 'Root', folderRole: 'root' },
  } as any;
  const responseBody = (state: TestState) => ({ collection: state.resources.get(request.collectionId), root: state.resources.get(request.rootNodeId), links: {} });
  const create = (adapter: TransactionalMemoryPublisherAdapter, b = creationBinding, r = request) => executePublisherCollectionCreate(adapter as any, b, r);

  it('commits collection and root plus both reservations in one transaction [evidence:publisher.collection-create]', async () => {
    const adapter = new TransactionalMemoryPublisherAdapter();
    const outcome = await create(adapter);
    expect(outcome).toMatchObject({ state: 'committed', response: { status: 201 } });
    if (outcome.state === 'committed') {
      expect((outcome.response.body as any).collection.id).toBe('collection-publish-0003');
      expect((outcome.response.body as any).collection.rootNodeId).toBe('root-publish-0003');
      expect((outcome.response.body as any).root.collectionId).toBe('collection-publish-0003');
    }
    const state = adapter.snapshot();
    expect([...state.reservedIds]).toEqual([['collection-publish-0003', 'collection'], ['root-publish-0003', 'node']]);
    expect(state.resources.size).toBe(2);
  });

  it('rolls back collection, root, reservations, and idempotency claim when either resource write fails [evidence:publisher.collection-create]', async () => {
    const adapter = new TransactionalMemoryPublisherAdapter();
    adapter.failurePoint = 'resources';
    await expect(create(adapter)).rejects.toThrow('Injected failure at resources.');
    const state = adapter.snapshot();
    expect(state.resources.size).toBe(0);
    expect(state.reservedIds.size).toBe(0);
    expect(state.idempotency.size).toBe(0);
  });

  it('rejects a collection or root reservation conflict without writing either resource [evidence:publisher.collection-create]', async () => {
    const adapter = new TransactionalMemoryPublisherAdapter();
    await create(adapter);
    const conflictBinding = { ...creationBinding, key: `${creationBinding.key}-conflict` };
    await expect(create(adapter, conflictBinding)).rejects.toThrow(/already reserved/u);
  });

  it('rejects a unique root/server ID reservation conflict independently of collection ID [evidence:publisher.collection-create]', async () => {
    const adapter = new TransactionalMemoryPublisherAdapter();
    await create(adapter);
    const changedRequest = { ...request, collectionId: 'collection-publish-0003-2' };
    const rootConflictBinding = {
      ...creationBinding,
      resourceIdentity: creationBinding.resourceIdentity,
      key: `${creationBinding.key}-root-conflict`,
      requestDigest: createCanonicalRequestDigest({
        principalId: binding.principalId,
        protocolVersion: binding.protocolVersion,
        endpointKey: 'collection-create',
        resourceIdentity: creationBinding.resourceIdentity,
        method: 'POST',
        query: {},
        mediaType: 'application/json',
        body: { collection: changedRequest.collection, root: changedRequest.root },
      }),
    };
    await expect(create(adapter, rootConflictBinding, changedRequest)).rejects.toThrow(/already reserved/u);
  });

  it('rejects invalid root kind before any reservation', async () => {
    const adapter = new TransactionalMemoryPublisherAdapter();
    await expect(create(adapter, creationBinding, { ...request, root: { title: 'Root', folderRole: 'child' } })).rejects.toThrow(/folderRole root/);
    expect(adapter.snapshot().reservedIds.size).toBe(0);
  });

  it('rejects a cross-collection root returned by the resource adapter', async () => {
    const adapter = new TransactionalMemoryPublisherAdapter();
    adapter.rootCollectionOverride = 'other-collection';
    await expect(create(adapter)).rejects.toThrow(/identity invariants/);
    expect(adapter.snapshot().resources.size).toBe(0);
    expect(adapter.snapshot().reservedIds.size).toBe(0);
  });

  it('fails closed when commit outcome is unknown [evidence:publisher.collection-create]', async () => {
    const unitOfWork: PublisherUnitOfWork<any> = { execute: async () => { throw new Error('commit outcome unknown'); } };
    await expect(executePublisherCollectionCreate(unitOfWork, creationBinding, request)).rejects.toThrow('commit outcome unknown');
  });
});
