import { describe, expect, it } from 'vitest';

import {
  createCanonicalRequestDigest,
  executePublisherCollectionCreate,
  type IdempotencyBinding,
  type IdempotencyClaim,
  type PublisherCollectionCreateRequest,
  type PublisherCollectionCreateTransaction,
  type PublisherUnitOfWork,
  type ServerIdResourceType,
  type StoredPublisherResponse,
} from '../../src/publisher/index.js';
import type { CollectionCreateResult } from '../../src/types/generated.js';

const instant = '2026-07-19T08:00:00Z';

interface StoredIdempotencyClaim {
  readonly requestDigest: string;
  response: StoredPublisherResponse | null;
}

interface DatabaseState {
  readonly reservations: Map<string, ServerIdResourceType>;
  readonly collections: Map<string, CollectionCreateResult['collection']>;
  readonly roots: Map<string, CollectionCreateResult['root']>;
  readonly idempotency: Map<string, StoredIdempotencyClaim>;
}

interface VisibilityObservation {
  readonly phase: 'before-resource-write' | 'collection-staged' | 'root-staged';
  readonly committedCollections: number;
  readonly committedRoots: number;
}

type ResourceFailure = 'after-collection-staged' | 'after-root-staged';
type CommitOutcome = 'known' | 'unknown-before-commit' | 'unknown-after-commit';

function emptyDatabase(): DatabaseState {
  return {
    reservations: new Map(),
    collections: new Map(),
    roots: new Map(),
    idempotency: new Map(),
  };
}

function cloneResponse(response: StoredPublisherResponse): StoredPublisherResponse {
  return {
    status: response.status,
    headers: { ...response.headers },
    body: structuredClone(response.body),
  };
}

