/**
 * F024/F116 — Replica lifecycle authentication gate.
 *
 * `require_recovery` is a host command and must pass the shared
 * `denyUnlessAuthorizedRequest` gate like register/resume/complete_recovery/
 * renew/retire. `expire` is not a host command at all: due-lease expiry is a
 * system-initiated scan that only confirms an already-elapsed lease, exposed
 * through {@link coordinateReplicaDueExpiry} with no command payload.
 */

import { describe, expect, it } from 'vitest';

import {
  coordinateReplicaDueExpiry,
  coordinateReplicaLifecycle,
  type DurableReplicaCheckpoint,
  type ReplicaLifecycleKey,
  type ReplicaLifecycleTransaction,
  type ReplicaLifecycleUnitOfWork,
  asReplicaAuthenticatedCommand,
} from '../../src/sync/index.js';
import { createTestReplicaAuthProof } from '../../src/testing/index.js';

const evidence = '[evidence:sync.replica-lifecycle]';
const now = '2026-07-18T01:00:00Z';
const future = '2026-07-18T02:00:00Z';
const key = Object.freeze({ replicaId: 'replica-1', collectionId: 'collection-1' }) satisfies ReplicaLifecycleKey;

function checkpoint(overrides: Partial<DurableReplicaCheckpoint> = {}): DurableReplicaCheckpoint {
  return {
    replicaId: 'replica-1',
    collectionId: 'collection-1',
    leaseId: 'lease-old',
    generation: 'generation-old',
    lastSeenAt: '2026-07-18T00:00:00Z',
    leaseExpiresAt: future,
    acknowledgedCursor: 'cursor-10',
    acknowledgedCommitOrdinal: '10',
    lifecycle: 'active',
    ...overrides,
  };
}

/** Minimal Map-backed durable adapter with transaction-local drafts. */
class MemoryLifecycleHandle implements ReplicaLifecycleUnitOfWork {
  authoritativeTime = now;
  readonly replicas = new Map<string, DurableReplicaCheckpoint>();
  readonly writes: string[] = [];

  constructor(initial: DurableReplicaCheckpoint = checkpoint()) {
    this.replicas.set(initial.replicaId, structuredClone(initial));
  }

  async execute<Value>(
    _replicaId: string,
    work: (transaction: ReplicaLifecycleTransaction) => Promise<Value>,
  ): Promise<Value> {
    const draft = new Map([...this.replicas].map(([id, value]) => [id, structuredClone(value)]));
    const result = await work({
      readAuthoritativeTime: async () => this.authoritativeTime,
      loadReplica: async (replicaId) => {
        const stored = draft.get(replicaId);
        return stored === undefined ? undefined : structuredClone(stored);
      },
      saveReplica: async (value) => {
        this.writes.push('write:replica');
        draft.set(value.replicaId, structuredClone(value));
      },
      loadRetentionWindow: async () => ({
        collectionId: 'collection-1',
        earliestPull: { cursor: 'wire-z', commitOrdinal: '8' },
        purgedThrough: { cursor: 'wire-a', commitOrdinal: '9' },
        snapshotUrl: 'https://sync.example/snapshots/current',
      }),
      loadAuthoritativeSnapshot: async () => undefined,
      saveSnapshotAck: async () => undefined,
      loadSnapshotAck: async () => undefined,
    });
    this.replicas.clear();
    for (const [id, value] of draft) this.replicas.set(id, value);
    return result;
  }

  snapshot(): ReadonlyMap<string, DurableReplicaCheckpoint> {
    return new Map([...this.replicas].map(([id, value]) => [id, structuredClone(value)]));
  }
}

describe(`SYNC-0009 Replica lifecycle authentication gate ${evidence}`, () => {
  it(`denies an unauthenticated require_recovery without any lease writes ${evidence}`, async () => {
    const handle = new MemoryLifecycleHandle();
    const before = handle.snapshot();
    await expect(coordinateReplicaLifecycle(handle, key, {
      type: 'require_recovery', authenticated: false, succeeded: true,
    })).resolves.toMatchObject({
      state: 'denied', code: 'unauthorized', checkpoint: { lifecycle: 'active' },
    });
    expect([...handle.snapshot().values()]).toEqual([...before.values()]);
    expect(handle.writes).toEqual([]);
  });

  it(`denies a failed require_recovery request without any lease writes ${evidence}`, async () => {
    const handle = new MemoryLifecycleHandle();
    const before = handle.snapshot();
    await expect(coordinateReplicaLifecycle(handle, key, asReplicaAuthenticatedCommand(
      { type: 'require_recovery', succeeded: false },
      createTestReplicaAuthProof(),
    ))).resolves.toMatchObject({
      state: 'denied', code: 'request_failed', checkpoint: { lifecycle: 'active' },
    });
    expect([...handle.snapshot().values()]).toEqual([...before.values()]);
    expect(handle.writes).toEqual([]);
  });

  it(`denies require_recovery carrying no authentication flags at all ${evidence}`, async () => {
    const handle = new MemoryLifecycleHandle();
    const before = handle.snapshot();
    await expect(coordinateReplicaLifecycle(handle, key, {
      type: 'require_recovery',
    } as never)).rejects.toThrow(/boolean|member|invalid/i);
    expect([...handle.snapshot().values()]).toEqual([...before.values()]);
    expect(handle.writes).toEqual([]);
  });

  it(`does not accept expire on the host command surface ${evidence}`, async () => {
    const handle = new MemoryLifecycleHandle();
    handle.authoritativeTime = future;
    const before = handle.snapshot();
    await expect(coordinateReplicaLifecycle(
      handle, key, { type: 'expire' } as never,
    )).rejects.toThrow(/host|system|invalid/i);
    expect([...handle.snapshot().values()]).toEqual([...before.values()]);
    expect(handle.writes).toEqual([]);
  });

  it(`commits a due lease expiry only through the system-initiated entry ${evidence}`, async () => {
    const handle = new MemoryLifecycleHandle();
    handle.authoritativeTime = future;
    await expect(coordinateReplicaDueExpiry(handle, key)).resolves.toMatchObject({
      state: 'committed', checkpoint: { lifecycle: 'expired' },
    });
    expect(handle.snapshot().get('replica-1')?.lifecycle).toBe('expired');
  });

  it(`denies the system due-expiry entry on a not-due Replica ${evidence}`, async () => {
    const handle = new MemoryLifecycleHandle();
    const before = handle.snapshot();
    await expect(coordinateReplicaDueExpiry(handle, key)).resolves.toMatchObject({
      state: 'denied', code: 'invalid_replica_state', checkpoint: { lifecycle: 'active' },
    });
    expect([...handle.snapshot().values()]).toEqual([...before.values()]);
    expect(handle.writes).toEqual([]);
  });
});
