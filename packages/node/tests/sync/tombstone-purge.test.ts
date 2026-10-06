import { describe, expect, it } from 'vitest';

import { coordinateTombstonePurge as coordinateFromSyncEntry } from '../../src/sync/index.js';
import {
  coordinateTombstonePurge,
  type DeletionWatermark,
  type TombstonePurgeBoundary,
  type TombstonePurgeCandidate,
  type TombstonePurgeReplicaState,
  type TombstonePurgeRequest,
  type TombstonePurgeTransaction,
  type TombstonePurgeUnitOfWork,
} from '../../src/sync/index.js';
import type { SyncTombstone } from '../../src/types/generated.js';

const evidence = '[evidence:sync.tombstone-purge]';

type FailurePoint =
  | 'boundary-write'
  | 'watermark-write'
  | 'delete-write'
  | 'boundary-readback'
  | 'watermark-readback'
  | 'tombstone-readback';

type IgnoredWrite = 'boundary' | 'watermark' | 'delete';

interface DurableState {
  candidate: TombstonePurgeCandidate;
  tombstone: SyncTombstone | undefined;
  boundary: TombstonePurgeBoundary;
  watermarks: Map<string, DeletionWatermark>;
}

function watermarkKey(watermark: DeletionWatermark): string {
  return JSON.stringify([
    watermark.serverUuid,
    watermark.collectionId,
    watermark.targetId,
    watermark.generation,
  ]);
}

function cloneState(state: DurableState): DurableState {
  return {
    candidate: structuredClone(state.candidate),
    tombstone: state.tombstone === undefined ? undefined : structuredClone(state.tombstone),
    boundary: structuredClone(state.boundary),
    watermarks: new Map(
      [...state.watermarks].map(([key, value]) => [key, structuredClone(value)]),
    ),
  };
}

function request(overrides: Partial<TombstonePurgeRequest> = {}): TombstonePurgeRequest {
  return {
    collectionId: 'collection-1',
    targetId: 'node-root',
    serverUuid: 'server-lifetime-1',
    ...overrides,
  };
}

function tombstone(overrides: Partial<SyncTombstone> = {}): SyncTombstone {
  return {
    resourceType: 'node',
    targetId: 'node-root',
    collectionId: 'collection-1',
    scope: 'subtree',
    deletedAt: '2026-07-18T00:00:00Z',
    deletedBy: 'principal-1',
    deleteRevision: 'revision-delete-1',
    operationId: 'operation-delete-1',
    deleteCursor: 'opaque-delete-cursor',
    affectedCount: 3,
    purgeAfter: '2026-07-18T01:00:00Z',
    ...overrides,
  };
}

function candidate(overrides: Partial<TombstonePurgeCandidate> = {}): TombstonePurgeCandidate {
  return {
    tombstone: tombstone(),
    deleteCommitOrdinal: '10',
    deletedMembers: [
      { targetId: 'node-root', collectionId: 'collection-1', generation: 'generation-root' },
      { targetId: 'node-child', collectionId: 'collection-1', generation: 'generation-child' },
      { targetId: 'annotation-1', collectionId: 'collection-1', generation: 'generation-annotation' },
    ],
    ...overrides,
  };
}

function replica(
  replicaId: string,
  overrides: Partial<TombstonePurgeReplicaState> = {},
): TombstonePurgeReplicaState {
  return {
    replicaId,
    collectionId: 'collection-1',
    lifecycle: 'active',
    acknowledgedCommitOrdinal: '10',
    queuedOperationsReconciled: true,
    ...overrides,
  };
}

function initialState(overrides: Partial<DurableState> = {}): DurableState {
  const storedCandidate = overrides.candidate ?? candidate();
  return {
    candidate: storedCandidate,
    tombstone: overrides.tombstone ?? storedCandidate.tombstone,
    boundary: overrides.boundary ?? {
      collectionId: 'collection-1', cursor: 'older-cursor', commitOrdinal: '2',
    },
    watermarks: overrides.watermarks ?? new Map(),
  };
}

class SharedDurablePurgeBackend {
  state: DurableState;
  authoritativeTime = '2026-07-18T01:00:00Z';
  replicas: TombstonePurgeReplicaState[] = [replica('replica-1')];
  readonly transactionTails = new Map<string, Promise<void>>();

