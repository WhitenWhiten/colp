/**
 * U-4 Sync mutation survivors — priority 1 (Session / Replica binding).
 * Internal mutant kills: transition helpers plus coordinator durable state.
 *
 * Targeted mutant IDs (sync/mutation.json): see case titles.
 */

import { describe, expect, it } from 'vitest';

import {
  coordinateReplicaDueExpiry,
  coordinateReplicaLifecycle,
  createSyncSession,
  terminateSyncSession,
  verifySyncSessionContext,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type DurableReplicaCheckpoint,
  type ReplicaLifecycleKey,
  type ReplicaLifecycleTransaction,
  type ReplicaLifecycleUnitOfWork,
  type SyncSessionBinding,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';
import {
  buildFreshActiveLeaseCheckpoint,
  applyRenewReplicaCommand,
  isResumeRetentionComplete,
} from '../../src/sync/replica-lifecycle-transitions.js';
import { lifecycleInstant } from '../../src/sync/replica-lifecycle-parsing.js';
import { asReplicaAuthenticatedCommand, type ReplicaAuthenticatedLifecycleCommandInput } from '../../src/sync/index.js';
import { createTestReplicaAuthProof } from '../../src/testing/index.js';

function authenticatedCommand<Command extends ReplicaAuthenticatedLifecycleCommandInput>(command: Command) {
  return asReplicaAuthenticatedCommand(command, createTestReplicaAuthProof());
}

const evidence = '[review:sync.mutation-survivors-u4-p1]';
const createdAt = '2026-07-18T02:00:00Z';
const later = '2026-07-18T02:30:00Z';
const now = '2026-07-18T01:00:00Z';
const future = '2026-07-18T03:00:00Z';

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

type DurableSessionState = Map<string, SyncSessionRecord>;

class DurableMemorySessionStore implements SyncSessionStore {
  public constructor(private readonly state: DurableSessionState = new Map()) {}

  public async create(session: ActiveSyncSessionRecord): Promise<SyncSessionStoreCreateResult> {
    await Promise.resolve();
    const existing = this.state.get(session.sessionId);
    if (existing !== undefined) return copy({ state: 'conflict', session: existing });
    const stored = copy(session);
    this.state.set(session.sessionId, stored);
    return copy({ state: 'created', session: stored });
  }

  public async load(sessionId: string): Promise<SyncSessionRecord | undefined> {
    await Promise.resolve();
    const session = this.state.get(sessionId);
    return session === undefined ? undefined : copy(session);
  }

  public async terminate(
    termination: SyncSessionTermination,
  ): Promise<SyncSessionRecord | undefined> {
    await Promise.resolve();
    const existing = this.state.get(termination.sessionId);
    if (existing === undefined) return undefined;
    if (existing.status === 'terminated') return copy(existing);
    const terminated: SyncSessionRecord = {
      ...copy(existing),
      status: 'terminated',
      terminationReason: termination.reason,
      terminatedAt: termination.terminatedAt,
    };
    this.state.set(termination.sessionId, terminated);
    return copy(terminated);
  }
}

function collectionInput(overrides: Partial<CreateSyncSessionInput> = {}): CreateSyncSessionInput {
  return {
    sessionId: 'session-u4-1',
    principal: { type: 'user', id: 'alice' },
    credential: { kind: 'token', id: 'token-1' },
    oauthClientId: 'https://client.example/app',
    origin: 'https://client.example',
    sessionScope: 'collection',
    protocolVersion: '0.1',
    collectionId: 'collection-1',
    purpose: null,
    authorizationScopes: ['sync:pull', 'sync:push'],
    ...overrides,
  };
}

function binding(input: CreateSyncSessionInput): SyncSessionBinding {
  return {
    principal: input.principal,
    credential: input.credential,
    oauthClientId: input.oauthClientId,
    origin: input.origin,
    sessionScope: input.sessionScope,
    protocolVersion: input.protocolVersion,
    collectionId: input.collectionId,
    purpose: input.purpose,
  };
}

function verification(
  input: CreateSyncSessionInput,
  overrides: Partial<VerifySyncSessionContextInput> = {},
): VerifySyncSessionContextInput {
  return {
    sessionId: input.sessionId,
    binding: binding(input),
    authorization: {
      credentialActive: true,
      authorizationScopes: [...input.authorizationScopes],
    },
    terminatedAt: createdAt,
    ...overrides,
  };
}

describe(`U-4 P1 session termination reason binding ${evidence}`, () => {
  it(`mutants ~4189/4307: bootstrap_rejected is a valid terminate reason and persists ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput();
    await createSyncSession(store, input);

    const terminated = await terminateSyncSession(store, {
      sessionId: input.sessionId,
      reason: 'bootstrap_rejected',
      terminatedAt: later,
    });
    expect(terminated).toMatchObject({
      status: 'terminated',
      terminationReason: 'bootstrap_rejected',
      terminatedAt: later,
      sessionId: input.sessionId,
      collectionId: 'collection-1',
    });

    const verified = await verifySyncSessionContext(
      store,
      verification(input, { terminatedAt: later }),
    );
    expect(verified).toMatchObject({
      state: 'terminated',
      session: { terminationReason: 'bootstrap_rejected' },
    });
  });

  it(`mutant ~4307 sibling: unknown termination reason is rejected before store write ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ sessionId: 'session-u4-bad-reason' });
    await createSyncSession(store, input);
    await expect(
      terminateSyncSession(store, {
        sessionId: input.sessionId,
        reason: 'not_a_reason' as 'administrative',
        terminatedAt: later,
      }),
    ).rejects.toThrow(/invalid reason/i);
    await expect(store.load(input.sessionId)).resolves.toMatchObject({ status: 'active' });
  });
});

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

