import { describe, expect, it } from 'vitest';

import { coordinateReplicaLifecycle as coordinateFromSyncEntry } from '../../src/sync/index.js';
import {
  transitionReplicaLifecycle,
} from '../../src/sync/legacy.js';
import {
  asReplicaAuthenticatedCommand,
  coordinateReplicaDueExpiry,
  coordinateReplicaLifecycle,
  evaluateReplicaSyncBehavior,
  type AuthoritativeSnapshotBinding,
  type DurableReplicaCheckpoint,
  type ReplicaLifecycleCommand,
  type ReplicaAuthenticatedLifecycleCommandInput,
  type ReplicaLifecycleCoordinatorResult,
  type ReplicaLifecycleKey,
  type ReplicaLifecycleTransaction,
  type ReplicaLifecycleUnitOfWork,
  type ReplicaRetentionWindow,
  type ReplicaSnapshotAck,
  type ReplicaSyncBehavior,
} from '../../src/sync/index.js';
import { createUnverifiedReplicaAuthProofForTests } from '../../src/testing/index.js';

const evidence = '[evidence:sync.replica-lifecycle]';
const now = '2026-07-18T01:00:00Z';
const future = '2026-07-18T02:00:00Z';
const key = Object.freeze({ replicaId: 'replica-1', collectionId: 'collection-1' });

interface DurableState {
  replicas: Map<string, DurableReplicaCheckpoint>;
  acks: Map<string, ReplicaSnapshotAck>;
}

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

function cloneState(state: DurableState): DurableState {
  return {
    replicas: new Map([...state.replicas].map(([id, value]) => [id, structuredClone(value)])),
    acks: new Map([...state.acks].map(([id, value]) => [id, structuredClone(value)])),
  };
}

class SharedDurableBackend {
  state: DurableState;
  authoritativeTime = now;
  window: ReplicaRetentionWindow = {
    collectionId: 'collection-1',
    earliestPull: { cursor: 'wire-z', commitOrdinal: '8' },
    purgedThrough: { cursor: 'wire-a', commitOrdinal: '9' },
    snapshotUrl: 'https://sync.example/snapshots/current',
  };
  snapshots = new Map<string, AuthoritativeSnapshotBinding>([
    ['snapshot-1', {
      snapshotId: 'snapshot-1', collectionId: 'collection-1', revision: 'revision-40',
      cursor: 'cursor-40', commitOrdinal: '40',
    }],
  ]);

  constructor(initial?: DurableReplicaCheckpoint) {
    this.state = { replicas: new Map(), acks: new Map() };
    if (initial !== undefined) this.state.replicas.set(initial.replicaId, structuredClone(initial));
  }

  snapshot(): DurableState {
    return cloneState(this.state);
  }
}

type ExecuteMode = 'normal' | 'zero' | 'twice' | 'forged' | 'sync';
type PortMode = 'normal' | 'sync-time' | 'sync-load' | 'sync-save' | 'sync-window' | 'sync-snapshot' | 'sync-ack-save' | 'sync-ack-load';

/**
 * Staged adapter-contract fixture. Shared handles see committed drafts, while callback failure
 * discards the draft. This deliberately cannot prove cross-process serialization or durability.
 */
class DurableLifecycleHandle implements ReplicaLifecycleUnitOfWork {
  executeMode: ExecuteMode = 'normal';
  portMode: PortMode = 'normal';
  ignoreReplicaWrite = false;
  ignoreAckWrite = false;
  mismatchReplicaReadback = false;
  mismatchAckReadback = false;
  mutatePortInputs = false;
  throwAfterAck = false;
  rejectAfterCommit = false;
  readonly trace: string[] = [];

  constructor(readonly backend = new SharedDurableBackend(checkpoint())) {}

  execute<Value>(
    replicaId: string,
    work: (transaction: ReplicaLifecycleTransaction) => Promise<Value>,
  ): Promise<Value> {
    if (this.executeMode === 'sync') return undefined as never;
    if (this.executeMode === 'zero') return Promise.resolve(undefined as Value);
    const draft = cloneState(this.backend.state);
    const transaction = this.transaction(draft);
    const run = async (): Promise<Value> => {
      this.trace.push(`tx:${replicaId}:begin`);
      const result = await work(transaction);
      if (this.executeMode === 'twice') await work(transaction);
      this.backend.state = draft;
      this.trace.push('tx:commit');
      if (this.rejectAfterCommit) throw new Error('commit outcome unknown');
      return this.executeMode === 'forged' ? ({ state: 'denied', code: 'request_failed' } as Value) : result;
    };
    return run();
  }

  transaction(draft: DurableState): ReplicaLifecycleTransaction {
    let replicaLoads = 0;
    let ackLoads = 0;
    const mutate = (value: object): void => {
      if (this.mutatePortInputs) Object.assign(value, { adapterMutation: true });
    };
    const transaction: ReplicaLifecycleTransaction = {
      readAuthoritativeTime: async () => {
        this.trace.push('read:time');
        return this.backend.authoritativeTime;
      },
      loadReplica: async (replicaId) => {
        replicaLoads += 1;
        this.trace.push(`read:replica:${replicaLoads}`);
        const stored = draft.replicas.get(replicaId);
        if (stored === undefined) return undefined;
        return structuredClone(this.mismatchReplicaReadback && replicaLoads > 1
          ? { ...stored, generation: 'forged-generation' }
          : stored);
      },
      saveReplica: async (value) => {
        const stored = structuredClone(value);
        mutate(value);
        this.trace.push('write:replica');
        if (!this.ignoreReplicaWrite) draft.replicas.set(stored.replicaId, stored);
      },
      loadRetentionWindow: async (collectionId) => {
        this.trace.push(`read:window:${collectionId}`);
        return structuredClone(this.backend.window);
      },
      loadAuthoritativeSnapshot: async (snapshotId) => {
        this.trace.push(`read:snapshot:${snapshotId}`);
        const value = this.backend.snapshots.get(snapshotId);
        return value === undefined ? undefined : structuredClone(value);
      },
      saveSnapshotAck: async (value) => {
        const stored = structuredClone(value);
        mutate(value);
        this.trace.push('write:ack');
        if (!this.ignoreAckWrite) draft.acks.set(stored.replicaId, stored);
        if (this.throwAfterAck) throw new Error('injected transaction callback failure');
      },
      loadSnapshotAck: async (replicaId) => {
        ackLoads += 1;
        this.trace.push(`read:ack:${ackLoads}`);
        const stored = draft.acks.get(replicaId);
        if (stored === undefined) return undefined;
        return structuredClone(this.mismatchAckReadback
          ? { ...stored, revision: 'forged-revision' }
          : stored);
      },
    };
    const syncValue = <T>(value: T): Promise<T> => value as never;
    if (this.portMode === 'sync-time') transaction.readAuthoritativeTime = () => syncValue(this.backend.authoritativeTime);
    if (this.portMode === 'sync-load') transaction.loadReplica = (replicaId) => syncValue(draft.replicas.get(replicaId));
    if (this.portMode === 'sync-save') transaction.saveReplica = () => syncValue(undefined);
    if (this.portMode === 'sync-window') transaction.loadRetentionWindow = () => syncValue(this.backend.window);
    if (this.portMode === 'sync-snapshot') transaction.loadAuthoritativeSnapshot = (id) => syncValue(this.backend.snapshots.get(id));
    if (this.portMode === 'sync-ack-save') transaction.saveSnapshotAck = () => syncValue(undefined);
    if (this.portMode === 'sync-ack-load') transaction.loadSnapshotAck = () => syncValue(undefined);
    return transaction;
  }
}