  constructor(state = initialState()) {
    this.state = cloneState(state);
  }

  snapshot(): DurableState {
    return cloneState(this.state);
  }
}

/**
 * A staged adapter-contract fixture: shared handles observe committed snapshots and callback
 * failure discards the draft. It deliberately does not claim to prove cross-process durability.
 */
class DurablePurgeHandle implements TombstonePurgeUnitOfWork {
  failure?: FailurePoint;
  ignoredWrite?: IgnoredWrite;
  rejectAfterCommitOnce = false;
  mutatePortInputs = false;
  readonly trace: string[] = [];

  constructor(readonly backend = new SharedDurablePurgeBackend()) {}

  execute<Value>(
    collectionId: string,
    work: (transaction: TombstonePurgeTransaction) => Promise<Value>,
  ): Promise<Value> {
    const previous = this.backend.transactionTails.get(collectionId) ?? Promise.resolve();
    const run = async (): Promise<Value> => {
      this.trace.push('tx:begin');
      const draft = cloneState(this.backend.state);
      try {
        const result = await work(this.transaction(draft));
        this.backend.state = draft;
        this.trace.push('tx:commit');
        if (this.rejectAfterCommitOnce) {
          this.rejectAfterCommitOnce = false;
          throw new Error('commit outcome unknown');
        }
        return result;
      } catch (error) {
        this.trace.push('tx:reject');
        throw error;
      }
    };
    const outcome = previous.then(run, run);
    this.backend.transactionTails.set(collectionId, outcome.then(() => undefined, () => undefined));
    return outcome;
  }

  private transaction(draft: DurableState): TombstonePurgeTransaction {
    let boundaryLoads = 0;
    let watermarkLoads = 0;
    let tombstoneLoads = 0;
    const maybeMutate = (value: object): void => {
      if (this.mutatePortInputs) Object.assign(value, { adapterMutation: true });
    };
    return {
      loadCandidate: async (value) => {
        maybeMutate(value);
        this.trace.push('read:candidate');
        return draft.tombstone === undefined ? undefined : structuredClone(draft.candidate);
      },
      readAuthoritativeTime: async () => {
        this.trace.push('read:time');
        return this.backend.authoritativeTime;
      },
      listReplicaStates: async (collectionId) => {
        this.trace.push('read:replicas');
        return structuredClone(this.backend.replicas.filter((entry) => entry.collectionId === collectionId));
      },
      loadPurgeBoundary: async () => {
        boundaryLoads += 1;
        this.trace.push(`read:boundary:${boundaryLoads}`);
        if (boundaryLoads > 1 && this.failure === 'boundary-readback') {
          throw new Error('injected boundary read-back failure');
        }
        return structuredClone(draft.boundary);
      },
      advancePurgedThrough: async (value) => {
        const stored = structuredClone(value);
        maybeMutate(value);
        this.trace.push('write:boundary');
        if (this.failure === 'boundary-write') throw new Error('injected boundary write failure');
        if (this.ignoredWrite === 'boundary') return;
        draft.boundary = stored;
      },
      saveDeletionWatermark: async (value) => {
        const stored = structuredClone(value);
        maybeMutate(value);
        this.trace.push(`write:watermark:${value.targetId}`);
        if (this.failure === 'watermark-write') throw new Error('injected watermark write failure');
        if (this.ignoredWrite === 'watermark') return;
        draft.watermarks.set(watermarkKey(stored), stored);
      },
      deleteTombstone: async (identity) => {
        const deletion = structuredClone(identity);
        maybeMutate(identity);
        this.trace.push('write:delete');
        if (this.failure === 'delete-write') throw new Error('injected delete write failure');
        if (this.ignoredWrite === 'delete') return;
        const stored = draft.tombstone;
        if (
          stored === undefined
          || deletion.collectionId !== stored.collectionId
          || deletion.targetId !== stored.targetId
          || deletion.deleteRevision !== stored.deleteRevision
          || deletion.operationId !== stored.operationId
        ) {
          throw new Error('delete precondition mismatch');
        }
        draft.tombstone = undefined;
      },
      loadDeletionWatermark: async (value) => {
        const lookup = structuredClone(value);
        maybeMutate(value);
        watermarkLoads += 1;
        this.trace.push(`read:watermark:${value.targetId}`);
        if (watermarkLoads === 1 && this.failure === 'watermark-readback') {
          throw new Error('injected watermark read-back failure');
        }
        const stored = draft.watermarks.get(watermarkKey(lookup));
        return stored === undefined ? undefined : structuredClone(stored);
      },
      loadTombstone: async (value) => {
        maybeMutate(value);
        tombstoneLoads += 1;
        this.trace.push(`read:tombstone:${tombstoneLoads}`);
        if (this.failure === 'tombstone-readback') {
          throw new Error('injected tombstone read-back failure');
        }
        return draft.tombstone === undefined ? undefined : structuredClone(draft.tombstone);
      },
    };
  }
}

