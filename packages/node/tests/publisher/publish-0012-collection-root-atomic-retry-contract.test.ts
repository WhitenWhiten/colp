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

describe('PUBLISH-0012 Collection + unique Root atomic retry contract', () => {
  it('recovers an unknown committed outcome with newly allocated retry IDs [evidence:publisher.collection-root-atomic]', async () => {
    const adapter = new AtomicMemoryPublisherAdapter();
    adapter.commitOutcome = 'unknown-after-commit';
    await expect(create(adapter)).rejects.toThrow('commit outcome unknown');
    adapter.commitOutcome = 'known';
    const retry = { ...request, collectionId: 'collection-after-timeout', rootNodeId: 'root-after-timeout' };
    await expect(create(adapter, retry)).resolves.toMatchObject({
      state: 'replayed',
      response: { body: { collection: { id: request.collectionId }, root: { id: request.rootNodeId } } },
    });
    expect(adapter.resourceCreateCalls).toBe(1);
    expect(adapter.reservationCalls).toBe(1);
    expect(adapter.snapshot().collections.size).toBe(1);
    expectNoOrphan(adapter.snapshot());
  });

  it('serializes one request identity even when concurrent attempts allocate different IDs [evidence:publisher.collection-root-atomic]', async () => {
    const adapter = new AtomicMemoryPublisherAdapter();
    const retry = { ...request, collectionId: 'collection-concurrent-retry', rootNodeId: 'root-concurrent-retry' };
    const results = await Promise.all([create(adapter), create(adapter, retry)]);
    expect(results.map((result) => result.state).sort()).toEqual(['committed', 'replayed']);
    expect(adapter.resourceCreateCalls).toBe(1);
    expect(adapter.reservationCalls).toBe(1);
    expect(adapter.snapshot().collections.size).toBe(1);
    expect(adapter.snapshot().idempotency.size).toBe(1);
    expectNoOrphan(adapter.snapshot());
  });

});
