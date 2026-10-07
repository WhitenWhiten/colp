/**
 * Replica lease expiry under transaction-authoritative time, through the
 * public host: a lapsed or non-extending request is a typed denial that
 * does not apply the requested change; automatic expiry remains durable.
 * Malformed input still throws.
 */
import { describe, expect, it } from 'vitest';

import {
  createSyncHost,
  type AuthoritativeSnapshotBinding,
  type DurableReplicaCheckpoint,
  type ReplicaAuthenticatedLifecycleCommandInput,
  type ReplicaLifecycleTransaction,
  type ReplicaLifecycleUnitOfWork,
  type ReplicaRetentionWindow,
  type ReplicaSnapshotAck,
} from '../../src/sync/index.js';
import { verifiedSession } from './verified-session-fixture.js';

const now = '2026-07-18T02:00:00Z';
const currentExpiry = '2026-07-18T03:00:00Z';
const key = { replicaId: 'replica-1', collectionId: 'collection-1' } as const;

interface State {
  replica: DurableReplicaCheckpoint | undefined;
  acks: Map<string, ReplicaSnapshotAck>;
}

class DurableLifecycle implements ReplicaLifecycleUnitOfWork {
  state: State = { replica: undefined, acks: new Map() };
  window: ReplicaRetentionWindow = {
    collectionId: 'collection-1',
    earliestPull: { cursor: 'c-0', commitOrdinal: '0' },
    purgedThrough: { cursor: null, commitOrdinal: '0' },
    snapshotUrl: 'https://snapshots.example.com/collection-1',
  };
  readonly snapshot: AuthoritativeSnapshotBinding = {
    snapshotId: 'snapshot-1', collectionId: 'collection-1', revision: 'r9', cursor: 'c-9', commitOrdinal: '9',
  };
  writes: string[] = [];

  async execute<Value>(_replicaId: string, work: (transaction: ReplicaLifecycleTransaction) => Promise<Value>) {
    const draft: State = structuredClone(this.state);
    const pending: string[] = [];
    const transaction: ReplicaLifecycleTransaction = {
      loadReplica: async () => structuredClone(draft.replica),
      saveReplica: async (checkpoint) => { pending.push(`replica:${checkpoint.lifecycle}`); draft.replica = structuredClone(checkpoint); },
      readAuthoritativeTime: async () => now,
      loadRetentionWindow: async () => structuredClone(this.window),
      loadAuthoritativeSnapshot: async (id) => (id === this.snapshot.snapshotId ? structuredClone(this.snapshot) : undefined),
      saveSnapshotAck: async (ack) => { pending.push('ack'); draft.acks.set(ack.replicaId, structuredClone(ack)); },
      loadSnapshotAck: async (replicaId) => structuredClone(draft.acks.get(replicaId)),
    };
    const result = await work(transaction);
    this.state = draft;
    this.writes.push(...pending);
    return result;
  }

  seed(overrides: Partial<DurableReplicaCheckpoint> = {}): void {
    this.state.replica = {
      replicaId: 'replica-1', collectionId: 'collection-1', leaseId: 'lease-1', generation: 'g1',
      lastSeenAt: '2026-07-18T01:00:00Z', leaseExpiresAt: currentExpiry,
      acknowledgedCursor: 'c-1', acknowledgedCommitOrdinal: '1', lifecycle: 'active', ...overrides,
    };
  }
}

async function replica(lifecycle: DurableLifecycle, command: ReplicaAuthenticatedLifecycleCommandInput) {
  const session = await verifiedSession('session-1', {
    authorizationScopes: ['collections:create', 'sync:bootstrap', 'sync:pull', 'sync:push'],
  });
  return (await createSyncHost({
    owner: 'push',
    session,
    ownershipVerifier: () => true,
  }).replica(lifecycle, key, command)).result;
}

const fresh = { leaseId: 'lease-2', generation: 'g2', succeeded: true } as const;

