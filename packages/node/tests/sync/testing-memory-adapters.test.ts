import { describe, expect, it } from 'vitest';

import {
  createSyncHost,
  createSyncSession,
  requireVerifiedSyncSession,
  terminateSyncSession,
  verifySyncSessionContext,
  type CreateSyncSessionInput,
  type SequenceEvaluation,
  type SequenceOperationRequest,
} from '../../src/sync/index.js';
import { coordinateSequenceOperation } from '../../src/sync/unsafe.js';
import {
  createInMemorySequenceUnitOfWork,
  createInMemorySyncSessionStore,
} from '../../src/testing/index.js';

const now = '2026-07-18T01:00:00Z';
const binding = {
  principal: { type: 'user', id: 'alice' },
  credential: { kind: 'token', id: 'token-1' },
  oauthClientId: null,
  origin: null,
  sessionScope: 'collection',
  protocolVersion: '0.1',
  collectionId: 'collection-1',
  purpose: null,
} as const;
const sessionInput: CreateSyncSessionInput = {
  ...binding,
  sessionId: 'session-1',
  authorizationScopes: ['sync:pull', 'sync:push'],
};
const authorization = { credentialActive: true, authorizationScopes: ['sync:pull', 'sync:push'] } as const;

function request(overrides: Partial<SequenceOperationRequest> = {}): SequenceOperationRequest {
  return {
    operationId: 'op-1',
    replicaId: 'replica-1',
    sequenceScope: 'collection-1',
    sequence: 1,
    digest: 'digest-1',
    ...overrides,
  };
}

type Result = { status: string };
const applied = async (): Promise<SequenceEvaluation<Result>> => ({ status: 'applied', result: { status: 'applied' } });

describe('in-memory reference Sync adapters', () => {
  it('runs the Session lifecycle through the public coordinators', async () => {
    const store = createInMemorySyncSessionStore();
    await expect(createSyncSession(store, sessionInput)).resolves.toMatchObject({ status: 'active' });
    await expect(createSyncSession(store, sessionInput)).rejects.toThrow('already exists');
    await expect(verifySyncSessionContext(store, {
      sessionId: 'session-1', binding, authorization, terminatedAt: now,
    })).resolves.toMatchObject({ state: 'active' });

    const first = await terminateSyncSession(store, {
      sessionId: 'session-1', reason: 'administrative', terminatedAt: now,
    });
    const second = await terminateSyncSession(store, {
      sessionId: 'session-1', reason: 'credential_revoked', terminatedAt: '2026-07-18T02:00:00Z',
    });
    expect(second).toEqual(first);
    expect(store.snapshot().get('session-1')).toMatchObject({
      status: 'terminated', terminationReason: 'administrative', terminatedAt: now,
    });
    await expect(terminateSyncSession(store, {
      sessionId: 'missing', reason: 'administrative', terminatedAt: now,
    })).resolves.toBeUndefined();
  });

  it('drives a Sequence host end to end: execute, replay, gap, and reuse denial', async () => {
    const sessions = createInMemorySyncSessionStore();
    await createSyncSession(sessions, sessionInput);
    const session = await requireVerifiedSyncSession(sessions, {
      sessionId: 'session-1', binding, authorization, terminatedAt: now,
    });
    const host = createSyncHost({ owner: 'sequence', session });
    const unitOfWork = createInMemorySequenceUnitOfWork<Result>();

    await expect(host.sequence(unitOfWork, request(), applied))
      .resolves.toMatchObject({ result: { kind: 'executed' } });
    await expect(host.sequence(unitOfWork, request(), applied))
      .resolves.toMatchObject({ result: { kind: 'replayed' } });
    await expect(host.sequence(unitOfWork, request({ operationId: 'op-3', sequence: 3, digest: 'digest-3' }), applied))
      .resolves.toMatchObject({ result: { kind: 'sequence_gap', expectedSequence: 2 } });

    const denied = await host.sequence(unitOfWork, request({ digest: 'digest-other' }), applied);
    expect(denied.result).toMatchObject({ kind: 'sequence_reuse' });
    const state = unitOfWork.snapshot();
    expect(state.lanes.size).toBe(1);
    expect([...state.lanes.values()]).toEqual([{ nextSequence: 2 }]);
    expect(state.receipts.size).toBe(1);
    expect(state.reservedIds.get('op-1')).toBe('operation');
    expect(denied.result.kind === 'sequence_reuse' && state.reuseAudits.get(denied.result.auditKey))
      .toEqual(denied.result.kind === 'sequence_reuse' ? denied.result.audit : undefined);
  });

  it('rolls back a failed transaction and serializes concurrent ones', async () => {
    const unitOfWork = createInMemorySequenceUnitOfWork<Result>();
    const failure = new Error('business write failed');
    await expect(coordinateSequenceOperation(unitOfWork, request(), async () => { throw failure; }))
      .rejects.toBe(failure);
    expect(unitOfWork.snapshot().operationClaims.size).toBe(0);
    expect(unitOfWork.snapshot().reservedIds.size).toBe(0);

    // The same Operation sent twice at once executes once and replays once.
    const outcomes = await Promise.all([
      coordinateSequenceOperation(unitOfWork, request(), applied),
      coordinateSequenceOperation(unitOfWork, request(), applied),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual(['executed', 'replayed']);

    // One Operation ID cannot be claimed again on another lane.
    await expect(coordinateSequenceOperation(
      unitOfWork, request({ replicaId: 'replica-2', digest: 'digest-2' }), applied,
    )).resolves.toMatchObject({ kind: 'op_id_reused' });
  });

  it('defers, then replaces the deferred receipt on re-evaluation', async () => {
    const unitOfWork = createInMemorySequenceUnitOfWork<Result>();
    const deferred = async (): Promise<SequenceEvaluation<Result>> => ({ status: 'deferred', result: { status: 'deferred' } });
    await expect(coordinateSequenceOperation(unitOfWork, request(), deferred))
      .resolves.toMatchObject({ kind: 'executed', receipt: { status: 'deferred' } });
    expect([...unitOfWork.snapshot().lanes.values()]).toEqual([{ nextSequence: 1 }]);
    await expect(coordinateSequenceOperation(unitOfWork, request({ reevaluateDeferred: true }), applied))
      .resolves.toMatchObject({ kind: 'executed', receipt: { status: 'applied' } });
    expect([...unitOfWork.snapshot().lanes.values()]).toEqual([{ nextSequence: 2 }]);
  });
});