function cloneDatabase(state: DatabaseState): DatabaseState {
  return {
    reservations: new Map(state.reservations),
    collections: new Map(
      [...state.collections].map(([id, collection]) => [id, structuredClone(collection)]),
    ),
    roots: new Map([...state.roots].map(([id, root]) => [id, structuredClone(root)])),
    idempotency: new Map(
      [...state.idempotency].map(([identity, claim]) => [
        identity,
        {
          requestDigest: claim.requestDigest,
          response: claim.response === null ? null : cloneResponse(claim.response),
        },
      ]),
    ),
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

function completeResult(request: PublisherCollectionCreateRequest): CollectionCreateResult {
  return {
    collection: {
      schemaVersion: '0.1',
      id: request.collectionId,
      kind: request.collection.kind,
      title: request.collection.title,
      rootNodeId: request.rootNodeId,
      visibility: request.collection.visibility,
      createdAt: instant,
      updatedAt: instant,
      revision: 'revision-1',
      extensions: {},
    },
    root: {
      id: request.rootNodeId,
      collectionId: request.collectionId,
      kind: 'root',
      parentId: null,
      position: null,
      folderRole: 'root',
      title: request.root.title,
      createdAt: instant,
      updatedAt: instant,
      revision: 'revision-1',
      extensions: {},
    },
    links: {
      self: `https://publisher.example/collections/c/${request.collectionId}`,
      canonical: `https://publisher.example/collections/${request.collectionId}`,
      snapshot: `https://publisher.example/collections/c/${request.collectionId}/snapshot`,
      nodes: `https://publisher.example/collections/c/${request.collectionId}/nodes`,
    },
  } as CollectionCreateResult;
}

/**
 * A database-shaped adapter: every callback sees a private draft, reserveAll has
 * one global uniqueness key, and only execute() can publish the draft. Diagnostic
 * observations deliberately read committed state, never the transaction draft.
 */
class AtomicMemoryPublisherAdapter
implements PublisherUnitOfWork<PublisherCollectionCreateTransaction> {
  private state = emptyDatabase();
  private transactionTail: Promise<void> = Promise.resolve();

  readonly visibility: VisibilityObservation[] = [];
  executeCalls = 0;
  reservationCalls = 0;
  resourceCreateCalls = 0;
  resourceFailure: ResourceFailure | null = null;
  commitOutcome: CommitOutcome = 'known';
  mapResult: (result: CollectionCreateResult) => unknown = (result) => result;
  mapReplayResponse: (response: StoredPublisherResponse) => unknown = (response) => response;

  snapshot(): DatabaseState {
    return cloneDatabase(this.state);
  }

  seedReservation(id: string, resourceType: ServerIdResourceType): void {
    this.state.reservations.set(id, resourceType);
  }

  execute<Result>(
    work: (transaction: PublisherCollectionCreateTransaction) => Promise<Result>,
  ): Promise<Result> {
    const run = async (): Promise<Result> => {
      this.executeCalls += 1;
      const draft = cloneDatabase(this.state);
      const result = await work(this.transaction(draft));
      if (this.commitOutcome === 'unknown-before-commit') {
        throw new Error('commit outcome unknown');
      }
      this.state = draft;
      if (this.commitOutcome === 'unknown-after-commit') {
        throw new Error('commit outcome unknown');
      }
      return result;
    };

    const result = this.transactionTail.then(run, run);
    this.transactionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private observe(phase: VisibilityObservation['phase']): void {
    this.visibility.push({
      phase,
      committedCollections: this.state.collections.size,
      committedRoots: this.state.roots.size,
    });
  }

  private transaction(draft: DatabaseState): PublisherCollectionCreateTransaction {
    return {
      idReservations: {
        reserveAll: async (reservations) => {
          this.reservationCalls += 1;
          const conflict = reservations.find(({ id }) => draft.reservations.has(id));
          if (conflict !== undefined) {
            return {
              state: 'conflict',
              conflict: {
                requested: conflict,
                existing: {
                  id: conflict.id,
                  resourceType: draft.reservations.get(conflict.id) as ServerIdResourceType,
                },
              },
            };
          }
          for (const reservation of reservations) {
            draft.reservations.set(reservation.id, reservation.resourceType);
          }
          return { state: 'reserved' };
        },
      },
      resources: {
        createCollectionAndRoot: async (request) => {
          this.resourceCreateCalls += 1;
          this.observe('before-resource-write');
          const valid = completeResult(request);

          draft.collections.set(request.collectionId, structuredClone(valid.collection));
          this.observe('collection-staged');
          if (this.resourceFailure === 'after-collection-staged') {
            throw new Error('injected failure after Collection was staged');
          }

          draft.roots.set(request.rootNodeId, structuredClone(valid.root));
          this.observe('root-staged');
          if (this.resourceFailure === 'after-root-staged') {
            throw new Error('injected failure after Root was staged');
          }

          return this.mapResult(structuredClone(valid)) as CollectionCreateResult;
        },
      },
      idempotency: {
        claim: async (binding): Promise<IdempotencyClaim> => {
          const identity = bindingIdentity(binding);
          const stored = draft.idempotency.get(identity);
          if (stored === undefined) {
            draft.idempotency.set(identity, {
              requestDigest: binding.requestDigest,
              response: null,
            });
            return { state: 'claimed' };
          }
          if (stored.requestDigest !== binding.requestDigest) {
            return { state: 'conflict', storedRequestDigest: stored.requestDigest };
          }
          if (stored.response === null) return { state: 'in-progress' };
          return {
            state: 'replay',
            response: this.mapReplayResponse(cloneResponse(stored.response)) as StoredPublisherResponse,
          };
        },
        complete: async (binding, response) => {
          const stored = draft.idempotency.get(bindingIdentity(binding));
          if (stored === undefined || stored.response !== null) {
            throw new Error('idempotency claim completion is invalid');
          }
          stored.response = cloneResponse(response);
        },
      },
      operations: { append: async () => undefined },
      audit: { append: async () => undefined },
      outbox: { append: async () => undefined },
    };
  }
}

const request: PublisherCollectionCreateRequest = {
  collectionId: 'collection-publish-0012',
  rootNodeId: 'root-publish-0012',
  collection: {
    kind: 'knowledge_collection',
    title: 'Atomic Collections',
    visibility: 'private',
    extensions: {},
  },
  root: {
    title: 'Atomic Collections',
    folderRole: 'root',
    extensions: {},
  },
};

const creationScope = 'mount:publisher/collections';

function bindingFor(
  candidate: PublisherCollectionCreateRequest = request,
  key = '019f-publish-0012-create',
): IdempotencyBinding {
  return {
    principalId: 'publisher-key:alice',
    protocolVersion: '0.1',
    method: 'POST',
    endpointKey: 'collection-create',
    resourceIdentity: creationScope,
    key,
    requestDigest: createCanonicalRequestDigest({
      principalId: 'publisher-key:alice',
      protocolVersion: '0.1',
      endpointKey: 'collection-create',
      resourceIdentity: creationScope,
      method: 'POST',
      query: {},
      mediaType: 'application/json',
      body: { collection: candidate.collection, root: candidate.root },
    }),
  };
}

function expectNoOrphan(state: DatabaseState): void {
  for (const collection of state.collections.values()) {
    const root = state.roots.get(collection.rootNodeId);
    expect(root?.collectionId).toBe(collection.id);
    expect(root?.kind).toBe('root');
    expect(root?.parentId).toBeNull();
  }
  for (const root of state.roots.values()) {
    expect(state.collections.get(root.collectionId)?.rootNodeId).toBe(root.id);
  }
  expect(state.collections.size).toBe(state.roots.size);
}

function create(
  adapter: AtomicMemoryPublisherAdapter,
  candidate: PublisherCollectionCreateRequest = request,
  binding: IdempotencyBinding = bindingFor(candidate),
) {
  return executePublisherCollectionCreate(adapter, binding, candidate);
}

describe('PUBLISH-0012 Collection + unique Root atomic contract', () => {
  it('commits a complete, mutually linked Collection and Root with both lifetime reservations [evidence:publisher.collection-root-atomic]', async () => {
    const adapter = new AtomicMemoryPublisherAdapter();

    const result = await create(adapter);

    expect(result).toMatchObject({
      state: 'committed',
      response: {
        status: 201,
        body: {
          collection: {
            id: request.collectionId,
            rootNodeId: request.rootNodeId,
            revision: 'revision-1',
          },
          root: {
            id: request.rootNodeId,
            collectionId: request.collectionId,
            kind: 'root',
            parentId: null,
            revision: 'revision-1',
          },
          links: {
            self: expect.any(String),
            canonical: expect.any(String),
            snapshot: expect.any(String),
          },
        },
      },
    });
    const state = adapter.snapshot();
    expect([...state.reservations]).toEqual([
      [request.collectionId, 'collection'],
      [request.rootNodeId, 'node'],
    ]);
    expect(state.idempotency.size).toBe(1);
    expectNoOrphan(state);
  });

  it('never exposes a staged Collection or Root before the single UnitOfWork commits [evidence:publisher.collection-root-atomic]', async () => {
    const adapter = new AtomicMemoryPublisherAdapter();

    await create(adapter);

    expect(adapter.visibility).toEqual([
      { phase: 'before-resource-write', committedCollections: 0, committedRoots: 0 },
      { phase: 'collection-staged', committedCollections: 0, committedRoots: 0 },
      { phase: 'root-staged', committedCollections: 0, committedRoots: 0 },
    ]);
    expect(adapter.executeCalls).toBe(1);
    expectNoOrphan(adapter.snapshot());
  });

  it('rolls back either partial staging failure, both reservations, and the idempotency claim [evidence:publisher.collection-root-atomic]', async () => {
    for (const failure of ['after-collection-staged', 'after-root-staged'] as const) {
      const adapter = new AtomicMemoryPublisherAdapter();
      adapter.resourceFailure = failure;

      await expect(create(adapter)).rejects.toThrow('injected failure');
      expect(adapter.snapshot()).toEqual(emptyDatabase());

      adapter.resourceFailure = null;
      await expect(create(adapter)).resolves.toMatchObject({ state: 'committed' });
      expectNoOrphan(adapter.snapshot());
    }
  });

  it('rejects malformed create inputs without leaving durable state [evidence:publisher.collection-root-atomic]', async () => {
    const invalidRequests: readonly unknown[] = [
      null,
      { ...request, rootNodeId: request.collectionId },
      { ...request, collectionId: 'not a wire id' },
      { ...request, collection: { ...request.collection, kind: 'future-kind' } },
      { ...request, collection: { kind: 'knowledge_collection', visibility: 'private' } },
      { ...request, root: { ...request.root, folderRole: 'child' } },
    ];

    for (const invalid of invalidRequests) {
      const adapter = new AtomicMemoryPublisherAdapter();
      await expect(executePublisherCollectionCreate(
        adapter,
        bindingFor(),
        invalid as PublisherCollectionCreateRequest,
      )).rejects.toThrow();
      expect(adapter.snapshot()).toEqual(emptyDatabase());
    }
  });

  it('rejects partial, malformed, or identity-inconsistent adapter results and rolls back [evidence:publisher.collection-root-atomic]', async () => {
    const corruptions: readonly ((valid: CollectionCreateResult) => unknown)[] = [
      ({ collection, root }) => ({ collection, root }),
      (valid) => ({ ...valid, links: {} }),
      (valid) => ({ ...valid, collection: { ...valid.collection, revision: undefined } }),
      (valid) => ({ ...valid, collection: { ...valid.collection, rootNodeId: 'other-root' } }),
      (valid) => ({ ...valid, root: { ...valid.root, collectionId: 'other-collection' } }),
      (valid) => ({ ...valid, root: { ...valid.root, kind: 'folder', parentId: request.rootNodeId } }),
    ];

    for (const corrupt of corruptions) {
      const adapter = new AtomicMemoryPublisherAdapter();
      adapter.mapResult = corrupt;
      await expect(create(adapter)).rejects.toThrow();
      expect(adapter.snapshot()).toEqual(emptyDatabase());
    }
  });

  it('rejects a malformed idempotent replay instead of trusting adapter-owned stored data [evidence:publisher.collection-root-atomic]', async () => {
    const adapter = new AtomicMemoryPublisherAdapter();
    await create(adapter);
    adapter.mapReplayResponse = (response) => ({
      ...response,
      body: {
        ...(response.body as CollectionCreateResult),
        root: {
          ...(response.body as CollectionCreateResult).root,
          collectionId: 'other-collection',
        },
      },
    });

    await expect(create(adapter)).rejects.toThrow('identity invariants');
    expectNoOrphan(adapter.snapshot());
    expect(adapter.resourceCreateCalls).toBe(1);
  });

  it('snapshots request and idempotency inputs before asynchronous adapter work [evidence:publisher.collection-root-atomic]', async () => {
    const adapter = new AtomicMemoryPublisherAdapter();
    const mutableRequest = structuredClone(request) as {
      -readonly [Key in keyof PublisherCollectionCreateRequest]: PublisherCollectionCreateRequest[Key];
    };
    const mutableBinding = { ...bindingFor(mutableRequest) };

    const pending = create(adapter, mutableRequest, mutableBinding);
    mutableRequest.collectionId = 'collection-mutated';
    mutableRequest.rootNodeId = 'root-mutated';
    (mutableRequest.collection as { title: string }).title = 'Mutated title';
    mutableBinding.resourceIdentity = 'collection-mutated';
    mutableBinding.key = '019f-publish-0012-mutated';

    await expect(pending).resolves.toMatchObject({
      state: 'committed',
      response: {
        body: {
          collection: { id: request.collectionId, title: request.collection.title },
          root: { id: request.rootNodeId },
        },
      },
    });
    const state = adapter.snapshot();
    expect([...state.reservations.keys()]).toEqual([request.collectionId, request.rootNodeId]);
    expect([...state.idempotency.keys()][0]).toContain('019f-publish-0012-create');
    expectNoOrphan(state);
  });

  it('rejects an invalid creation endpoint or allocated result identity before opening a transaction [evidence:publisher.collection-root-atomic]', async () => {
    for (const invalidBinding of [
      { ...bindingFor(), endpointKey: 'nodes' },
      { ...bindingFor(), method: 'PUT' },
      { ...bindingFor(), resourceIdentity: request.collectionId },
      { ...bindingFor(), resourceIdentity: request.rootNodeId },
    ]) {
      const adapter = new AtomicMemoryPublisherAdapter();
      await expect(create(adapter, request, invalidBinding)).rejects.toThrow(/does not match|stable creation scope/u);
      expect(adapter.executeCalls).toBe(0);
      expect(adapter.snapshot()).toEqual(emptyDatabase());
    }
  });

  it('treats Collection-ID and Root-ID reservation conflicts as atomic global uniqueness failures [evidence:publisher.collection-root-atomic]', async () => {
    const collisions: readonly [string, ServerIdResourceType][] = [
      [request.collectionId, 'relation'],
      [request.rootNodeId, 'node'],
    ];

    for (const [id, existingType] of collisions) {
      const adapter = new AtomicMemoryPublisherAdapter();
      adapter.seedReservation(id, existingType);
      await expect(create(adapter)).rejects.toMatchObject({
        name: 'ServerIdAlreadyReservedError',
        code: 'server_id_already_reserved',
      });
      const state = adapter.snapshot();
      expect([...state.reservations]).toEqual([[id, existingType]]);
      expect(state.collections.size).toBe(0);
      expect(state.roots.size).toBe(0);
      expect(state.idempotency.size).toBe(0);
    }
  });

  it('allows exactly one of two concurrent claims for the same Collection and Root identities [evidence:publisher.collection-root-atomic]', async () => {
    const adapter = new AtomicMemoryPublisherAdapter();
    const outcomes = await Promise.allSettled([
      create(adapter, request, bindingFor(request, '019f-publish-0012-concurrent-a')),
      create(adapter, request, bindingFor(request, '019f-publish-0012-concurrent-b')),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(adapter.resourceCreateCalls).toBe(1);
    expect(adapter.snapshot().reservations.size).toBe(2);
    expectNoOrphan(adapter.snapshot());
  });

  it('fails closed for unknown commit outcomes and never reports or persists an orphan [evidence:publisher.collection-root-atomic]', async () => {
    for (const outcome of ['unknown-before-commit', 'unknown-after-commit'] as const) {
      const adapter = new AtomicMemoryPublisherAdapter();
      adapter.commitOutcome = outcome;

      await expect(create(adapter)).rejects.toThrow('commit outcome unknown');
      const state = adapter.snapshot();
      expect([0, 1]).toContain(state.collections.size);
      expectNoOrphan(state);

      adapter.commitOutcome = 'known';
      const retry = await create(adapter);
      expect(retry.state).toBe(outcome === 'unknown-after-commit' ? 'replayed' : 'committed');
      expectNoOrphan(adapter.snapshot());
    }
  });

  it('replays the original complete response without re-reserving or recreating, preserving PUBLISH-0003 [evidence:publisher.collection-root-atomic]', async () => {
    const adapter = new AtomicMemoryPublisherAdapter();
    const binding = bindingFor();
    const first = await create(adapter, request, binding);
    const replay = await create(adapter, request, binding);

    expect(first).toMatchObject({ state: 'committed' });
    expect(replay).toEqual({
      state: 'replayed',
      response: first.state === 'committed' ? first.response : expect.anything(),
    });
    expect(adapter.reservationCalls).toBe(1);
    expect(adapter.resourceCreateCalls).toBe(1);

    const changedRequest = {
      ...request,
      collection: { ...request.collection, title: 'Different request' },
    };
    const changedDigest = bindingFor(changedRequest, binding.key);
    await expect(create(adapter, changedRequest, changedDigest)).resolves.toMatchObject({
      state: 'conflict',
      storedRequestDigest: binding.requestDigest,
    });
    expect(adapter.resourceCreateCalls).toBe(1);
    expectNoOrphan(adapter.snapshot());
  });

  it('replays the first result when HTTP retries allocate different unused IDs [evidence:publisher.collection-root-atomic]', async () => {
    const adapter = new AtomicMemoryPublisherAdapter();
    const retry = { ...request, collectionId: 'collection-retry', rootNodeId: 'root-retry' };
    const first = await create(adapter);
    const repeated = await create(adapter, retry);

    expect(bindingFor(retry)).toEqual(bindingFor(request));
    expect(first.state).toBe('committed');
    expect(repeated).toEqual({
      state: 'replayed',
      response: first.state === 'committed' ? first.response : undefined,
    });
    expect(adapter.resourceCreateCalls).toBe(1);
    expect(adapter.reservationCalls).toBe(1);
    expect(adapter.snapshot().reservations.has(retry.collectionId)).toBe(false);
    expect(adapter.snapshot().reservations.has(retry.rootNodeId)).toBe(false);
    expect(adapter.snapshot().collections.size).toBe(1);
    expectNoOrphan(adapter.snapshot());
  });

});
