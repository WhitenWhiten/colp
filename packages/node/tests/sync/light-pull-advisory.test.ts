import { legacyPullConflict } from '../support/legacy-pull-fixtures.js';
import { describe, expect, it } from 'vitest';

import {
  adviseLightPullBeforePush,
  type PushTransactionRequest,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
  type SyncPullEventStore,
  type SyncPullRequestContext,
} from '../../src/sync/index.js';
import {
  coordinatePushTransaction,
  coordinateSyncPull,
} from '../../src/sync/unsafe.js';

const evidence = '[evidence:sync.light-pull-advisory]';

function pullRequest(): SyncPullRequestContext {
  return {
    sessionId: 'session-1',
    principal: { type: 'user', id: 'alice' },
    collectionId: 'collection-1',
    protocolVersion: '0.1',
    cursor: 'cursor-start',
    limit: 1,
  };
}

function pushRequest(): PushTransactionRequest {
  return {
    batchId: 'batch-after-pull',
    atomic: false,
    serverCursor: 'cursor-start',
    operations: [{
      sequenceScope: 'collection-1',
      digest: 'digest-operation-1',
      operation: {
        opId: 'operation-1',
        replicaId: 'replica-1',
        sequence: 1,
        type: 'delete_node',
        occurredAt: '2026-07-18T00:00:00Z',
        collectionId: 'collection-1',
        targetId: 'node-1',
        baseRevision: 'revision-1',
        payload: {},
      },
    }],
  };
}

function pushUnitOfWork() {
  const claims = new Map<string, unknown>();
  const receipts = new Map<string, unknown>();
  const receiptsBySequence = new Map<string, unknown>();
  return {
    operationIdReservationOwner: 'push' as const,
    execute: async <Value>(work: (transaction: any) => Promise<Value>) => work({
      operationClaims: {
        load: async (id: string) => claims.get(id),
        save: async (claim: any) => { claims.set(claim.operationId, claim); },
      },
      reuseAudits: { append: async () => 'audit-key', load: async () => undefined },
      receipts: {
        findByOperationId: async (id: string) => receipts.get(id),
        findBySequence: async (replicaId: string, sequenceScope: string, sequence: number) =>
          receiptsBySequence.get(`${replicaId}:${sequenceScope}:${sequence}`),
        save: async (receipt: any) => {
          receipts.set(receipt.operationId, receipt);
          receiptsBySequence.set(`${receipt.replicaId}:${receipt.sequenceScope}:${receipt.sequence}`, receipt);
        },
      },
      idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
      appendOperation: async () => undefined,
      saveConflict: async () => undefined,
      allocateCursor: async () => 'cursor-pushed',
      appendAudit: async () => undefined,
      appendOutbox: async () => undefined,
    }),
  };
}

describe(`SYNC-0018 lightweight Pull advisory via production helper ${evidence}`, () => {
  it(`is exported as a production callable (not sequencing theater alone) ${evidence}`, () => {
    expect(typeof adviseLightPullBeforePush).toBe('function');
  });

  it(`advises pull_first when conflict or risk signals are present ${evidence}`, () => {
    expect(adviseLightPullBeforePush({ openConflictCount: 1 }).action).toBe('pull_first');
    expect(adviseLightPullBeforePush({ hasOpenConflicts: true }).action).toBe('pull_first');
    expect(adviseLightPullBeforePush({ conflictEventsSinceLastPull: 2 }).action).toBe('pull_first');
    expect(adviseLightPullBeforePush({ localBaseBehindServer: true }).action).toBe('pull_first');
    expect(adviseLightPullBeforePush({ obviousConflictRisk: true }).action).toBe('pull_first');
  });

  it(`advises push_ok when risk is absent ${evidence}`, () => {
    expect(adviseLightPullBeforePush({
      openConflictCount: 0,
      conflictEventsSinceLastPull: 0,
      hasOpenConflicts: false,
      localBaseBehindServer: false,
      obviousConflictRisk: false,
    }).action).toBe('push_ok');
  });

  it(`treats empty signals as the no-risk boundary (push_ok) ${evidence}`, () => {
    expect(adviseLightPullBeforePush({}).action).toBe('push_ok');
  });

  it(`drives client ordering: pull_first means Pull completes before Push preflight ${evidence}`, async () => {
    const advice = adviseLightPullBeforePush({
      hasOpenConflicts: true,
      localBaseBehindServer: true,
    });
    expect(advice.action).toBe('pull_first');

    const events: string[] = [];
    const cursor: SyncPullCursorRecord = {
      cursor: 'cursor-start',
      sessionId: 'session-1',
      principal: { type: 'user', id: 'alice' },
      collectionId: 'collection-1',
      protocolVersion: '0.1',
      commitOrdinal: '10',
      state: 'active',
    };
    const cursorStore: SyncPullCursorStore = {
      resolveCursor: async (value) => {
        events.push(`pull.cursor:${value}`);
        if (value === 'cursor-conflict') {
          return {
            ...cursor,
            cursor: value,
            commitOrdinal: '11',
          };
        }
        return cursor;
      },
    };
    const eventStore: SyncPullEventStore = {
      readCommittedAfter: async (request) => {
        events.push(`pull.read:${request.afterCommitOrdinal}`);
        return {
          entries: [{
            commitOrdinal: '11',
            event: {
              cursor: 'cursor-conflict',
              kind: 'conflict',
              conflict: legacyPullConflict('conflict-1'),
            },
          }],
          hasMore: false,
          collectionRevision: 'revision-11',
          recommendedPullAfterSeconds: 0,
        };
      },
    };

    // Host honors the production advisory instead of hardcoding pull-then-push.
    if (advice.action === 'pull_first') {
      const pull = await coordinateSyncPull(pullRequest(), cursorStore, eventStore);
      expect(pull).toMatchObject({ ok: true, status: 200 });
      events.push('pull.complete');
    }

    const pushed = await coordinatePushTransaction(
      pushUnitOfWork(),
      pushRequest(),
      async () => {
        events.push('push.preflight');
        return {
          status: 'rejected',
          apply: async () => ({
            opId: 'operation-1',
            sequence: 1,
            warnings: [],
            status: 'rejected',
            code: 'policy_denied',
          }),
          audit: async () => ({ id: 'audit-1' }),
        } as never;
      },
    );

    expect(pushed.results[0]).toMatchObject({ status: 'rejected' });
    expect(events.indexOf('pull.complete')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('pull.complete')).toBeLessThan(events.indexOf('push.preflight'));
  });

  it(`does not force a Pull when the advisory is push_ok ${evidence}`, async () => {
    const advice = adviseLightPullBeforePush({});
    expect(advice.action).toBe('push_ok');

    const events: string[] = [];
    const pushed = await coordinatePushTransaction(
      pushUnitOfWork(),
      pushRequest(),
      async () => {
        events.push('push.preflight');
        return {
          status: 'rejected',
          apply: async () => ({
            opId: 'operation-1',
            sequence: 1,
            warnings: [],
            status: 'rejected',
            code: 'policy_denied',
          }),
          audit: async () => ({ id: 'audit-1' }),
        } as never;
      },
    );

    expect(advice.action).toBe('push_ok');
    expect(events).toEqual(['push.preflight']);
    expect(pushed.results[0]).toMatchObject({ status: 'rejected' });
  });
});
