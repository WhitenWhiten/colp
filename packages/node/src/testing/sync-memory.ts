/**
 * In-memory reference adapters for Sync ports.
 *
 * They exist so adapter authors and host tests can run the coordinators
 * without a database, and so a real adapter can be compared against a known
 * good one. They keep everything in one process and lose it on exit: never
 * wire them into a deployment.
 */

import type { ServerIdReservation, ServerIdResourceType } from '../shared/server-id-reservations.js';
import type {
  ActiveSyncSessionRecord,
  SequenceCoordinatorTransaction,
  SequenceCoordinatorUnitOfWork,
  SequenceLaneKey,
  SequenceLaneState,
  StoredOperationReceipt,
  SyncOperationClaim,
  SyncOperationReuseAudit,
  SyncSessionRecord,
  SyncSessionStore,
} from '../sync/index.js';

function copy<Value>(value: Value): Value {
  return structuredClone(value);
}

export interface InMemorySyncSessionStore extends SyncSessionStore {
  /** Detached copy of every stored Session, for assertions. */
  snapshot(): ReadonlyMap<string, SyncSessionRecord>;
}

/** Session store with unique IDs and first-termination-wins semantics. */
export function createInMemorySyncSessionStore(): InMemorySyncSessionStore {
  const sessions = new Map<string, SyncSessionRecord>();
  return {
    async create(session: ActiveSyncSessionRecord) {
      const existing = sessions.get(session.sessionId);
      if (existing !== undefined) return { state: 'conflict', session: copy(existing) };
      sessions.set(session.sessionId, copy(session));
      return { state: 'created', session: copy(session) };
    },
    async load(sessionId) {
      const session = sessions.get(sessionId);
      return session === undefined ? undefined : copy(session);
    },
    async terminate(termination) {
      const existing = sessions.get(termination.sessionId);
      if (existing === undefined) return undefined;
      if (existing.status === 'active') {
        sessions.set(termination.sessionId, {
          ...existing,
          status: 'terminated',
          terminationReason: termination.reason,
          terminatedAt: termination.terminatedAt,
        });
      }
      return copy(sessions.get(termination.sessionId)!);
    },
    snapshot: () => new Map([...sessions].map(([id, session]) => [id, copy(session)])),
  };
}

/** Durable state behind {@link createInMemorySequenceUnitOfWork}. */
export interface InMemorySequenceState<Result> {
  readonly lanes: Map<string, SequenceLaneState>;
  readonly receipts: Map<string, StoredOperationReceipt<Result>>;
  readonly operationClaims: Map<string, SyncOperationClaim>;
  readonly reservedIds: Map<string, ServerIdResourceType>;
  readonly reuseAudits: Map<string, SyncOperationReuseAudit>;
}

export interface InMemorySequenceUnitOfWork<Result> extends SequenceCoordinatorUnitOfWork<Result> {
  /** Detached copy of the committed state, for assertions. */
  snapshot(): InMemorySequenceState<Result>;
}

function laneKey(lane: SequenceLaneKey): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope]);
}

function cloneSequenceState<Result>(state: InMemorySequenceState<Result>): InMemorySequenceState<Result> {
  return {
    lanes: copy(state.lanes),
    receipts: copy(state.receipts),
    operationClaims: copy(state.operationClaims),
    reservedIds: copy(state.reservedIds),
    reuseAudits: copy(state.reuseAudits),
  };
}

/**
 * Sequence unit of work that satisfies the adapter contract in memory:
 * transactions run one at a time (which also serializes every lane), each
 * works on a private copy, and that copy replaces the committed state only
 * when the callback resolves. A rejected callback leaves no trace.
 */
export function createInMemorySequenceUnitOfWork<Result>(): InMemorySequenceUnitOfWork<Result> {
  let committed: InMemorySequenceState<Result> = {
    lanes: new Map(),
    receipts: new Map(),
    operationClaims: new Map(),
    reservedIds: new Map(),
    reuseAudits: new Map(),
  };
  let queue: Promise<unknown> = Promise.resolve();

  function transaction(draft: InMemorySequenceState<Result>): SequenceCoordinatorTransaction<Result> {
    return {
      idReservations: {
        async reserveAll(reservations: readonly ServerIdReservation[]) {
          for (const requested of reservations) {
            const existing = draft.reservedIds.get(requested.id);
            if (existing !== undefined) {
              return {
                state: 'conflict',
                conflict: { requested: { ...requested }, existing: { id: requested.id, resourceType: existing } },
              };
            }
          }
          for (const { id, resourceType } of reservations) draft.reservedIds.set(id, resourceType);
          return { state: 'reserved' };
        },
      },
      operationClaims: {
        async load(operationId) {
          const claim = draft.operationClaims.get(operationId);
          return claim === undefined ? undefined : copy(claim);
        },
        async save(claim) {
          draft.operationClaims.set(claim.operationId, copy(claim));
        },
      },
      reuseAudits: {
        async append(audit) {
          const key = `reuse-audit-${draft.reuseAudits.size + 1}`;
          draft.reuseAudits.set(key, copy(audit));
          return key;
        },
        async load(key) {
          const audit = draft.reuseAudits.get(key);
          return audit === undefined ? undefined : copy(audit);
        },
      },
      receipts: {
        async load(lane, sequence) {
          const receipt = draft.receipts.get(`${laneKey(lane)}#${sequence}`);
          return receipt === undefined ? undefined : copy(receipt);
        },
        async save(receipt, condition) {
          const key = `${laneKey(receipt)}#${receipt.sequence}`;
          const existing = draft.receipts.get(key);
          const holds = condition.kind === 'absent'
            ? existing === undefined
            : existing?.status === 'deferred' && existing.digest === condition.digest;
          if (!holds) throw new Error(`Sequence receipt write condition ${condition.kind} did not hold.`);
          draft.receipts.set(key, copy(receipt));
        },
      },
      async loadLaneState(lane) {
        const state = draft.lanes.get(laneKey(lane));
        return state === undefined ? undefined : copy(state);
      },
      async saveLaneState(lane, state) {
        draft.lanes.set(laneKey(lane), copy(state));
      },
    };
  }

  return {
    operationIdReservationOwner: 'sequence',
    execute<Value>(
      _lane: SequenceLaneKey,
      work: (transaction: SequenceCoordinatorTransaction<Result>) => Promise<Value>,
    ): Promise<Value> {
      const run = queue.then(async () => {
        const draft = cloneSequenceState(committed);
        const value = await work(transaction(draft));
        committed = draft;
        return value;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    snapshot: () => cloneSequenceState(committed),
  };
}
