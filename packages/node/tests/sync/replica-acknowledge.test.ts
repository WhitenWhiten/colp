import { describe, expect, it } from 'vitest';

import {
  asReplicaAuthenticatedCommand,
  coordinateReplicaLifecycle,
  type DurableReplicaCheckpoint,
  type ReplicaLifecycleCommand,
  type ReplicaLifecycleCoordinatorResult,
  type ReplicaLifecycleUnitOfWork,
} from '../../src/sync/index.js';
import { createTestReplicaAuthProof } from '../../src/testing/index.js';

const evidence = '[evidence:sync.replica-lifecycle]';
const key = { replicaId: 'replica-1', collectionId: 'collection-1' };
const future = '2026-07-18T02:00:00Z';

function checkpoint(overrides: Partial<DurableReplicaCheckpoint> = {}): DurableReplicaCheckpoint {
  return {
    replicaId: 'replica-1', collectionId: 'collection-1', leaseId: 'lease-1', generation: 'generation-1',
    lastSeenAt: '2026-07-18T00:00:00Z', leaseExpiresAt: future,
    acknowledgedCursor: 'cursor-10', acknowledgedCommitOrdinal: '10', lifecycle: 'active',
    ...overrides,
  };
}

/** Minimal durable Replica store that counts checkpoint writes. */
function replicaStore(initial: DurableReplicaCheckpoint) {
  const state = { replica: initial, writes: 0 };
  const unitOfWork: ReplicaLifecycleUnitOfWork = {
    async execute(_replicaId, work) {
      let draft = structuredClone(state.replica);
      let writes = 0;
      const result = await work({
        loadReplica: async () => structuredClone(draft),
        saveReplica: async (next) => { draft = structuredClone(next); writes += 1; },
        readAuthoritativeTime: async () => '2026-07-18T01:30:00Z',
        loadRetentionWindow: async () => { throw new Error('acknowledge must not read the retention window'); },
        loadAuthoritativeSnapshot: async () => undefined,
        saveSnapshotAck: async () => undefined,
        loadSnapshotAck: async () => undefined,
      });
      state.replica = draft;
      state.writes += writes;
      return result;
    },
  };
  return { state, unitOfWork };
}

type Acknowledge = Extract<ReplicaLifecycleCommand, { readonly type: 'acknowledge' }>;

function acknowledge(
  store: ReturnType<typeof replicaStore>,
  cursor: string,
  commitOrdinal: string,
  flags: Partial<Pick<Acknowledge, 'authenticated' | 'succeeded'>> = {},
): Promise<ReplicaLifecycleCoordinatorResult> {
  const input = { type: 'acknowledge' as const, cursor, commitOrdinal, succeeded: flags.succeeded ?? true };
  return coordinateReplicaLifecycle(store.unitOfWork, key, flags.authenticated === false
    ? { ...input, authenticated: false }
    : asReplicaAuthenticatedCommand(input, createTestReplicaAuthProof()));
}

describe(`Replica Pull acknowledgement ${evidence}`, () => {
  it('advances the acknowledgement of an active Replica and never moves it back', async () => {
    const store = replicaStore(checkpoint());
    await expect(acknowledge(store, 'cursor-25', '25')).resolves.toMatchObject({
      state: 'committed',
      checkpoint: {
        acknowledgedCursor: 'cursor-25', acknowledgedCommitOrdinal: '25',
        lastSeenAt: '2026-07-18T01:30:00Z', leaseExpiresAt: future, lifecycle: 'active',
      },
    });
    expect(store.state.writes).toBe(1);

    // A retried or reordered older acknowledgement is accepted without a write.
    for (const [cursor, ordinal] of [['cursor-12', '12'], ['cursor-25', '25']] as const) {
      await expect(acknowledge(store, cursor, ordinal))
        .resolves.toMatchObject({ state: 'committed', checkpoint: { acknowledgedCommitOrdinal: '25' } });
    }
    expect(store.state.writes).toBe(1);
    await expect(acknowledge(store, 'cursor-other', '25')).rejects.toThrow('conflicts with the stored Cursor');
  });

  it('compares positions numerically and records a first acknowledgement', async () => {
    const store = replicaStore(checkpoint({ acknowledgedCursor: null, acknowledgedCommitOrdinal: null }));
    await expect(acknowledge(store, 'cursor-0', '0'))
      .resolves.toMatchObject({ checkpoint: { acknowledgedCursor: 'cursor-0', acknowledgedCommitOrdinal: '0' } });
    await acknowledge(store, 'cursor-9', '9');
    await expect(acknowledge(store, 'cursor-10', '10'))
      .resolves.toMatchObject({ checkpoint: { acknowledgedCommitOrdinal: '10' } });
    expect(store.state.writes).toBe(3);
  });

  it('refuses unauthenticated, failed, malformed and non-active acknowledgements without a write', async () => {
    const store = replicaStore(checkpoint());
    await expect(acknowledge(store, 'cursor-25', '25', { authenticated: false }))
      .resolves.toMatchObject({ state: 'denied', code: 'unauthorized' });
    await expect(acknowledge(store, 'cursor-25', '25', { succeeded: false }))
      .resolves.toMatchObject({ state: 'denied', code: 'request_failed' });
    await expect(acknowledge(store, 'cursor-25', '025')).rejects.toThrow('canonical non-negative decimal');
    await expect(acknowledge(store, ' ', '25')).rejects.toThrow('non-empty');
    expect(store.state.writes).toBe(0);

    const expired = replicaStore(checkpoint({ lifecycle: 'expired' }));
    await expect(acknowledge(expired, 'cursor-25', '25')).resolves.toMatchObject({
      state: 'denied', code: 'stale_replica', checkpoint: { acknowledgedCommitOrdinal: '10' },
    });
    expect(expired.state.writes).toBe(0);
  });
});
