import { describe, expect, it, vi } from 'vitest';

import {
  coordinateSessionBoundSequence,
  createSyncHost,
  type PushReplicaOwnershipVerifier,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceEvaluationContext,
  type SequenceOperationRequest,
} from '../../src/sync/index.js';
import type { OperationResult } from '../../src/types/index.js';
import { DurableContractHandle } from './push-transaction-harness.js';
import { verifiedSession } from './verified-session-fixture.js';

interface Transaction extends SequenceCoordinatorTransaction<OperationResult> {
  putBusiness(value: string): Promise<void>;
}

function sequenceAdapter(backend: DurableContractHandle): SequenceCoordinatorUnitOfWork<OperationResult, Transaction> {
  return {
    operationIdReservationOwner: 'sequence',
    execute: (_lane, work) => backend.execute((transaction) => work({
      idReservations: transaction.idReservations,
      operationClaims: transaction.operationClaims,
      reuseAudits: transaction.reuseAudits,
      loadLaneState: (lane) => transaction.sequenceLanes!.load(lane),
      saveLaneState: (lane, state) => transaction.sequenceLanes!.save(lane, state),
      receipts: {
        load: (lane, sequence) => transaction.receipts.findBySequence(
          lane.replicaId, lane.sequenceScope, sequence,
        ),
        save: (receipt, condition) => transaction.receipts.save(receipt,
          condition.kind === 'absent' ? condition : {
            ...condition, operationId: receipt.operationId,
          }),
      },
      putBusiness: transaction.putBusiness,
    })),
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function request() {
  return {
    operationId: 'operation-1', replicaId: 'replica-1',
    sequenceScope: 'collection:collection-1', sequence: 1, digest: 'digest-1',
  };
}

async function evaluate(context: SequenceEvaluationContext<OperationResult>, transaction: Transaction) {
  await transaction.putBusiness(context.request.replicaId);
  return {
    status: 'applied' as const,
    result: {
      opId: context.request.operationId, sequence: context.request.sequence,
      status: 'applied' as const, revision: 'revision-2', cursor: 'cursor-1', warnings: [],
    },
  };
}

describe('Sequence authorization and execution share one request snapshot [evidence:sync.composition]', () => {
  it.each(['host', 'composition'] as const)('ignores caller mutation during ownership verification (%s)', async (entrypoint) => {
    const session = await verifiedSession('alice-session', { authorizationScopes: ['sync:push'] });
    const entered = deferred<void>();
    const authorized = deferred<boolean>();
    const verifier = vi.fn<PushReplicaOwnershipVerifier>(async (_session, key) => {
      expect(key).toEqual({ replicaId: 'replica-1', collectionId: 'collection-1' });
      entered.resolve();
      return authorized.promise;
    });
    const backend = new DurableContractHandle();
    const adapter = sequenceAdapter(backend);
    const candidate = request();
    const pending = entrypoint === 'host'
      ? createSyncHost({ owner: 'sequence', session, sequenceOwnershipVerifier: verifier })
        .sequence(adapter, candidate, evaluate)
      : coordinateSessionBoundSequence(
        { kind: 'verified', session, sequenceOwnershipVerifier: verifier }, adapter, candidate, evaluate,
      );
    await entered.promise;
    Object.assign(candidate, {
      operationId: 'operation-foreign', replicaId: 'replica-foreign',
      sequenceScope: 'collection-foreign', digest: 'digest-foreign',
    });
    authorized.resolve(true);
    await expect(pending).resolves.toMatchObject({ result: {
      kind: 'executed', receipt: {
        operationId: 'operation-1', replicaId: 'replica-1', sequenceScope: 'collection-1',
        sequence: 1, digest: 'digest-1', status: 'applied',
      },
    } });
    expect(verifier).toHaveBeenCalledOnce();
    expect(backend.backend.state.business).toEqual(['replica-1']);
    expect([...backend.backend.state.operationClaims.keys()]).toEqual(['operation-1']);
    expect([...backend.backend.state.laneStates.keys()])
      .toEqual([JSON.stringify(['replica-1', 'collection-1'])]);
  });

  it('rejects accessor-based identity before calling the ownership verifier', async () => {
    const session = await verifiedSession('alice-session', { authorizationScopes: ['sync:push'] });
    const candidate: SequenceOperationRequest = request();
    const getter = vi.fn(() => 'replica-1');
    Object.defineProperty(candidate, 'replicaId', { get: getter, enumerable: true });
    const verifier = vi.fn<PushReplicaOwnershipVerifier>(() => true);
    const backend = new DurableContractHandle();
    const host = createSyncHost({ owner: 'sequence', session, sequenceOwnershipVerifier: verifier });
    await expect(host.sequence(sequenceAdapter(backend), candidate, evaluate)).rejects.toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    expect(backend.executeCount).toBe(0);
  });
});
