import { describe, expect, it, vi } from 'vitest';

import { coordinateSessionBoundReplicaLifecycle } from '../../src/sync/composition.js';
import { createSyncHost } from '../../src/sync/host.js';
import {
  requireVerifiedSyncSession, SyncSessionGateDeniedError,
  type ActiveSyncSessionRecord, type SyncSessionStore,
} from '../../src/sync/session.js';
import type {
  DurableReplicaCheckpoint, ReplicaAuthenticatedLifecycleCommandInput,
  ReplicaLifecycleTransaction, ReplicaLifecycleUnitOfWork,
} from '../../src/sync/replica-lifecycle.js';

const now = '2026-07-18T01:00:00Z';
const future = '2026-07-18T02:00:00Z';
const key = { replicaId: 'replica-scope', collectionId: 'collection-scope' };

async function verifiedSession(
  scope: 'instance' | 'collection',
  collectionId = key.collectionId,
  authorizationScopes: ActiveSyncSessionRecord['authorizationScopes'] = [
    'collections:create', 'sync:bootstrap', 'sync:push', 'sync:pull',
  ],
) {
  const binding = {
    principal: { type: 'user' as const, id: 'alice' },
    credential: { kind: 'token' as const, id: 'token-scope' },
    oauthClientId: null, origin: null, sessionScope: scope,
    protocolVersion: '0.1' as const,
    collectionId: scope === 'instance' ? null : collectionId,
    purpose: scope === 'instance' ? 'create_collection' as const : null,
  };
  const record: ActiveSyncSessionRecord = {
    ...binding, sessionId: 'session-scope', status: 'active',
    authorizationScopes,
  };
  const store: SyncSessionStore = {
    load: async (id) => id === record.sessionId ? structuredClone(record) : undefined,
    create: async () => { throw new Error('unused create'); },
    terminate: async () => { throw new Error('unexpected termination'); },
  };
  return requireVerifiedSyncSession(store, {
    sessionId: record.sessionId, binding,
    authorization: { credentialActive: true, authorizationScopes: record.authorizationScopes },
    terminatedAt: now,
  });
}

const freshLease = { leaseId: 'lease-new', generation: 'generation-new', leaseExpiresAt: future };
const commands: readonly ReplicaAuthenticatedLifecycleCommandInput[] = [
  { type: 'register', collectionId: key.collectionId, ...freshLease, succeeded: true },
  { type: 'renew', leaseExpiresAt: future, succeeded: true },
  { type: 'retire', succeeded: true },
  { type: 'require_recovery', succeeded: true },
  { type: 'resume', ...freshLease, succeeded: true },
  { type: 'complete_recovery', snapshotId: 'snapshot-scope', ...freshLease, succeeded: true },
];

function forbiddenUnitOfWork() {
  const entered = vi.fn();
  const unitOfWork: ReplicaLifecycleUnitOfWork = {
    async execute() {
      entered();
      throw new Error('must not enter transaction');
    },
  };
  return { entered, unitOfWork };
}

const ownsReplica = () => true;

describe('Replica lifecycle requires a bound Collection [evidence:sync.composition]', () => {
  it('requires durable ownership evidence before minting a proof or entering the transaction', async () => {
    const session = await verifiedSession('collection');
    const { entered, unitOfWork } = forbiddenUnitOfWork();
    await expect(coordinateSessionBoundReplicaLifecycle(
      { kind: 'verified', session }, unitOfWork, key,
      { type: 'retire', succeeded: true },
    )).rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
    expect(entered).not.toHaveBeenCalled();

    await expect(coordinateSessionBoundReplicaLifecycle(
      { kind: 'verified', session }, unitOfWork, key,
      { type: 'retire', succeeded: true },
      () => false,
    )).rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
    expect(entered).not.toHaveBeenCalled();
  });

  it.each([
    ['register', { type: 'register', collectionId: key.collectionId, ...freshLease, succeeded: true }, ['sync:push', 'sync:pull'], 'sync:bootstrap'],
    ['acknowledge', { type: 'acknowledge', cursor: 'cursor-1', commitOrdinal: '1', succeeded: true }, ['collections:create', 'sync:bootstrap', 'sync:push'], 'sync:pull'],
    ['renew', { type: 'renew', leaseExpiresAt: future, succeeded: true }, ['collections:create', 'sync:bootstrap', 'sync:pull'], 'sync:push'],
  ] as const)('requires the command-specific authorization scope for %s', async (_label, command, scopes, requiredScope) => {
    const session = await verifiedSession('collection', key.collectionId, scopes);
    const { entered, unitOfWork } = forbiddenUnitOfWork();
    await expect(coordinateSessionBoundReplicaLifecycle(
      { kind: 'verified', session }, unitOfWork, key, command, ownsReplica,
    )).rejects.toMatchObject({ denial: { state: 'scope_missing', requiredScope } });
    expect(entered).not.toHaveBeenCalled();
  });

  it.each(commands)('rejects instance Session $type before any transaction', async (command) => {
    const session = await verifiedSession('instance');
    const { entered, unitOfWork } = forbiddenUnitOfWork();
    for (const run of [
      () => coordinateSessionBoundReplicaLifecycle({ kind: 'verified', session }, unitOfWork, key, command, ownsReplica),
      () => createSyncHost({ owner: 'push', session, ownershipVerifier: ownsReplica }).replica(unitOfWork, key, command),
      () => createSyncHost({ owner: 'sequence', session, ownershipVerifier: ownsReplica }).replica(unitOfWork, key, command),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(SyncSessionGateDeniedError);
    }
    expect(entered).not.toHaveBeenCalled();
  });

  it('rejects a different Collection even with a genuinely verified Session', async () => {
    const session = await verifiedSession('collection', 'other-collection');
    const { entered, unitOfWork } = forbiddenUnitOfWork();
    await expect(coordinateSessionBoundReplicaLifecycle(
    { kind: 'verified', session }, unitOfWork, key, { type: 'retire', succeeded: true },
    ownsReplica,
    )).rejects.toMatchObject({ denial: { state: 'request_binding_mismatch' } });
    expect(entered).not.toHaveBeenCalled();
  });

  it('continues to permit a bound Session to retire its Collection Replica', async () => {
    const session = await verifiedSession('collection');
    let stored: DurableReplicaCheckpoint = {
      ...key, leaseId: 'lease-old', generation: 'generation-old', lifecycle: 'active',
      lastSeenAt: '2026-07-18T00:00:00Z', leaseExpiresAt: future,
      acknowledgedCursor: null, acknowledgedCommitOrdinal: null,
    };
    const unused = async (): Promise<never> => { throw new Error('unused recovery port'); };
    const transaction: ReplicaLifecycleTransaction = {
      readAuthoritativeTime: async () => now,
      loadReplica: async () => structuredClone(stored),
      saveReplica: async (checkpoint) => { stored = structuredClone(checkpoint); },
      loadRetentionWindow: unused, loadAuthoritativeSnapshot: unused,
      saveSnapshotAck: unused, loadSnapshotAck: unused,
    };
    const unitOfWork: ReplicaLifecycleUnitOfWork = { execute: async (_id, work) => work(transaction) };
    const outcome = await createSyncHost({ owner: 'push', session, ownershipVerifier: ownsReplica }).replica(
      unitOfWork, key, { type: 'retire', succeeded: true },
    );
    expect(outcome.result).toMatchObject({ state: 'committed', checkpoint: { lifecycle: 'retired' } });
    expect(stored.lifecycle).toBe('retired');
  });
});