async function purge(handle = new DurablePurgeHandle(), value = request()) {
  return coordinateTombstonePurge(handle, value);
}

function writeTrace(handle: DurablePurgeHandle): string[] {
  return handle.trace.filter((entry) => entry.startsWith('write:'));
}

describe(`SYNC-0006 durable Tombstone purge coordinator ${evidence}`, () => {
  it(`returns a large committed subtree without a post-commit JSON budget failure ${evidence}`, async () => {
    const deletedMembers = Array.from({ length: 2000 }, (_, index) => ({
      targetId: index === 0 ? 'node-root' : `node-${index}`,
      collectionId: 'collection-1', generation: `generation-${index}`,
    }));
    const handle = new DurablePurgeHandle(new SharedDurablePurgeBackend(initialState({
      candidate: candidate({ tombstone: tombstone({ affectedCount: deletedMembers.length }), deletedMembers }),
    })));
    const result = await purge(handle);
    if (result.state !== 'purged') throw new Error('expected committed purge');
    expect(result.deletionWatermarks).toHaveLength(2000);
    expect(handle.backend.state.watermarks.size).toBe(2000);
    expect(handle.backend.state.tombstone).toBeUndefined();
    expect(handle.trace.at(-1)).toBe('tx:commit');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tombstone)).toBe(true);
    expect(Object.isFrozen(result.purgeBoundary)).toBe(true);
    expect(Object.isFrozen(result.deletionWatermarks)).toBe(true);
    expect(result.deletionWatermarks.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ['before', '2026-07-18T00:59:59.999Z', 'blocked'],
    ['exactly at', '2026-07-18T01:00:00.000Z', 'purged'],
    ['exactly at with an offset', '2026-07-18T09:00:00.000+08:00', 'purged'],
    ['after', '2026-07-18T01:00:00.001Z', 'purged'],
  ] as const)(`uses authoritative transaction time %s purgeAfter ${evidence}`, async (_label, now, state) => {
    const handle = new DurablePurgeHandle();
    handle.backend.authoritativeTime = now;

    await expect(purge(handle)).resolves.toMatchObject({
      state,
      ...(state === 'blocked' ? { reason: 'retention_not_elapsed' } : {}),
    });
    expect(handle.trace).toContain('read:time');
    expect(writeTrace(handle).length).toBe(state === 'blocked' ? 0 : 5);
  });

  it.each([
    ['date-only', '2026-07-18'],
    ['English loose date', 'July 18, 2026 01:00:00 GMT'],
    ['missing timezone', '2026-07-18T01:00:00'],
  ] as const)(`fails closed before purge writes for %s authoritative time ${evidence}`, async (_label, now) => {
    const handle = new DurablePurgeHandle();
    handle.backend.authoritativeTime = now;
    const before = handle.backend.snapshot();

    await expect(purge(handle)).rejects.toThrow('valid RFC 3339 date-time');
    expect(writeTrace(handle)).toEqual([]);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`returns tombstone-not-found with no reads beyond candidate lookup and zero writes ${evidence}`, async () => {
    const backend = new SharedDurablePurgeBackend();
    backend.state.tombstone = undefined;
    const handle = new DurablePurgeHandle(backend);
    const before = handle.backend.snapshot();

    await expect(purge(handle)).resolves.toEqual({
      state: 'blocked', reason: 'tombstone_not_found', blockingReplicaIds: [],
    });
    expect(handle.trace).toEqual(['tx:begin', 'read:candidate', 'tx:commit']);
    expect(writeTrace(handle)).toEqual([]);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`purges only when every active Replica acknowledges at or beyond deletion and reconciles its queue ${evidence}`, async () => {
    const handle = new DurablePurgeHandle();
    handle.backend.replicas = [
      replica('replica-at', { acknowledgedCommitOrdinal: '10' }),
      replica('replica-beyond', { acknowledgedCommitOrdinal: '11' }),
      replica('replica-far', { acknowledgedCommitOrdinal: '90071992547409931234567890' }),
    ];

    await expect(purge(handle)).resolves.toMatchObject({ state: 'purged' });
  });

  it.each([
    ['null acknowledgement', replica('replica-null', { acknowledgedCommitOrdinal: null }), 'active_replica_ack_missing'],
    ['old acknowledgement', replica('replica-old', { acknowledgedCommitOrdinal: '9' }), 'active_replica_ack_missing'],
    ['unreconciled queue', replica('replica-queue', { queuedOperationsReconciled: false }), 'active_replica_queue_unreconciled'],
  ] as const)(`blocks with zero writes for %s ${evidence}`, async (_label, state, reason) => {
    const handle = new DurablePurgeHandle();
    handle.backend.replicas = [replica('replica-ready'), state];
    const before = handle.backend.snapshot();

    await expect(purge(handle)).resolves.toEqual({
      state: 'blocked', reason, blockingReplicaIds: [state.replicaId],
    });
    expect(writeTrace(handle)).toEqual([]);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`ignores expired, recovery-required, and retired Replica acknowledgement and queue state ${evidence}`, async () => {
    const handle = new DurablePurgeHandle();
    handle.backend.replicas = [
      replica('expired', { lifecycle: 'expired', acknowledgedCommitOrdinal: null, queuedOperationsReconciled: false }),
      replica('recovery', {
        lifecycle: 'recovery_required', acknowledgedCommitOrdinal: null, queuedOperationsReconciled: false,
      }),
      replica('retired', { lifecycle: 'retired', acknowledgedCommitOrdinal: null, queuedOperationsReconciled: false }),
    ];

    await expect(purge(handle)).resolves.toMatchObject({ state: 'purged' });
  });

  it(`fails closed for an unknown Replica lifecycle ${evidence}`, async () => {
    const handle = new DurablePurgeHandle();
    handle.backend.replicas = [replica('unknown', { lifecycle: 'paused' as never })];
    const before = handle.backend.snapshot();

    await expect(purge(handle)).rejects.toThrow('lifecycle is invalid');
    expect(handle.backend.snapshot()).toEqual(before);
    expect(writeTrace(handle)).toEqual([]);
  });

  it(`rejects non-boolean Replica queue reconciliation flag ${evidence}`, async () => {
    const handle = new DurablePurgeHandle();
    handle.backend.replicas = [
      replica('bad-queue', { queuedOperationsReconciled: 'yes' as never }),
    ];
    const before = handle.backend.snapshot();
    await expect(purge(handle)).rejects.toThrow(/queue state must be boolean/i);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`rejects a purge boundary belonging to another Collection ${evidence}`, async () => {
    const base = new DurablePurgeHandle();
    const unitOfWork: TombstonePurgeUnitOfWork = {
      execute: (collectionId, work) => base.execute(collectionId, async (transaction) => work({
        ...transaction,
        loadPurgeBoundary: async () => ({
          collectionId: 'collection-2',
          cursor: 'older-cursor',
          commitOrdinal: '2',
        }),
      })),
    };
    const before = base.backend.snapshot();
    await expect(coordinateTombstonePurge(unitOfWork, request())).rejects.toThrow(
      /boundary belongs to a different Collection/i,
    );
    expect(base.backend.snapshot()).toEqual(before);
  });

  it(`rejects Deletion Watermark read-back that mutates generation ${evidence}`, async () => {
    const base = new DurablePurgeHandle();
    const unitOfWork: TombstonePurgeUnitOfWork = {
      execute: (collectionId, work) => base.execute(collectionId, async (transaction) => work({
        ...transaction,
        loadDeletionWatermark: async (value) => ({
          ...structuredClone(value),
          generation: 'generation-forged',
        }),
      })),
    };
    const before = base.backend.snapshot();
    await expect(coordinateTombstonePurge(unitOfWork, request())).rejects.toThrow(
      /Watermark read-back does not match/i,
    );
    expect(base.backend.snapshot()).toEqual(before);
  });

  it(`rejects a null Tombstone purge transaction object ${evidence}`, async () => {
    await expect(
      coordinateTombstonePurge(
        {
          execute: async (_collectionId, work) => work(null as never),
        },
        request(),
      ),
    ).rejects.toThrow(/transaction object/i);
  });

  it(`does not let a Replica from another Collection participate ${evidence}`, async () => {
    const handle = new DurablePurgeHandle();
    handle.backend.replicas = [
      replica('local-ready'),
      replica('foreign-blocked', {
        collectionId: 'collection-2', acknowledgedCommitOrdinal: null, queuedOperationsReconciled: false,
      }),
    ];

    await expect(purge(handle)).resolves.toMatchObject({ state: 'purged' });
  });

  it(`compares decimal ordinals numerically instead of lexically ${evidence}`, async () => {
    const handle = new DurablePurgeHandle();
    handle.backend.replicas = [replica('replica-9', { acknowledgedCommitOrdinal: '9' })];

    await expect(purge(handle)).resolves.toEqual({
      state: 'blocked', reason: 'active_replica_ack_missing', blockingReplicaIds: ['replica-9'],
    });
  });

  it(`supports canonical decimal ordinals beyond Number safe-integer range ${evidence}`, async () => {
    const deletion = '900719925474099312345678901234567890';
    const stored = candidate({ deleteCommitOrdinal: deletion });
    const handle = new DurablePurgeHandle(new SharedDurablePurgeBackend(initialState({ candidate: stored })));
    handle.backend.replicas = [replica('replica-huge', { acknowledgedCommitOrdinal: deletion })];

    await expect(purge(handle)).resolves.toMatchObject({
      state: 'purged', purgeBoundary: { commitOrdinal: deletion },
    });
  });

  it(`rejects unbounded decimal ordinals before BigInt conversion ${evidence}`, async () => {
    const deletion = `1${'0'.repeat(1_024)}`;
    const stored = candidate({ deleteCommitOrdinal: deletion });
    const handle = new DurablePurgeHandle(new SharedDurablePurgeBackend(initialState({ candidate: stored })));
    handle.backend.replicas = [replica('replica-huge', { acknowledgedCommitOrdinal: deletion })];

    await expect(purge(handle)).rejects.toThrow(/at most/u);
  });

  it(`fails closed if a scoped Replica query returns a foreign Collection row ${evidence}`, async () => {
    const base = new DurablePurgeHandle();
    const unitOfWork: TombstonePurgeUnitOfWork = {
      execute: (collectionId, work) => base.execute(collectionId, async (transaction) => work({
        ...transaction,
        listReplicaStates: async () => [
          replica('local-ready'),
          replica('foreign', { collectionId: 'collection-2' }),
        ],
      })),
    };
    const before = base.backend.snapshot();

    await expect(coordinateTombstonePurge(unitOfWork, request())).rejects.toThrow(
      'belongs to a different Collection',
    );
    expect(base.backend.snapshot()).toEqual(before);
    expect(writeTrace(base)).toEqual([]);
  });

  it.each([
    ['affectedCount mismatch', candidate({ tombstone: tombstone({ affectedCount: 4 }) })],
    ['duplicate member', candidate({ deletedMembers: [
      { targetId: 'node-root', collectionId: 'collection-1', generation: 'generation-root' },
      { targetId: 'node-root', collectionId: 'collection-1', generation: 'generation-other' },
      { targetId: 'annotation-1', collectionId: 'collection-1', generation: 'generation-annotation' },
    ] })],
    ['missing candidate target', candidate({ deletedMembers: [
      { targetId: 'node-a', collectionId: 'collection-1', generation: 'generation-a' },
      { targetId: 'node-b', collectionId: 'collection-1', generation: 'generation-b' },
      { targetId: 'node-c', collectionId: 'collection-1', generation: 'generation-c' },
    ] })],
    ['foreign member', candidate({ deletedMembers: [
      { targetId: 'node-root', collectionId: 'collection-1', generation: 'generation-root' },
      { targetId: 'node-child', collectionId: 'collection-2', generation: 'generation-child' },
      { targetId: 'annotation-1', collectionId: 'collection-1', generation: 'generation-annotation' },
    ] })],
    ['empty generation', candidate({ deletedMembers: [
      { targetId: 'node-root', collectionId: 'collection-1', generation: 'generation-root' },
      { targetId: 'node-child', collectionId: 'collection-1', generation: '' },
      { targetId: 'annotation-1', collectionId: 'collection-1', generation: 'generation-annotation' },
    ] })],
    ['single scope with multiple members', candidate({ tombstone: tombstone({ scope: 'single' }) })],
    ['invalid deletedAt', candidate({ tombstone: tombstone({ deletedAt: 'not-a-date-time' }) })],
    ['invalid purgeAfter', candidate({ tombstone: tombstone({ purgeAfter: '2026-07-18 01:00:00' }) })],
  ] as const)(`rejects an incomplete or invalid authoritative candidate: %s ${evidence}`, async (_label, stored) => {
    const handle = new DurablePurgeHandle(new SharedDurablePurgeBackend(initialState({ candidate: stored })));
    const before = handle.backend.snapshot();

    await expect(purge(handle)).rejects.toThrow();
    expect(handle.backend.snapshot()).toEqual(before);
    expect(writeTrace(handle)).toEqual([]);
  });

  it(`rejects an unsafe affectedCount before member-set mismatch can fire ${evidence}`, async () => {
    // isSafeInteger check runs before deletedMembers length comparison, so three
    // members plus MAX_SAFE_INTEGER+1 must fail with the safe-integer message.
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const stored = candidate({ tombstone: tombstone({ affectedCount: unsafe }) });
    const handle = new DurablePurgeHandle(new SharedDurablePurgeBackend(initialState({ candidate: stored })));
    const before = handle.backend.snapshot();

    await expect(purge(handle)).rejects.toThrow(/positive safe integer/u);
    expect(handle.backend.snapshot()).toEqual(before);
    expect(writeTrace(handle)).toEqual([]);
  });

  it(`accepts store-returned candidates and tombstones with null prototypes ${evidence}`, async () => {
    const nullProtoMember = (entry: {
      targetId: string;
      collectionId: string;
      generation: string;
    }) => Object.assign(Object.create(null) as Record<string, unknown>, entry);
    const nullProtoTombstone = Object.assign(
      Object.create(null) as Record<string, unknown>,
      tombstone(),
    ) as SyncTombstone;
    const stored = Object.assign(Object.create(null) as Record<string, unknown>, {
      tombstone: nullProtoTombstone,
      deleteCommitOrdinal: '10',
      deletedMembers: [
        nullProtoMember({
          targetId: 'node-root', collectionId: 'collection-1', generation: 'generation-root',
        }),
        nullProtoMember({
          targetId: 'node-child', collectionId: 'collection-1', generation: 'generation-child',
        }),
        nullProtoMember({
          targetId: 'annotation-1', collectionId: 'collection-1', generation: 'generation-annotation',
        }),
      ],
    }) as TombstonePurgeCandidate;
    const handle = new DurablePurgeHandle(new SharedDurablePurgeBackend(initialState({ candidate: stored })));

    await expect(purge(handle)).resolves.toMatchObject({ state: 'purged', tombstone: { affectedCount: 3 } });
  });

  it(`purges one complete single-resource candidate and writes its generation watermark ${evidence}`, async () => {
    const singleTombstone = tombstone({ scope: 'single', affectedCount: 1 });
    const stored = candidate({
      tombstone: singleTombstone,
      deletedMembers: [{
        targetId: 'node-root', collectionId: 'collection-1', generation: 'generation-single',
      }],
    });
    const handle = new DurablePurgeHandle(new SharedDurablePurgeBackend(initialState({ candidate: stored })));

    await expect(purge(handle)).resolves.toMatchObject({
      state: 'purged',
      deletionWatermarks: [{
        serverUuid: 'server-lifetime-1', collectionId: 'collection-1',
        targetId: 'node-root', generation: 'generation-single',
      }],
    });
  });

  it(`persists one durable watermark for every complete unique subtree member and physically deletes the Tombstone ${evidence}`, async () => {
    const handle = new DurablePurgeHandle();

    const result = await purge(handle);

    expect(result).toMatchObject({ state: 'purged', tombstone: { affectedCount: 3, scope: 'subtree' } });
    expect(result.state === 'purged' && result.deletionWatermarks).toEqual([
      { serverUuid: 'server-lifetime-1', collectionId: 'collection-1', targetId: 'node-root', generation: 'generation-root' },
      { serverUuid: 'server-lifetime-1', collectionId: 'collection-1', targetId: 'node-child', generation: 'generation-child' },
      { serverUuid: 'server-lifetime-1', collectionId: 'collection-1', targetId: 'annotation-1', generation: 'generation-annotation' },
    ]);
    const durable = handle.backend.snapshot();
    expect(durable.tombstone).toBeUndefined();
    expect([...durable.watermarks.values()]).toHaveLength(3);
  });

  it(`advances a behind boundary through the deletion Cursor and ordinal ${evidence}`, async () => {
    const handle = new DurablePurgeHandle();

    await expect(purge(handle)).resolves.toMatchObject({
      state: 'purged',
      purgeBoundary: { collectionId: 'collection-1', cursor: 'opaque-delete-cursor', commitOrdinal: '10' },
    });
    expect(handle.backend.snapshot().boundary).toEqual({
      collectionId: 'collection-1', cursor: 'opaque-delete-cursor', commitOrdinal: '10',
    });
  });

  it(`never rolls an already-ahead purge boundary backward ${evidence}`, async () => {
    const ahead = { collectionId: 'collection-1', cursor: 'later-cursor', commitOrdinal: '100' };
    const handle = new DurablePurgeHandle(new SharedDurablePurgeBackend(initialState({ boundary: ahead })));

    await expect(purge(handle)).resolves.toMatchObject({ state: 'purged', purgeBoundary: ahead });
    expect(handle.backend.snapshot().boundary).toEqual(ahead);
  });

  it(`rejects a conflicting Cursor at the same purge-boundary ordinal without writes ${evidence}`, async () => {
    const handle = new DurablePurgeHandle(new SharedDurablePurgeBackend(initialState({ boundary: {
      collectionId: 'collection-1', cursor: 'different-cursor', commitOrdinal: '10',
    } })));

    await expect(purge(handle)).rejects.toThrow('Cursor conflicts');
    expect(writeTrace(handle)).toEqual([]);
  });

  it.each([
    'boundary-write',
    'watermark-write',
    'delete-write',
    'boundary-readback',
    'watermark-readback',
    'tombstone-readback',
  ] as const)(`rolls back the complete staged transaction after %s failure ${evidence}`, async (point) => {
    const handle = new DurablePurgeHandle();
    handle.failure = point;
    const before = handle.backend.snapshot();

    await expect(purge(handle)).rejects.toThrow('injected');
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it.each(['boundary', 'watermark', 'delete'] as const)(
    `detects an adapter that silently drops the %s write and rolls back all staged writes ${evidence}`,
    async (point) => {
      const handle = new DurablePurgeHandle();
      handle.ignoredWrite = point;
      const before = handle.backend.snapshot();

      await expect(purge(handle)).rejects.toThrow(
        point === 'boundary'
          ? 'did not advance monotonically'
          : point === 'watermark'
            ? 'was not durable'
            : 'remained present',
      );
      expect(handle.backend.snapshot()).toEqual(before);
    },
  );

  it(`rejects commit-unknown without reporting success while preserving the committed durable purge ${evidence}`, async () => {
    const handle = new DurablePurgeHandle();
    handle.rejectAfterCommitOnce = true;

    await expect(purge(handle)).rejects.toThrow('commit outcome unknown');
    expect(handle.backend.snapshot().tombstone).toBeUndefined();
    expect(handle.backend.snapshot().watermarks.size).toBe(3);
    await expect(purge(handle)).resolves.toEqual({
      state: 'blocked', reason: 'tombstone_not_found', blockingReplicaIds: [],
    });
  });

  it.each(['zero', 'twice', 'forged'] as const)(
    `rejects a UnitOfWork whose callback contract is %s ${evidence}`,
    async (behavior) => {
      const base = new DurablePurgeHandle();
      const malicious: TombstonePurgeUnitOfWork = {
        execute: async <Value>(collectionId: string, work: (
          transaction: TombstonePurgeTransaction,
        ) => Promise<Value>): Promise<Value> => {
          if (behavior === 'zero') return { state: 'purged' } as unknown as Value;
          const original = await base.execute(collectionId, async (transaction) => {
            const first = await work(transaction);
            if (behavior === 'twice') await work(transaction);
            return first;
          });
          return behavior === 'forged' ? structuredClone(original) : original;
        },
      };

      await expect(coordinateTombstonePurge(malicious, request())).rejects.toThrow(
        /callback exactly once|forged transaction callback result/u,
      );
    },
  );

  it.each([
    'unit-of-work',
    'candidate-load',
    'time-read',
    'replica-load',
    'boundary-load',
    'boundary-write',
    'watermark-write',
    'delete-write',
    'watermark-readback',
    'tombstone-readback',
  ] as const)(`rejects a synchronous %s port ${evidence}`, async (point) => {
    const base = new DurablePurgeHandle();
    if (point === 'unit-of-work') {
      await expect(coordinateTombstonePurge({ execute: (() => undefined) as never }, request()))
        .rejects.toThrow('must return a Promise');
      return;
    }
    const unitOfWork: TombstonePurgeUnitOfWork = {
      execute: (collectionId, work) => base.execute(collectionId, async (transaction) => work({
        loadCandidate: point === 'candidate-load' ? (() => undefined) as never : transaction.loadCandidate,
        readAuthoritativeTime: point === 'time-read' ? (() => undefined) as never : transaction.readAuthoritativeTime,
        listReplicaStates: point === 'replica-load' ? (() => undefined) as never : transaction.listReplicaStates,
        loadPurgeBoundary: point === 'boundary-load' ? (() => undefined) as never : transaction.loadPurgeBoundary,
        advancePurgedThrough: point === 'boundary-write' ? (() => undefined) as never : transaction.advancePurgedThrough,
        saveDeletionWatermark: point === 'watermark-write' ? (() => undefined) as never : transaction.saveDeletionWatermark,
        deleteTombstone: point === 'delete-write' ? (() => undefined) as never : transaction.deleteTombstone,
        loadDeletionWatermark: point === 'watermark-readback'
          ? (() => undefined) as never
          : transaction.loadDeletionWatermark,
        loadTombstone: point === 'tombstone-readback' ? (() => undefined) as never : transaction.loadTombstone,
      })),
    };

    await expect(coordinateTombstonePurge(unitOfWork, request())).rejects.toThrow('must return a Promise');
  });

  it(`shares committed durable state across independent handles without claiming cross-process proof ${evidence}`, async () => {
    const backend = new SharedDurablePurgeBackend();
    const writer = new DurablePurgeHandle(backend);
    const reader = new DurablePurgeHandle(backend);

    await expect(purge(writer)).resolves.toMatchObject({ state: 'purged' });
    await expect(purge(reader)).resolves.toEqual({
      state: 'blocked', reason: 'tombstone_not_found', blockingReplicaIds: [],
    });
    expect(reader.backend.snapshot().boundary.commitOrdinal).toBe('10');
    expect(reader.backend.snapshot().watermarks.size).toBe(3);
  });

  it(`detaches and freezes request, store values, port inputs, durable state, and output ${evidence}`, async () => {
    const backend = new SharedDurablePurgeBackend();
    const handle = new DurablePurgeHandle(backend);
    handle.mutatePortInputs = true;
    const callerRequest = request();
    const beforeRequest = structuredClone(callerRequest);
    const result = await purge(handle, callerRequest);

    expect(callerRequest).toEqual(beforeRequest);
    expect(Object.hasOwn(callerRequest, 'adapterMutation')).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.state).toBe('purged');
    if (result.state !== 'purged') throw new Error('expected purged result');
    expect(Object.isFrozen(result.tombstone)).toBe(true);
    // Committed purge snapshots clone via immutableJsonData → null-prototype plain data.
    expect(Object.getPrototypeOf(result)).toBe(null);
    expect(Object.getPrototypeOf(result.tombstone)).toBe(null);
    expect(Object.isFrozen(result.deletionWatermarks)).toBe(true);
    (backend.state.candidate.tombstone as { operationId: string }).operationId = 'store-mutated-after-return';
    expect(result.tombstone.operationId).toBe('operation-delete-1');
    expect(() => {
      (result.purgeBoundary as { commitOrdinal: string }).commitOrdinal = '999';
    }).toThrow();
    expect(handle.backend.snapshot().boundary.commitOrdinal).toBe('10');
  });

  it(`exposes the coordinator from the Sync public entry ${evidence}`, () => {
    expect(coordinateFromSyncEntry).toBe(coordinateTombstonePurge);
  });
});