describe('Replica lease expiry against authoritative time', () => {
  it.each([
    ['equal to authoritative time', now],
    ['already elapsed', '2026-07-18T01:59:59Z'],
  ])('denies registration whose expiry is %s and creates no Replica', async (_label, leaseExpiresAt) => {
    const lifecycle = new DurableLifecycle();
    expect(await replica(lifecycle, { type: 'register', collectionId: 'collection-1', ...fresh, leaseExpiresAt }))
      .toEqual({ state: 'denied', code: 'invalid_lease_expiry' });
    expect(lifecycle.state.replica).toBeUndefined();
    expect(lifecycle.writes).toEqual([]);
  });

  it.each([
    ['equal to authoritative time', now],
    ['already elapsed', '2026-07-18T01:00:00Z'],
    ['not extending the current lease', currentExpiry],
    ['shortening the current lease', '2026-07-18T02:30:00Z'],
  ])('denies renewal %s without mutating the lease', async (_label, leaseExpiresAt) => {
    const lifecycle = new DurableLifecycle();
    lifecycle.seed();
    const before = structuredClone(lifecycle.state.replica);
    expect(await replica(lifecycle, { type: 'renew', succeeded: true, leaseExpiresAt }))
      .toMatchObject({ state: 'denied', code: 'invalid_lease_expiry', checkpoint: before });
    expect(lifecycle.state.replica).toEqual(before);
    expect(lifecycle.writes).toEqual([]);
  });

  it('commits a renewal that strictly extends the lease beyond authoritative time', async () => {
    const lifecycle = new DurableLifecycle();
    lifecycle.seed();
    const leaseExpiresAt = '2026-07-18T03:00:01Z';
    expect(await replica(lifecycle, { type: 'renew', succeeded: true, leaseExpiresAt }))
      .toMatchObject({ state: 'committed', checkpoint: { leaseExpiresAt, lastSeenAt: now, lifecycle: 'active' } });
    expect(lifecycle.writes).toEqual(['replica:active']);
  });

  it('denies a lapsed resume before the retention decision, writing no recovery transition', async () => {
    const lifecycle = new DurableLifecycle();
    lifecycle.seed({ lifecycle: 'expired', leaseExpiresAt: '2026-07-18T01:30:00Z' });
    lifecycle.window = { ...lifecycle.window, earliestPull: { cursor: 'c-5', commitOrdinal: '5' } };
    expect(await replica(lifecycle, { type: 'resume', ...fresh, leaseExpiresAt: now }))
      .toMatchObject({ state: 'denied', code: 'invalid_lease_expiry', checkpoint: { lifecycle: 'expired' } });
    expect(lifecycle.writes).toEqual([]);

    expect(await replica(lifecycle, { type: 'resume', ...fresh, leaseExpiresAt: currentExpiry }))
      .toMatchObject({ state: 'denied', code: 'stale_replica' });
    expect(lifecycle.writes).toEqual(['replica:recovery_required']);
  });

  it('persists automatic expiry once when an active Replica resumes with an invalid new lease', async () => {
    const lifecycle = new DurableLifecycle();
    lifecycle.seed({ leaseExpiresAt: '2026-07-18T01:30:00Z' });
    const before = structuredClone(lifecycle.state.replica);
    const command = { type: 'resume' as const, ...fresh, leaseExpiresAt: now };
    expect(await replica(lifecycle, command))
      .toMatchObject({ state: 'denied', code: 'invalid_lease_expiry', checkpoint: { lifecycle: 'expired' } });
    expect(lifecycle.state.replica).toEqual({ ...before, lifecycle: 'expired' });
    expect(lifecycle.writes).toEqual(['replica:expired']);
    expect(lifecycle.state.acks.size).toBe(0);

    expect(await replica(lifecycle, command))
      .toMatchObject({ state: 'denied', code: 'invalid_lease_expiry' });
    expect(lifecycle.writes).toEqual(['replica:expired']);

    expect(await replica(lifecycle, { ...command, leaseExpiresAt: currentExpiry }))
      .toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'active', leaseId: fresh.leaseId } });
    expect(lifecycle.writes).toEqual(['replica:expired', 'replica:active']);
  });

  it('resumes with a valid fresh lease', async () => {
    const lifecycle = new DurableLifecycle();
    lifecycle.seed({ lifecycle: 'expired', leaseExpiresAt: '2026-07-18T01:30:00Z' });
    expect(await replica(lifecycle, { type: 'resume', ...fresh, leaseExpiresAt: currentExpiry }))
      .toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'active', leaseId: 'lease-2' } });
  });

  it('denies a lapsed recovery completion without persisting the Snapshot Ack', async () => {
    const lifecycle = new DurableLifecycle();
    lifecycle.seed({ lifecycle: 'recovery_required' });
    expect(await replica(lifecycle, { type: 'complete_recovery', snapshotId: 'snapshot-1', ...fresh, leaseExpiresAt: now }))
      .toMatchObject({ state: 'denied', code: 'invalid_lease_expiry', checkpoint: { lifecycle: 'recovery_required' } });
    expect(lifecycle.state.acks.size).toBe(0);
    expect(lifecycle.writes).toEqual([]);
  });

  it('keeps malformed expiries as input-contract errors', async () => {
    const lifecycle = new DurableLifecycle();
    lifecycle.seed();
    await expect(replica(lifecycle, { type: 'renew', succeeded: true, leaseExpiresAt: 'tomorrow' }))
      .rejects.toThrow(new TypeError('Lease expiry must be an RFC 3339 date-time with a known offset.'));
    expect(lifecycle.writes).toEqual([]);
  });
});
