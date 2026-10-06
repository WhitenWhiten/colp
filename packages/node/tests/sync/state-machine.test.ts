import { describe, expect, it } from 'vitest';

import {
  type ReplicaCheckpoint,
  type TerminalOperationStatus,
} from '../../src/sync/index.js';
import {
  canPurgeTombstone,
  createSequenceState,
  decideSequence,
  haveMatchingTypedUpdateFields,
  recordSequenceResult,
  transitionReplicaLifecycle,
} from '../../src/sync/legacy.js';

const checkpoint: ReplicaCheckpoint = {
  replicaId: 'replica-1',
  collectionId: 'collection-1',
  leaseId: 'lease-1',
  generation: 'generation-1',
  lastSeenAt: '2026-07-16T07:00:00Z',
  leaseExpiresAt: '2026-08-16T07:00:00Z',
  acknowledgedCursor: 'sync-1',
  lifecycle: 'active',
};

describe('Replica Sequence state machine', () => {
  it.each<TerminalOperationStatus>(['applied', 'rebased', 'noop', 'conflicted', 'rejected'])(
    '%s is terminal and consumes the current Sequence',
    (status) => {
      const result = { status };
      const state = recordSequenceResult(createSequenceState<typeof result>(), {
        sequence: 1,
        digest: 'digest-1',
        status,
        result,
      });

      expect(state.nextSequence).toBe(2);
      expect(decideSequence(state, 1, 'digest-1')).toEqual({ kind: 'replay', result });
      expect(decideSequence(state, 2, 'digest-2')).toEqual({ kind: 'accept' });
    },
  );

  it('keeps deferred non-terminal, replays it exactly, and blocks later Sequences', () => {
    const deferred = { status: 'deferred', code: 'dependency_pending' } as const;
    const pending = recordSequenceResult(createSequenceState<typeof deferred | { status: 'applied' }>(), {
      sequence: 1,
      digest: 'digest-1',
      status: 'deferred',
      result: deferred,
    });

    expect(pending.nextSequence).toBe(1);
    expect(decideSequence(pending, 1, 'digest-1')).toEqual({ kind: 'replay', result: deferred });
    expect(decideSequence(pending, 1, 'different')).toEqual({ kind: 'sequence_reuse' });
    expect(decideSequence(pending, 2, 'digest-2')).toEqual({
      kind: 'sequence_blocked',
      expectedSequence: 1,
    });

    const applied = { status: 'applied' } as const;
    const terminal = recordSequenceResult(pending, {
      sequence: 1,
      digest: 'digest-1',
      status: 'applied',
      result: applied,
    });
    expect(terminal.nextSequence).toBe(2);
    expect(decideSequence(terminal, 1, 'digest-1')).toEqual({ kind: 'replay', result: applied });
  });

  it('rejects gaps without advancing state', () => {
    const state = createSequenceState();
    expect(decideSequence(state, 3, 'digest-3')).toEqual({
      kind: 'sequence_gap',
      expectedSequence: 1,
    });
    expect(state.nextSequence).toBe(1);
  });
});

describe('Replica Lease and Tombstone lifecycle', () => {
  it('requires recovery when an expired Replica has lost its retained window', () => {
    const expired = transitionReplicaLifecycle(checkpoint, { type: 'lease_expired' });
    const recovery = transitionReplicaLifecycle(expired, {
      type: 'resume_checked',
      windowComplete: false,
      leaseId: 'lease-2',
      generation: 'generation-2',
      lastSeenAt: '2026-08-17T07:00:00Z',
      leaseExpiresAt: '2026-09-17T07:00:00Z',
    });
    expect(recovery.lifecycle).toBe('recovery_required');

    const active = transitionReplicaLifecycle(recovery, {
      type: 'bootstrap_acked',
      collectionId: 'collection-1',
      acknowledgedCursor: 'sync-100',
      leaseId: 'lease-3',
      generation: 'generation-3',
      lastSeenAt: '2026-08-17T07:10:00Z',
      leaseExpiresAt: '2026-09-17T07:10:00Z',
    });
    expect(active).toMatchObject({
      lifecycle: 'active',
      acknowledgedCursor: 'sync-100',
      generation: 'generation-3',
    });
  });

  it('makes retirement terminal', () => {
    const retired = transitionReplicaLifecycle(checkpoint, { type: 'retire' });
    expect(retired.lifecycle).toBe('retired');
    expect(() => transitionReplicaLifecycle(retired, { type: 'recovery_required' })).toThrow(
      /terminal/,
    );
  });

  it('purges only after every active acknowledgement and durable boundary is ready', () => {
    const facts = {
      retentionElapsed: true,
      activeReplicaAcks: [
        { acknowledgedDeletion: true, queuedOperationsReconciled: true },
        { acknowledgedDeletion: true, queuedOperationsReconciled: true },
      ],
      purgeBoundaryReady: true,
      deletionWatermarkReady: true,
    };

    expect(canPurgeTombstone(facts)).toBe(true);
    expect(
      canPurgeTombstone({
        ...facts,
        activeReplicaAcks: [{ acknowledgedDeletion: false, queuedOperationsReconciled: true }],
      }),
    ).toBe(false);
    expect(canPurgeTombstone({ ...facts, deletionWatermarkReady: false })).toBe(false);
  });
});

describe('typed update semantic checks', () => {
  it('requires base and value to describe the same resource fields', () => {
    expect(
      haveMatchingTypedUpdateFields(
        { title: 'Before', tags: ['old'] },
        { tags: ['new'], title: 'After' },
      ),
    ).toBe(true);
    expect(haveMatchingTypedUpdateFields({ title: 'Before' }, { tags: ['new'] })).toBe(false);
  });
});