class MemoryReplicaLifecycle implements ReplicaLifecycleUnitOfWork {
  public readonly replicas = new Map<string, DurableReplicaCheckpoint>();
  public authoritativeTime = now;
  public forgeCollectionIdOnReadback: string | undefined;

  public constructor(initial?: DurableReplicaCheckpoint) {
    if (initial !== undefined) this.replicas.set(initial.replicaId, copy(initial));
  }

  public async execute<Value>(
    _replicaId: string,
    work: (transaction: ReplicaLifecycleTransaction) => Promise<Value>,
  ): Promise<Value> {
    await Promise.resolve();
    const draft = new Map([...this.replicas].map(([id, value]) => [id, copy(value)]));
    let loads = 0;
    const result = await work({
      loadReplica: async (replicaId) => {
        await Promise.resolve();
        loads += 1;
        const value = draft.get(replicaId);
        if (value === undefined) return undefined;
        if (this.forgeCollectionIdOnReadback !== undefined && loads > 1) {
          return copy({ ...value, collectionId: this.forgeCollectionIdOnReadback });
        }
        return copy(value);
      },
      saveReplica: async (value) => {
        await Promise.resolve();
        draft.set(value.replicaId, copy(value));
      },
      readAuthoritativeTime: async () => {
        await Promise.resolve();
        return this.authoritativeTime;
      },
      loadRetentionWindow: async () =>
        copy({
          collectionId: 'collection-1',
          earliestPull: { cursor: null, commitOrdinal: '0' },
          purgedThrough: { cursor: null, commitOrdinal: '0' },
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
}

describe(`U-4 P1 replica lease / retention binding ${evidence}`, () => {
  it(`mutant ~2780: checkpoint with leaseExpiresAt === lastSeenAt is rejected on load ${evidence}`, async () => {
    const handle = new MemoryReplicaLifecycle(
      checkpoint({ lastSeenAt: now, leaseExpiresAt: now, lifecycle: 'active' }),
    );
    await expect(
      coordinateReplicaDueExpiry(
        handle,
        { replicaId: 'replica-1', collectionId: 'collection-1' },
      ),
    ).rejects.toThrow(/later than lastSeenAt/i);
    expect(handle.replicas.get('replica-1')).toMatchObject({
      lastSeenAt: now,
      leaseExpiresAt: now,
    });
  });

  it(`mutants ~2495/191: fresh lease expiry equal to authoritative time throws ${evidence}`, () => {
    const instant = lifecycleInstant(now, 'Authoritative time');
    expect(() =>
      buildFreshActiveLeaseCheckpoint(
        checkpoint({ lifecycle: 'expired' }),
        {
          leaseId: 'lease-new',
          generation: 'generation-new',
          leaseExpiresAt: now,
        },
        instant,
      ),
    ).toThrow(/later than authoritative time/i);
  });

  it(`mutant ~2542 renew: leaseExpiresAt equal to authoritative time is denied via transition helper ${evidence}`, async () => {
    // Call applyRenewReplicaCommand directly so an already-past current lease
    // is not rewritten to stale_replica before the expiry bound check.
    const pastLease = checkpoint({
      lastSeenAt: '2026-07-18T00:00:00Z',
      leaseExpiresAt: '2026-07-18T00:30:00Z',
      lifecycle: 'active',
    });
    const nowInstant = lifecycleInstant(now, 'Authoritative time');
    await expect(
      applyRenewReplicaCommand(
        {
          transaction: {} as never,
          key: { replicaId: 'replica-1', collectionId: 'collection-1' },
          checkpoint: pastLease,
          now: nowInstant,
          saveAndVerify: async () => pastLease,
        },
        {
          type: 'renew',
          authenticated: true,
          succeeded: true,
          leaseExpiresAt: now,
        },
      ),
    ).resolves.toMatchObject({ state: 'denied', code: 'invalid_lease_expiry' });
  });

  it(`mutants ~2506/isResumeRetentionComplete: null ack and below-earliest ack incomplete ${evidence}`, () => {
    // Internal helper kill: a coordinator-only observation cannot isolate the
    // (ack !== null && ack >= earliest) tautology from the purged-through arm.
    expect(isResumeRetentionComplete(10n, '8', '9')).toBe(true);
    expect(isResumeRetentionComplete(null, '8', '9')).toBe(false);
    expect(isResumeRetentionComplete(7n, '8', '5')).toBe(false);
  });

  it(`mutants ~2381/31 retention boundary: null cursor window still resumes when ordinals complete ${evidence}`, async () => {
    const handle = new MemoryReplicaLifecycle(
      checkpoint({
        lifecycle: 'expired',
        acknowledgedCursor: 'cursor-10',
        acknowledgedCommitOrdinal: '10',
      }),
    );
    await expect(
      coordinateReplicaLifecycle(
        handle,
        { replicaId: 'replica-1', collectionId: 'collection-1' },
        authenticatedCommand({
          type: 'resume',
          leaseId: 'lease-new',
          generation: 'generation-new',
          leaseExpiresAt: future,
          succeeded: true,
        }),
      ),
    ).resolves.toMatchObject({
      state: 'committed',
      checkpoint: { lifecycle: 'active', leaseId: 'lease-new', generation: 'generation-new' },
    });
  });

  it(`mutants ~2805/2807 sameCheckpoint: collectionId-only readback forge is rejected ${evidence}`, async () => {
    const handle = new MemoryReplicaLifecycle(checkpoint());
    handle.forgeCollectionIdOnReadback = 'collection-FORGED';
    await expect(
      coordinateReplicaLifecycle(
        handle,
        { replicaId: 'replica-1', collectionId: 'collection-1' },
        authenticatedCommand({ type: 'require_recovery', succeeded: true }),
      ),
    ).rejects.toThrow(/read-back differs/i);
    // Durable map must remain pre-image (rollback of failed UnitOfWork).
    expect(handle.replicas.get('replica-1')).toEqual(checkpoint());
  });

  it(`mutants ~2805 sibling: mismatched collectionId key throws before resume ${evidence}`, async () => {
    const handle = new MemoryReplicaLifecycle(
      checkpoint({ collectionId: 'collection-1', lifecycle: 'expired' }),
    );
    const key: ReplicaLifecycleKey = { replicaId: 'replica-1', collectionId: 'collection-OTHER' };
    await expect(
      coordinateReplicaLifecycle(handle, key, authenticatedCommand({
        type: 'resume',
        leaseId: 'lease-new',
        generation: 'generation-new',
        leaseExpiresAt: future,
        succeeded: true,
      })),
    ).rejects.toThrow(/mismatched Collection/i);
  });
});