class CompositeKeyLifecycleHandle implements ReplicaLifecycleUnitOfWork {
  readonly replicas = new Map<string, DurableReplicaCheckpoint>();

  constructor(initial: DurableReplicaCheckpoint) {
    this.replicas.set(`${initial.replicaId}:${initial.collectionId}`, structuredClone(initial));
  }

  execute<Value>(
    replicaId: string,
    work: (transaction: ReplicaLifecycleTransaction) => Promise<Value>,
  ): Promise<Value> {
    return work({
      loadReplica: async () => {
        const stored = [...this.replicas.values()].find((checkpoint) => checkpoint.replicaId === replicaId);
        return stored === undefined ? undefined : structuredClone(stored);
      },
      saveReplica: async (value) => {
        this.replicas.set(`${value.replicaId}:${value.collectionId}`, structuredClone(value));
      },
      readAuthoritativeTime: async () => now,
      loadRetentionWindow: async () => new SharedDurableBackend().window,
      loadAuthoritativeSnapshot: async () => undefined,
      saveSnapshotAck: async () => undefined,
      loadSnapshotAck: async () => undefined,
    });
  }
}

type ReplicaLifecycleTestCommand =
  | ReplicaLifecycleCommand
  | ReplicaAuthenticatedLifecycleCommandInput
  | { readonly type: 'expire' };

const replicaTestAuthProof = createUnverifiedReplicaAuthProofForTests();
const authenticatedLifecycleTypes = new Set<ReplicaAuthenticatedLifecycleCommandInput['type']>([
  'register',
  'require_recovery',
  'resume',
  'complete_recovery',
  'renew',
  'retire',
]);

function authenticatedResumeCommand(overrides: Partial<Extract<ReplicaAuthenticatedLifecycleCommandInput, { type: 'resume' }>> = {}): ReplicaAuthenticatedLifecycleCommandInput {
  return { type: 'resume', leaseId: 'lease-new', generation: 'generation-new', leaseExpiresAt: future, succeeded: true, ...overrides };
}

function authenticatedBootstrapCommand(overrides: Partial<Extract<ReplicaAuthenticatedLifecycleCommandInput, { type: 'complete_recovery' }>> = {}): ReplicaAuthenticatedLifecycleCommandInput {
  return { type: 'complete_recovery', snapshotId: 'snapshot-1', leaseId: 'lease-new', generation: 'generation-new', leaseExpiresAt: future, succeeded: true, ...overrides };
}

async function coordinate(
  handle: ReplicaLifecycleUnitOfWork = new DurableLifecycleHandle(),
  lifecycleCommand: ReplicaLifecycleTestCommand = { type: 'expire' },
  lifecycleKey: ReplicaLifecycleKey = key,
): Promise<ReplicaLifecycleCoordinatorResult> {
  // F024: 'expire' is the system-initiated due-expiry entry, not a host command.
  if (lifecycleCommand.type === 'expire') {
    return coordinateReplicaDueExpiry(handle, lifecycleKey);
  }
  if (
    authenticatedLifecycleTypes.has(lifecycleCommand.type as ReplicaAuthenticatedLifecycleCommandInput['type'])
    && !Object.prototype.hasOwnProperty.call(lifecycleCommand, 'authenticated')
  ) {
    const authenticated = asReplicaAuthenticatedCommand(
      lifecycleCommand as ReplicaAuthenticatedLifecycleCommandInput,
      replicaTestAuthProof,
    );
    return coordinateReplicaLifecycle(handle, lifecycleKey, authenticated);
  }
  return coordinateReplicaLifecycle(handle, lifecycleKey, lifecycleCommand as ReplicaLifecycleCommand);
}

function writes(handle: DurableLifecycleHandle): string[] {
  return handle.trace.filter((entry) => entry.startsWith('write:'));
}

describe(`SYNC-0009 durable Replica lifecycle coordinator ${evidence}`, () => {
  it(`registers a new Replica directly into active with authoritative lastSeenAt ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend());
    const result = await coordinate(handle, { type: 'register', collectionId: 'collection-1', leaseId: 'lease-1', generation: 'generation-1', leaseExpiresAt: future, succeeded: true });
    expect(result).toEqual({ state: 'committed', checkpoint: checkpoint({ leaseId: 'lease-1', generation: 'generation-1', lastSeenAt: now, acknowledgedCursor: null, acknowledgedCommitOrdinal: null }) });
    expect(handle.backend.snapshot().replicas.get('replica-1')).toEqual(result.state === 'committed' ? result.checkpoint : undefined);
  });

  it(`rejects a hand-written authenticated: true and a copied authenticated command ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend());
    const register = {
      type: 'register' as const,
      collectionId: 'collection-1',
      leaseId: 'lease-1',
      generation: 'generation-1',
      leaseExpiresAt: future,
      succeeded: true,
    };
    await expect(coordinateReplicaLifecycle(handle, key, { ...register, authenticated: true }))
      .rejects.toThrow('asReplicaAuthenticatedCommand');
    const minted = asReplicaAuthenticatedCommand(register, createUnverifiedReplicaAuthProofForTests());
    await expect(coordinateReplicaLifecycle(handle, key, { ...minted }))
      .rejects.toThrow('asReplicaAuthenticatedCommand');
    expect(writes(handle)).toEqual([]);
    await expect(coordinateReplicaLifecycle(handle, key, { ...register, authenticated: false }))
      .resolves.toMatchObject({ state: 'denied', code: 'unauthorized' });
    await expect(coordinateReplicaLifecycle(handle, key, minted))
      .resolves.toMatchObject({ state: 'committed' });
  });

  it(`denies duplicate registration without a write ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    const before = handle.backend.snapshot();
    await expect(coordinate(handle, { type: 'register', collectionId: 'collection-1', leaseId: 'lease-2', generation: 'generation-2', leaseExpiresAt: future, succeeded: true })).resolves.toMatchObject({ state: 'denied', code: 'replica_exists' });
    expect(handle.backend.snapshot()).toEqual(before);
    expect(writes(handle)).toEqual([]);
  });

  it(`denies duplicate registration for expired and recovery_required without reactivation ${evidence}`, async () => {
    for (const lifecycle of ['expired', 'recovery_required'] as const) {
      const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle })));
      await expect(coordinate(handle, { type: 'register', collectionId: 'collection-1', leaseId: 'lease-2', generation: 'generation-2', leaseExpiresAt: future, succeeded: true })).resolves.toMatchObject({ state: 'denied', code: 'replica_exists', checkpoint: { lifecycle } });
      expect(writes(handle)).toEqual([]);
    }
  });

  it(`denies every non-registration command for an unknown Replica ${evidence}`, async () => {
    const commands: ReplicaLifecycleTestCommand[] = [{ type: 'expire' }, { type: 'require_recovery', succeeded: true }, authenticatedResumeCommand(), authenticatedBootstrapCommand(), { type: 'renew', succeeded: true, leaseExpiresAt: future }, { type: 'retire', succeeded: true }];
    for (const lifecycleCommand of commands) {
      const handle = new DurableLifecycleHandle(new SharedDurableBackend());
      await expect(coordinate(handle, lifecycleCommand)).resolves.toEqual({ state: 'denied', code: 'replica_not_found' });
      expect(writes(handle)).toEqual([]);
    }
  });

  it(`does not expire an active lease just before its authoritative deadline ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.backend.authoritativeTime = '2026-07-18T01:59:59.999Z';
    await expect(coordinate(handle)).resolves.toMatchObject({ state: 'denied', code: 'invalid_replica_state', checkpoint: { lifecycle: 'active' } });
    expect(writes(handle)).toEqual([]);
  });

  it(`expires an active lease exactly at its authoritative deadline ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.backend.authoritativeTime = future;
    await expect(coordinate(handle)).resolves.toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'expired' } });
    expect(handle.backend.snapshot().replicas.get('replica-1')?.lifecycle).toBe('expired');
  });

  it(`expires an active lease after its authoritative deadline ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.backend.authoritativeTime = '2026-07-18T02:00:00.001Z';
    await expect(coordinate(handle)).resolves.toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'expired' } });
  });

  it(`treats repeated expiration as an exact durable retry ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired' })));
    const before = handle.backend.snapshot();
    await expect(coordinate(handle)).resolves.toEqual({ state: 'committed', checkpoint: checkpoint({ lifecycle: 'expired' }) });
    expect(handle.backend.snapshot()).toEqual(before);
    expect(writes(handle)).toEqual([]);
  });

  it(`renews only an authenticated successful active request ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.backend.authoritativeTime = '2026-07-18T01:30:00Z';
    await expect(coordinate(handle, { type: 'renew', succeeded: true, leaseExpiresAt: '2026-07-18T03:00:00Z' })).resolves.toMatchObject({ state: 'committed', checkpoint: { lastSeenAt: '2026-07-18T01:30:00Z', leaseExpiresAt: '2026-07-18T03:00:00Z' } });
    expect(writes(handle)).toEqual(['write:replica']);
  });

  it(`an unauthorized request performs zero lease writes ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    const before = handle.backend.snapshot();
    await expect(coordinate(handle, { type: 'renew', authenticated: false, succeeded: true, leaseExpiresAt: '2026-07-18T03:00:00Z' })).resolves.toMatchObject({ state: 'denied', code: 'unauthorized' });
    expect(handle.backend.snapshot()).toEqual(before);
    expect(writes(handle)).toEqual([]);
  });

  it(`a failed authenticated request performs zero lease writes ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    const before = handle.backend.snapshot();
    await expect(coordinate(handle, { type: 'renew', succeeded: false, leaseExpiresAt: '2026-07-18T03:00:00Z' })).resolves.toMatchObject({ state: 'denied', code: 'request_failed' });
    expect(handle.backend.snapshot()).toEqual(before);
    expect(writes(handle)).toEqual([]);
  });

  it(`does not let Session-shaped input alter the independent Replica lease ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    const malformed = { type: 'renew', succeeded: true, leaseExpiresAt: '2026-07-18T03:00:00Z', sessionExpiresAt: '2099-01-01T00:00:00Z' } as never;
    await expect(coordinate(handle, malformed)).rejects.toThrow(/unknown member/i);
    expect(writes(handle)).toEqual([]);
  });

  it(`rejects renewal that does not extend the existing Replica lease ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    await expect(coordinate(handle, { type: 'renew', succeeded: true, leaseExpiresAt: future }))
      .resolves.toMatchObject({ state: 'denied', code: 'invalid_lease_expiry', checkpoint: { lifecycle: 'active' } });
    expect(writes(handle)).toEqual([]);
  });

  it(`denies renewal at the deadline after durably expiring the Replica ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.backend.authoritativeTime = future;
    await expect(coordinate(handle, { type: 'renew', succeeded: true, leaseExpiresAt: '2026-07-18T03:00:00Z' })).resolves.toMatchObject({ state: 'denied', code: 'stale_replica', checkpoint: { lifecycle: 'expired' } });
    expect(writes(handle)).toEqual(['write:replica']);
  });

  it(`moves active directly to recovery_required when the retained window is lost ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    await expect(coordinate(handle, { type: 'require_recovery', succeeded: true })).resolves.toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'recovery_required' } });
  });

  it(`moves expired directly to recovery_required ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired' })));
    await expect(coordinate(handle, { type: 'require_recovery', succeeded: true })).resolves.toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'recovery_required' } });
  });

  it(`denies every illegal expired and recovery_required transition edge ${evidence}`, async () => {
    const cases: readonly [DurableReplicaCheckpoint['lifecycle'], ReplicaLifecycleTestCommand, string][] = [
      ['expired', authenticatedBootstrapCommand(), 'invalid_replica_state'],
      ['expired', { type: 'renew', succeeded: true, leaseExpiresAt: '2026-07-18T03:00:00Z' }, 'stale_replica'],
      ['recovery_required', { type: 'expire' }, 'invalid_replica_state'],
      ['recovery_required', authenticatedResumeCommand(), 'invalid_replica_state'],
      ['recovery_required', { type: 'renew', succeeded: true, leaseExpiresAt: '2026-07-18T03:00:00Z' }, 'stale_replica'],
    ];
    for (const [lifecycle, lifecycleCommand, code] of cases) {
      const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle })));
      await expect(coordinate(handle, lifecycleCommand)).resolves.toMatchObject({ state: 'denied', code, checkpoint: { lifecycle } });
      expect(writes(handle)).toEqual([]);
    }
  });

  it(`retires active expired and recovery_required Replicas ${evidence}`, async () => {
    for (const lifecycle of ['active', 'expired', 'recovery_required'] as const) {
      await expect(coordinate(new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle }))), { type: 'retire', succeeded: true })).resolves.toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'retired' } });
    }
  });

  it(`denies registration Session Push renew resume bootstrap and retirement after retirement ${evidence}`, async () => {
    const commands: ReplicaLifecycleTestCommand[] = [{ type: 'register', collectionId: 'collection-1', leaseId: 'x', generation: 'x', leaseExpiresAt: future, succeeded: true }, { type: 'expire' }, { type: 'require_recovery', succeeded: true }, authenticatedResumeCommand(), authenticatedBootstrapCommand(), { type: 'renew', succeeded: true, leaseExpiresAt: '2026-07-18T03:00:00Z' }, { type: 'retire', succeeded: true }];
    for (const lifecycleCommand of commands) {
      const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'retired' })));
      await expect(coordinate(handle, lifecycleCommand)).resolves.toMatchObject({ state: 'denied', code: 'replica_retired', checkpoint: { lifecycle: 'retired' } });
      expect(writes(handle)).toEqual([]);
    }
  });

  it(`never reactivates an old retired ID while a distinct ID can register ${evidence}`, async () => {
    const backend = new SharedDurableBackend(checkpoint({ lifecycle: 'retired' }));
    await expect(coordinate(new DurableLifecycleHandle(backend), { type: 'register', collectionId: 'collection-1', leaseId: 'new', generation: 'new', leaseExpiresAt: future, succeeded: true })).resolves.toMatchObject({ state: 'denied', code: 'replica_retired' });
    await expect(coordinate(new DurableLifecycleHandle(backend), { type: 'register', collectionId: 'collection-1', leaseId: 'lease-2', generation: 'generation-2', leaseExpiresAt: future, succeeded: true }, { replicaId: 'replica-2', collectionId: 'collection-1' })).resolves.toMatchObject({ state: 'committed', checkpoint: { replicaId: 'replica-2', lifecycle: 'active' } });
    expect(backend.snapshot().replicas.get('replica-1')?.lifecycle).toBe('retired');
  });

  it(`keeps a retired Replica ID terminal across Collections with a composite-key adapter ${evidence}`, async () => {
    const handle = new CompositeKeyLifecycleHandle(checkpoint({ lifecycle: 'retired' }));
    await expect(coordinate(handle, {
      type: 'register', collectionId: 'collection-2', leaseId: 'lease-new', generation: 'generation-new',
      leaseExpiresAt: future, succeeded: true,
    }, { replicaId: 'replica-1', collectionId: 'collection-2' })).resolves.toMatchObject({
      state: 'denied', code: 'replica_retired', checkpoint: { collectionId: 'collection-1', lifecycle: 'retired' },
    });
    expect(handle.replicas.size).toBe(1);

    await expect(coordinate(handle, {
      type: 'register', collectionId: 'collection-2', leaseId: 'lease-new', generation: 'generation-new',
      leaseExpiresAt: future, succeeded: true,
    }, { replicaId: 'replica-2', collectionId: 'collection-2' })).resolves.toMatchObject({
      state: 'committed', checkpoint: { replicaId: 'replica-2', collectionId: 'collection-2', lifecycle: 'active' },
    });
    expect(handle.replicas.size).toBe(2);
  });

  it(`fails closed when an active Replica ID is registered against another Collection ${evidence}`, async () => {
    const handle = new CompositeKeyLifecycleHandle(checkpoint());
    await expect(coordinate(handle, {
      type: 'register', collectionId: 'collection-2', leaseId: 'lease-new', generation: 'generation-new',
      leaseExpiresAt: future, succeeded: true,
    }, { replicaId: 'replica-1', collectionId: 'collection-2' })).resolves.toMatchObject({
      state: 'denied', code: 'replica_exists', checkpoint: { collectionId: 'collection-1', lifecycle: 'active' },
    });
    expect(handle.replicas.size).toBe(1);
  });

  it(`keeps a durably retired ID terminal across fresh handles and every recovery route ${evidence}`, async () => {
    const backend = new SharedDurableBackend(checkpoint());
    await expect(coordinate(new DurableLifecycleHandle(backend), {
      type: 'retire', succeeded: true,
    })).resolves.toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'retired' } });

    const laterCommands: ReplicaLifecycleTestCommand[] = [
      { type: 'register', collectionId: 'collection-1', leaseId: 'lease-new', generation: 'generation-new', leaseExpiresAt: future, succeeded: true },
      { type: 'renew', leaseExpiresAt: '2026-07-18T03:00:00Z', succeeded: true },
      authenticatedResumeCommand(),
      authenticatedBootstrapCommand(),
    ];
    for (const laterCommand of laterCommands) {
      await expect(coordinate(new DurableLifecycleHandle(backend), laterCommand)).resolves.toMatchObject({
        state: 'denied', code: 'replica_retired', checkpoint: { lifecycle: 'retired' },
      });
    }
    const persisted = backend.snapshot().replicas.get('replica-1')!;
    for (const behavior of ['establish_session', 'push'] as const) {
      expect(evaluateReplicaSyncBehavior({
        lifecycle: persisted.lifecycle,
        leaseExpiresAt: persisted.leaseExpiresAt,
      }, behavior, now)).toEqual({ allowed: false, code: 'replica_retired' });
    }
  });

  it(`resumes expired when Ack equals both authoritative window boundaries ${evidence}`, async () => {
    const initial = checkpoint({ lifecycle: 'expired', acknowledgedCommitOrdinal: '9' });
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(initial));
    handle.backend.window = { ...handle.backend.window, earliestPull: { cursor: 'cursor-any', commitOrdinal: '9' } };
    await expect(coordinate(handle, authenticatedResumeCommand())).resolves.toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'active', leaseId: 'lease-new', generation: 'generation-new', lastSeenAt: now } });
  });

  it(`marks stale when Ack is just before earliest retained Pull ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired', acknowledgedCommitOrdinal: '7' })));
    await expect(coordinate(handle, authenticatedResumeCommand())).resolves.toEqual({ state: 'denied', code: 'stale_replica', checkpoint: checkpoint({ lifecycle: 'recovery_required', acknowledgedCommitOrdinal: '7' }), snapshotUrl: handle.backend.window.snapshotUrl });
  });

  it(`marks stale when Ack is just before purged-through despite covering earliest Pull ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired', acknowledgedCommitOrdinal: '8' })));
    handle.backend.window = { ...handle.backend.window, earliestPull: { cursor: 'cursor-early', commitOrdinal: '7' } };
    await expect(coordinate(handle, authenticatedResumeCommand())).resolves.toMatchObject({ state: 'denied', code: 'stale_replica', checkpoint: { lifecycle: 'recovery_required' } });
  });

  it(`marks a never-acked expired Replica stale ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired', acknowledgedCursor: null, acknowledgedCommitOrdinal: null })));
    await expect(coordinate(handle, authenticatedResumeCommand())).resolves.toMatchObject({ state: 'denied', code: 'stale_replica', snapshotUrl: handle.backend.window.snapshotUrl });
  });

  it(`compares huge canonical ordinals without Number precision loss ${evidence}`, async () => {
    const huge = '99999999999999999999999999999999999999999999999999';
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired', acknowledgedCommitOrdinal: huge })));
    handle.backend.window = { ...handle.backend.window, earliestPull: { cursor: 'cursor-x', commitOrdinal: huge }, purgedThrough: { cursor: 'cursor-y', commitOrdinal: huge } };
    await expect(coordinate(handle, authenticatedResumeCommand())).resolves.toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'active' } });
  });

  it(`uses numeric commit ordinals instead of lexical decimal ordering ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired', acknowledgedCommitOrdinal: '10' })));
    handle.backend.window = { ...handle.backend.window, earliestPull: { cursor: 'z', commitOrdinal: '2' }, purgedThrough: { cursor: 'a', commitOrdinal: '9' } };
    await expect(coordinate(handle, authenticatedResumeCommand())).resolves.toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'active' } });
  });

  it(`never orders opaque wire Cursors when deciding window completeness ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired', acknowledgedCursor: 'cursor-aaa', acknowledgedCommitOrdinal: '10' })));
    handle.backend.window = { ...handle.backend.window, earliestPull: { cursor: 'cursor-zzz', commitOrdinal: '8' }, purgedThrough: { cursor: 'cursor-zzz', commitOrdinal: '9' } };
    await expect(coordinate(handle, authenticatedResumeCommand())).resolves.toMatchObject({ state: 'committed' });
  });

  it(`returns the authoritative Snapshot URL with stale_replica ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired', acknowledgedCommitOrdinal: '1' })));
    handle.backend.window = { ...handle.backend.window, snapshotUrl: 'https://authority.example/snapshot/required' };
    await expect(coordinate(handle, authenticatedResumeCommand())).resolves.toMatchObject({ state: 'denied', code: 'stale_replica', snapshotUrl: 'https://authority.example/snapshot/required' });
  });

  it(`denies old Queue Push and Ack behaviors for expired ${evidence}`, () => {
    for (const behavior of ['push', 'pull', 'ack', 'renew', 'bootstrap', 'establish_session'] as const) {
      expect(evaluateReplicaSyncBehavior({ lifecycle: 'expired', leaseExpiresAt: future }, behavior, now)).toEqual({ allowed: false, code: 'stale_replica' });
    }
    expect(evaluateReplicaSyncBehavior({ lifecycle: 'expired', leaseExpiresAt: future }, 'resume', now)).toEqual({ allowed: true });
  });

  it(`denies old Queue Push and all non-bootstrap behaviors for recovery_required ${evidence}`, () => {
    for (const behavior of ['push', 'pull', 'ack', 'renew', 'resume', 'establish_session'] as const) {
      expect(evaluateReplicaSyncBehavior({ lifecycle: 'recovery_required', leaseExpiresAt: future }, behavior, now)).toEqual({ allowed: false, code: 'stale_replica' });
    }
    expect(evaluateReplicaSyncBehavior({ lifecycle: 'recovery_required', leaseExpiresAt: future }, 'bootstrap', now)).toEqual({ allowed: true });
  });

  it(`allows active Pull Push Ack renew and Session establishment but not registration ${evidence}`, () => {
    for (const behavior of ['pull', 'push', 'ack', 'renew', 'establish_session'] as const) expect(evaluateReplicaSyncBehavior({ lifecycle: 'active', leaseExpiresAt: future }, behavior, now)).toEqual({ allowed: true });
    expect(evaluateReplicaSyncBehavior({ lifecycle: 'active', leaseExpiresAt: future }, 'register', now)).toEqual({ allowed: false, code: 'stale_replica' });
  });

  it(`denies every active behavior at the authoritative Replica lease deadline ${evidence}`, () => {
    for (const behavior of ['establish_session', 'pull', 'push', 'ack', 'renew'] as const) {
      expect(evaluateReplicaSyncBehavior({ lifecycle: 'active', leaseExpiresAt: future }, behavior, future)).toEqual({ allowed: false, code: 'stale_replica' });
    }
  });

  it(`returns replica_retired for every later Sync behavior ${evidence}`, () => {
    const behaviors: ReplicaSyncBehavior[] = ['establish_session', 'pull', 'push', 'ack', 'renew', 'resume', 'bootstrap', 'register'];
    for (const behavior of behaviors) expect(evaluateReplicaSyncBehavior({ lifecycle: 'retired', leaseExpiresAt: future }, behavior, now)).toEqual({ allowed: false, code: 'replica_retired' });
  });

  it(`atomically binds Snapshot revision Cursor ordinal Ack and fresh generation ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    const result = await coordinate(handle, authenticatedBootstrapCommand());
    expect(result).toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'active', acknowledgedCursor: 'cursor-40', acknowledgedCommitOrdinal: '40', leaseId: 'lease-new', generation: 'generation-new' } });
    expect(handle.backend.snapshot().acks.get('replica-1')).toEqual({ snapshotId: 'snapshot-1', collectionId: 'collection-1', revision: 'revision-40', cursor: 'cursor-40', commitOrdinal: '40', replicaId: 'replica-1', appliedAt: now });
    expect(handle.trace.indexOf('write:ack')).toBeLessThan(handle.trace.indexOf('write:replica'));
  });

  it(`denies recovery completion for an unknown authoritative Snapshot ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    await expect(coordinate(handle, authenticatedBootstrapCommand({ snapshotId: 'snapshot-missing' }))).resolves.toMatchObject({ state: 'denied', code: 'stale_replica' });
    expect(writes(handle)).toEqual([]);
  });

  it(`rejects a Snapshot binding from another Collection ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    handle.backend.snapshots.set('snapshot-1', { ...handle.backend.snapshots.get('snapshot-1')!, collectionId: 'collection-2' });
    await expect(coordinate(handle, authenticatedBootstrapCommand())).rejects.toThrow(/different|mismatched identity/i);
    expect(writes(handle)).toEqual([]);
  });

  it(`rejects a Snapshot store result for another Snapshot ID ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    handle.backend.snapshots.set('snapshot-1', { ...handle.backend.snapshots.get('snapshot-1')!, snapshotId: 'snapshot-other' });
    await expect(coordinate(handle, authenticatedBootstrapCommand())).rejects.toThrow(/mismatched identity/i);
  });

  it(`requires both a distinct lease ID and distinct generation on resume ${evidence}`, async () => {
    for (const lifecycleCommand of [authenticatedResumeCommand({ leaseId: 'lease-old' }), authenticatedResumeCommand({ generation: 'generation-old' })]) {
      const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired' })));
      await expect(coordinate(handle, lifecycleCommand)).rejects.toThrow(/fresh/i);
      expect(writes(handle)).toEqual([]);
    }
  });

  it(`requires both a distinct lease ID and distinct generation on bootstrap ${evidence}`, async () => {
    for (const lifecycleCommand of [authenticatedBootstrapCommand({ leaseId: 'lease-old' }), authenticatedBootstrapCommand({ generation: 'generation-old' })]) {
      const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
      await expect(coordinate(handle, lifecycleCommand)).rejects.toThrow(/fresh/i);
      expect(handle.backend.snapshot().acks.size).toBe(0);
      expect(handle.backend.snapshot().replicas.get('replica-1')?.lifecycle).toBe('recovery_required');
    }
  });

  it(`denies replaying resume after it already activated the Replica ${evidence}`, async () => {
    const backend = new SharedDurableBackend(checkpoint({ lifecycle: 'expired' }));
    await coordinate(new DurableLifecycleHandle(backend), authenticatedResumeCommand());
    await expect(coordinate(new DurableLifecycleHandle(backend), authenticatedResumeCommand())).resolves.toMatchObject({ state: 'denied', code: 'invalid_replica_state', checkpoint: { lifecycle: 'active' } });
  });

  it(`denies replaying old bootstrap after the atomic recovery commit ${evidence}`, async () => {
    const backend = new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' }));
    await coordinate(new DurableLifecycleHandle(backend), authenticatedBootstrapCommand());
    await expect(coordinate(new DurableLifecycleHandle(backend), authenticatedBootstrapCommand())).resolves.toMatchObject({ state: 'denied', code: 'invalid_replica_state', checkpoint: { lifecycle: 'active' } });
    expect(backend.snapshot().acks.size).toBe(1);
  });

  it(`rejects a retention window from another Collection without state change ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired' })));
    handle.backend.window = { ...handle.backend.window, collectionId: 'collection-2' };
    const before = handle.backend.snapshot();
    await expect(coordinate(handle, authenticatedResumeCommand())).rejects.toThrow(/different Collection/i);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`rejects a Replica store result for another Replica ID ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.backend.state.replicas.set('replica-other', checkpoint({ replicaId: 'replica-other' }));
    const malicious: ReplicaLifecycleUnitOfWork = {
      execute: (_key, work) => work({ ...handle.transaction(cloneState(handle.backend.state)), loadReplica: async () => checkpoint({ replicaId: 'replica-other' }) }),
    };
    await expect(coordinate(malicious)).rejects.toThrow(/mismatched Replica ID/i);
  });

  it(`rejects a Replica store result for another Collection ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    const malicious: ReplicaLifecycleUnitOfWork = {
      execute: (_key, work) => work({
        ...handle.transaction(cloneState(handle.backend.state)),
        loadReplica: async () => checkpoint({ collectionId: 'collection-other' }),
      }),
    };
    await expect(coordinate(malicious)).rejects.toThrow(/mismatched Collection ID/i);
  });

  it(`rejects registration when command and transaction key target different Collections ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend());
    await expect(coordinate(handle, {
      type: 'register', collectionId: 'collection-other', leaseId: 'lease-1', generation: 'generation-1',
      leaseExpiresAt: future, succeeded: true,
    })).rejects.toThrow(/mismatched Collection ID/i);
    expect(handle.trace).toEqual([]);
  });

  it(`rolls back Snapshot Ack when checkpoint persistence fails read-back ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    handle.ignoreReplicaWrite = true;
    const before = handle.backend.snapshot();
    await expect(coordinate(handle, authenticatedBootstrapCommand())).rejects.toThrow(/read-back differs/i);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`rolls back every staged recovery write when the transaction callback throws ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    handle.throwAfterAck = true;
    const before = handle.backend.snapshot();
    await expect(coordinate(handle, authenticatedBootstrapCommand())).rejects.toThrow(/injected transaction callback failure/i);
    expect(handle.backend.snapshot()).toEqual(before);
  });

  it(`rejects commit-unknown without claiming lifecycle success ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.rejectAfterCommit = true;
    await expect(coordinate(handle, { type: 'require_recovery', succeeded: true })).rejects.toThrow(/commit outcome unknown/i);
  });

  it(`rejects a UnitOfWork that invokes its callback zero times ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.executeMode = 'zero';
    await expect(coordinate(handle)).rejects.toThrow(/callback|transaction callback result/i);
  });

  it(`rejects a UnitOfWork that invokes its callback twice ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired' })));
    handle.executeMode = 'twice';
    await expect(coordinate(handle)).rejects.toThrow(/exactly once/i);
  });

  it(`rejects a UnitOfWork that forges the callback result ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired' })));
    handle.executeMode = 'forged';
    await expect(coordinate(handle)).rejects.toThrow(/transaction callback result/i);
  });

  it(`rejects a synchronous UnitOfWork execute port ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.executeMode = 'sync';
    await expect(coordinate(handle)).rejects.toThrow(/must return a Promise/i);
  });

  it(`rejects every synchronous lifecycle transaction port ${evidence}`, async () => {
    for (const mode of ['sync-time', 'sync-load', 'sync-save', 'sync-window', 'sync-snapshot', 'sync-ack-save', 'sync-ack-load'] as const) {
      const initial = mode === 'sync-window' ? checkpoint({ lifecycle: 'expired' })
        : mode.startsWith('sync-ack') || mode === 'sync-snapshot' ? checkpoint({ lifecycle: 'recovery_required' })
          : checkpoint();
      const lifecycleCommand = mode === 'sync-window' ? authenticatedResumeCommand()
        : mode.startsWith('sync-ack') || mode === 'sync-snapshot' ? authenticatedBootstrapCommand()
          : mode === 'sync-save' ? { type: 'require_recovery' as const, succeeded: true }
            : { type: 'expire' as const };
      const handle = new DurableLifecycleHandle(new SharedDurableBackend(initial));
      handle.portMode = mode;
      await expect(coordinate(handle, lifecycleCommand)).rejects.toThrow(/must return a Promise/i);
    }
  });

  it(`detects an adapter that ignores a Replica write ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.ignoreReplicaWrite = true;
    await expect(coordinate(handle, { type: 'require_recovery', succeeded: true })).rejects.toThrow(/read-back differs/i);
  });

  it(`detects an adapter that ignores a Snapshot Ack write ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    handle.ignoreAckWrite = true;
    await expect(coordinate(handle, authenticatedBootstrapCommand())).rejects.toThrow(/Ack was not persisted/i);
  });

  it(`detects Replica checkpoint write-readback mismatch ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.mismatchReplicaReadback = true;
    await expect(coordinate(handle, { type: 'require_recovery', succeeded: true })).rejects.toThrow(/read-back differs/i);
  });

  it(`detects Snapshot Ack write-readback mismatch ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    handle.mismatchAckReadback = true;
    await expect(coordinate(handle, authenticatedBootstrapCommand())).rejects.toThrow(/Ack read-back differs/i);
  });

  it(`isolates adapter mutations of keys checkpoints and Acks ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    handle.mutatePortInputs = true;
    const candidateKey = { replicaId: 'replica-1', collectionId: 'collection-1' };
    const candidateCommand = authenticatedBootstrapCommand();
    const result = await coordinate(handle, candidateCommand, candidateKey);
    expect(candidateKey).toEqual({ replicaId: 'replica-1', collectionId: 'collection-1' });
    expect(candidateCommand).not.toHaveProperty('adapterMutation');
    expect(result).not.toHaveProperty('adapterMutation');
    expect(handle.backend.snapshot().replicas.get('replica-1')).not.toHaveProperty('adapterMutation');
    expect(handle.backend.snapshot().acks.get('replica-1')).not.toHaveProperty('adapterMutation');
  });

  it(`returns detached deeply immutable coordinator data ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired' })));
    const result = await coordinate(handle, authenticatedResumeCommand());
    expect(Object.isFrozen(result)).toBe(true);
    if (result.state !== 'committed') throw new Error('expected committed result');
    expect(Object.isFrozen(result.checkpoint)).toBe(true);
    expect(() => Object.assign(result.checkpoint, { lifecycle: 'retired' })).toThrow();
    expect(handle.backend.snapshot().replicas.get('replica-1')?.lifecycle).toBe('active');
  });

  it(`rejects unknown string keys symbol keys and accessor members ${evidence}`, async () => {
    const symbolKey = Object.assign({ replicaId: 'replica-1', collectionId: 'collection-1' }, { [Symbol('hidden')]: true });
    const accessor = Object.defineProperty({ type: 'require_recovery', succeeded: true }, 'hidden', { enumerable: true, get: () => true });
    const typeAccessor = Object.defineProperty({}, 'type', { enumerable: true, get: () => 'require_recovery' });
    await expect(coordinate(new DurableLifecycleHandle(), { type: 'require_recovery', succeeded: true, extra: true } as never)).rejects.toThrow(/unknown member/i);
    await expect(coordinate(new DurableLifecycleHandle(), { type: 'require_recovery', succeeded: true }, symbolKey)).rejects.toThrow(/unknown member/i);
    await expect(coordinate(new DurableLifecycleHandle(), accessor as never)).rejects.toThrow(/unknown member|data properties/i);
    await expect(coordinateReplicaLifecycle(new DurableLifecycleHandle(), key, typeAccessor as never)).rejects.toThrow(/data property/i);
  });

  it(`rejects malformed behavior guard state and unknown behaviors ${evidence}`, () => {
    expect(() => evaluateReplicaSyncBehavior({ lifecycle: 'unknown', leaseExpiresAt: future } as never, 'push', now)).toThrow(/lifecycle is invalid/i);
    expect(() => evaluateReplicaSyncBehavior({ lifecycle: 'active', leaseExpiresAt: future }, 'unknown' as never, now)).toThrow(/behavior is invalid/i);
    expect(() => evaluateReplicaSyncBehavior({ lifecycle: 'active', leaseExpiresAt: future, extra: true } as never, 'push', now)).toThrow(/unknown member/i);
  });

  it(`rejects malformed authoritative and lease timestamps before writes ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    handle.backend.authoritativeTime = 'not-a-time';
    await expect(coordinate(handle)).rejects.toThrow(/RFC 3339/i);
    expect(writes(handle)).toEqual([]);
    await expect(coordinate(new DurableLifecycleHandle(), { type: 'renew', succeeded: true, leaseExpiresAt: '2026-07-18T02:00:00-00:00' })).rejects.toThrow(/known offset/i);
  });

  it(`rejects noncanonical negative padded and unsafe commit ordinals ${evidence}`, async () => {
    for (const bad of ['-1', '01', '1.0', '1e3', ' 1']) {
      const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'expired', acknowledgedCommitOrdinal: bad })));
      await expect(coordinate(handle, authenticatedResumeCommand())).rejects.toThrow(/canonical non-negative decimal/i);
      expect(writes(handle)).toEqual([]);
    }
  });

  it(`serializes by the stable Replica key and rejects cross-Replica state substitution ${evidence}`, async () => {
    const handle = new DurableLifecycleHandle();
    await coordinate(handle, { type: 'require_recovery', succeeded: true });
    expect(handle.trace[0]).toBe('tx:replica-1:begin');
    await expect(coordinate(handle, { type: 'expire' }, { replicaId: 'replica-other', collectionId: 'collection-1' })).resolves.toEqual({ state: 'denied', code: 'replica_not_found' });
    expect(handle.backend.snapshot().replicas.get('replica-1')?.lifecycle).toBe('recovery_required');
  });

  it(`shared in-memory handles exercise committed adapter visibility without claiming cross-process proof ${evidence}`, async () => {
    const backend = new SharedDurableBackend(checkpoint());
    await coordinate(new DurableLifecycleHandle(backend), { type: 'require_recovery', succeeded: true });
    await expect(coordinate(new DurableLifecycleHandle(backend), { type: 'expire' })).resolves.toMatchObject({ state: 'denied', code: 'invalid_replica_state', checkpoint: { lifecycle: 'recovery_required' } });
  });

  it(`exports the coordinator from the Sync entry point ${evidence}`, () => {
    expect(coordinateFromSyncEntry).toBe(coordinateReplicaLifecycle);
  });

  it(`preserves the legacy transitionReplicaLifecycle reducer regression surface ${evidence}`, () => {
    const legacy = checkpoint();
    expect(transitionReplicaLifecycle(legacy, { type: 'lease_expired' })).toEqual({ ...legacy, lifecycle: 'expired' });
    expect(() => transitionReplicaLifecycle(checkpoint({ lifecycle: 'retired' }), { type: 'recovery_required' })).toThrow(/terminal/i);

    const recovery = transitionReplicaLifecycle(legacy, { type: 'recovery_required' });
    expect(recovery.lifecycle).toBe('recovery_required');
    expect(transitionReplicaLifecycle(
      { ...legacy, lifecycle: 'expired' },
      {
        type: 'resume_checked', windowComplete: true, leaseId: 'lease-new', generation: 'generation-new',
        lastSeenAt: now, leaseExpiresAt: future,
      },
    )).toMatchObject({ lifecycle: 'active', leaseId: 'lease-new' });
    expect(transitionReplicaLifecycle(
      { ...legacy, lifecycle: 'expired' },
      {
        type: 'resume_checked', windowComplete: false, leaseId: 'lease-new', generation: 'generation-new',
        lastSeenAt: now, leaseExpiresAt: future,
      },
    ).lifecycle).toBe('recovery_required');
    expect(transitionReplicaLifecycle(
      { ...legacy, lifecycle: 'recovery_required' },
      {
        type: 'bootstrap_acked', collectionId: 'collection-new', acknowledgedCursor: 'cursor-new',
        leaseId: 'lease-new', generation: 'generation-new', lastSeenAt: now, leaseExpiresAt: future,
      },
    )).toMatchObject({ lifecycle: 'active', collectionId: 'collection-new', acknowledgedCursor: 'cursor-new' });
    expect(() => transitionReplicaLifecycle(legacy, {
      type: 'resume_checked', windowComplete: true, leaseId: 'lease-new', generation: 'generation-new',
      lastSeenAt: now, leaseExpiresAt: future,
    })).toThrow(/expired/i);
    expect(() => transitionReplicaLifecycle(legacy, {
      type: 'bootstrap_acked', collectionId: 'collection-new', acknowledgedCursor: 'cursor-new',
      leaseId: 'lease-new', generation: 'generation-new', lastSeenAt: now, leaseExpiresAt: future,
    })).toThrow(/recovery-required/i);
  });
});


describe('recovery activation retention horizon', () => {
  it.each([
    ['41', '9', false], ['8', '41', false], ['100', '90', false],
    ['40', '9', true], ['8', '40', true], ['40', '40', true], ['8', '9', true],
  ] as const)('checks snapshot 40 against earliest=%s, purged=%s', async (earliest, purged, allowed) => {
    const handle = new DurableLifecycleHandle(new SharedDurableBackend(checkpoint({ lifecycle: 'recovery_required' })));
    // The snapshot remains readable after the retention window has advanced.
    handle.backend.window = {
      ...handle.backend.window,
      earliestPull: { cursor: `cursor-${earliest}`, commitOrdinal: earliest },
      purgedThrough: { cursor: `cursor-${purged}`, commitOrdinal: purged },
    };
    const before = handle.backend.snapshot();
    const result = await coordinate(handle, authenticatedBootstrapCommand());
    expect(handle.trace).toContain('read:window:collection-1');
    if (allowed) {
      expect(result).toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'active' } });
      expect(handle.backend.snapshot().acks.size).toBe(1);
    } else {
      expect(result).toMatchObject({ state: 'denied', code: 'stale_replica', checkpoint: { lifecycle: 'recovery_required' } });
      expect(writes(handle)).toEqual([]);
      expect(handle.backend.snapshot()).toEqual(before);
    }
  });
});
