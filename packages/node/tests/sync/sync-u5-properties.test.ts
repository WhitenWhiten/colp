/**
 * U-5 Sync property invariants (contracted only).
 * Design cards: reports/audit/property-design-cards-u5.md (U5-Y1..Y2).
 *
 * Do not use production digest helpers as oracle.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  createSyncSession,
  verifySyncSessionContext,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceLaneKey,
  type SequenceLaneState,
  type SequenceOperationRequest,
  type SequenceReceiptWriteCondition,
  type StoredOperationReceipt,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
  type SyncSessionBinding,
  type SyncSessionRecord,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type TerminalOperationStatus,
  type VerifySyncSessionContextInput,
} from '../../src/sync/index.js';
import {
  coordinateSequenceOperation,
} from '../../src/sync/unsafe.js';
import { propertyOptions } from '../helpers/property-options.js';

const evidence = '[review:sync.u5-properties]';
const RUNS = 40;

const options = (numRuns = RUNS) => propertyOptions(numRuns);

const opaqueId = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/);

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

type MutableBinding = {
  -readonly [Key in keyof SyncSessionBinding]: SyncSessionBinding[Key]
};

function collectionInput(overrides: Partial<CreateSyncSessionInput> = {}): CreateSyncSessionInput {
  return {
    sessionId: 'session-u5',
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
    terminatedAt: '2026-07-18T02:00:00Z',
    ...overrides,
  };
}

type BindingMutation =
  | { readonly field: 'principal'; readonly value: SyncSessionBinding['principal'] }
  | { readonly field: 'credential'; readonly value: SyncSessionBinding['credential'] }
  | { readonly field: 'oauthClientId'; readonly value: string }
  | { readonly field: 'origin'; readonly value: string }
  | {
      readonly field: 'protocolVersion';
      readonly value: SyncSessionBinding['protocolVersion'];
    }
  | { readonly field: 'collectionId'; readonly value: string };

const bindingMutation = fc.oneof(
  opaqueId.map((id): BindingMutation => ({
    field: 'principal',
    value: { type: 'user', id: id === 'alice' ? 'mallory' : id },
  })),
  opaqueId.map((id): BindingMutation => ({
    field: 'credential',
    value: { kind: 'token', id: id === 'token-1' ? 'token-other' : id },
  })),
  opaqueId.map((id): BindingMutation => ({
    field: 'oauthClientId',
    value: `https://other.example/${id}`,
  })),
  opaqueId.map((id): BindingMutation => ({
    field: 'origin',
    value: `https://other-${id}.example`,
  })),
  // Only alternate legal protocol versions (0.1|0.2); 0.3 fails closed at input validation.
  fc.constant('0.2').map((value): BindingMutation => ({
    field: 'protocolVersion',
    value,
  })),
  opaqueId.map((id): BindingMutation => ({
    field: 'collectionId',
    value: id === 'collection-1' ? 'collection-other' : id,
  })),
);

describe(`U-5 session binding isolation ${evidence}`, () => {
  it(`regression: principal-only binding change yields context_mismatch ${evidence}`, async () => {
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ sessionId: 'session-u5-regression' });
    const created = await createSyncSession(store, input);
    const different = copy(binding(input)) as MutableBinding;
    different.principal = { type: 'user', id: 'mallory' };
    await expect(
      verifySyncSessionContext(store, verification(input, { binding: different })),
    ).resolves.toEqual({ state: 'context_mismatch' });
    await expect(store.load(input.sessionId)).resolves.toEqual(created);
  });

  it(`regression: protocolVersion-only change (0.1→0.2) yields context_mismatch ${evidence}`, async () => {
    // Counterexample seed=1398361653 path=1:0:0 used invalid 0.3; legal alternate is 0.2.
    const store = new DurableMemorySessionStore();
    const input = collectionInput({ sessionId: 'session-u5-protocol' });
    const created = await createSyncSession(store, input);
    const different = copy(binding(input)) as MutableBinding;
    different.protocolVersion = '0.2';
    await expect(
      verifySyncSessionContext(store, verification(input, { binding: different })),
    ).resolves.toEqual({ state: 'context_mismatch' });
    await expect(store.load(input.sessionId)).resolves.toEqual(created);
  });

  it(`any single binding dimension change cannot reuse the Session proof ${evidence}`, async () => {
    await fc.assert(
      fc.asyncProperty(opaqueId, bindingMutation, async (sessionId, mutation) => {
        const store = new DurableMemorySessionStore();
        const input = collectionInput({ sessionId });
        const created = await createSyncSession(store, input);
        const different = copy(binding(input)) as MutableBinding;
        switch (mutation.field) {
          case 'principal':
            different.principal = mutation.value;
            break;
          case 'credential':
            different.credential = mutation.value;
            break;
          case 'oauthClientId':
            different.oauthClientId = mutation.value;
            break;
          case 'origin':
            different.origin = mutation.value;
            break;
          case 'protocolVersion':
            different.protocolVersion = mutation.value;
            break;
          case 'collectionId':
            different.collectionId = mutation.value;
            break;
        }
        // Independent oracle: structural inequality of any binding field ⇒ mismatch.
        const verified = await verifySyncSessionContext(
          store,
          verification(input, { binding: different }),
        );
        expect(verified).toEqual({ state: 'context_mismatch' });
        await expect(store.load(sessionId)).resolves.toEqual(created);
      }),
      options(),
    );
  });
});

type OpResult = Readonly<Record<string, unknown>> & {
  readonly status: TerminalOperationStatus | 'deferred';
};

interface SeqState {
  readonly lanes: Map<string, SequenceLaneState>;
  readonly receipts: Map<string, StoredOperationReceipt<OpResult>>;
  readonly operationClaims: Map<string, SyncOperationClaim>;
  readonly reuseAudits: Map<string, SyncOperationReuseAudit>;
}

function laneIdentity(lane: SequenceLaneKey): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope]);
}

function receiptIdentity(lane: SequenceLaneKey, sequence: number): string {
  return JSON.stringify([lane.replicaId, lane.sequenceScope, sequence]);
}

function cloneState(state: SeqState): SeqState {
  return {
    lanes: new Map([...state.lanes].map(([key, value]) => [key, structuredClone(value)])),
    receipts: new Map([...state.receipts].map(([key, value]) => [key, structuredClone(value)])),
    operationClaims: new Map(
      [...state.operationClaims].map(([key, value]) => [key, structuredClone(value)]),
    ),
    reuseAudits: new Map([...state.reuseAudits].map(([key, value]) => [key, structuredClone(value)])),
  };
}

class SeqBackend {
  state: SeqState = {
    lanes: new Map(),
    receipts: new Map(),
    operationClaims: new Map(),
    reuseAudits: new Map(),
  };
  readonly laneTails = new Map<string, Promise<void>>();
}

class SeqHandle implements SequenceCoordinatorUnitOfWork<OpResult> {
  readonly operationIdReservationOwner = 'sequence' as const;

  constructor(readonly backend = new SeqBackend()) {}

  execute<Value>(
    lane: SequenceLaneKey,
    work: (transaction: SequenceCoordinatorTransaction<OpResult>) => Promise<Value>,
  ): Promise<Value> {
    const identity = laneIdentity(lane);
    const previous = this.backend.laneTails.get(identity) ?? Promise.resolve();
    const run = async (): Promise<Value> => {
      const draft = cloneState(this.backend.state);
      const result = await work({
        idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
        operationClaims: {
          load: async (id: string) => structuredClone(draft.operationClaims.get(id)),
          save: async (claim: SyncOperationClaim) => {
            draft.operationClaims.set(claim.operationId, structuredClone(claim));
          },
        },
        reuseAudits: {
          append: async (audit: SyncOperationReuseAudit) => {
            const key = `reuse-${draft.reuseAudits.size + 1}`;
            draft.reuseAudits.set(key, structuredClone(audit));
            return key;
          },
          load: async (key: string) => structuredClone(draft.reuseAudits.get(key)),
        },
        loadLaneState: async (target) => {
          const state = draft.lanes.get(laneIdentity(target));
          return state === undefined ? undefined : structuredClone(state);
        },
        saveLaneState: async (target, state) => {
          draft.lanes.set(laneIdentity(target), structuredClone(state));
        },
        receipts: {
          load: async (target, sequence) => {
            const receipt = draft.receipts.get(receiptIdentity(target, sequence));
            return receipt === undefined ? undefined : structuredClone(receipt);
          },
          save: async (receipt, _condition: SequenceReceiptWriteCondition) => {
            draft.receipts.set(receiptIdentity(receipt, receipt.sequence), structuredClone(receipt));
          },
        },
      });
      this.backend.state = draft;
      return result;
    };
    const outcome = previous.then(run, run);
    this.backend.laneTails.set(
      identity,
      outcome.then(
        () => undefined,
        () => undefined,
      ),
    );
    return outcome;
  }
}

function seqRequest(overrides: Partial<SequenceOperationRequest> = {}): SequenceOperationRequest {
  return {
    operationId: 'operation-u5-1',
    replicaId: 'replica-1',
    sequenceScope: 'collection-1',
    sequence: 1,
    digest: 'sha-256:operation-u5-1',
    ...overrides,
  };
}

const seqModel = fc.record({
  operationId: opaqueId,
  replicaId: opaqueId,
  sequenceScope: opaqueId,
  sequence: fc.integer({ min: 1, max: 8 }),
  digestTail: opaqueId,
  revision: opaqueId,
}).map((model) => ({
  operationId: model.operationId,
  replicaId: model.replicaId,
  sequenceScope: model.sequenceScope,
  sequence: model.sequence,
  digest: `sha-256:${model.digestTail}`,
  altDigest: `sha-256:alt-${model.digestTail}`,
  revision: model.revision,
}));

describe(`U-5 sequence replay determinism / fail-closed ${evidence}`, () => {
  it(`regression: divergent digest after applied is sequence_reuse without lane advance ${evidence}`, async () => {
    const handle = new SeqHandle();
    const request = seqRequest();
    const first = await coordinateSequenceOperation<OpResult>(handle, request, async () => ({
      status: 'applied' as const,
      result: {
        status: 'applied' as const,
        revision: 'revision-1',
        cursor: 'cursor-1',
        warnings: [],
      },
    }));
    expect(first.kind).toBe('executed');
    const laneBefore = structuredClone(handle.backend.state.lanes.get(laneIdentity(request)));
    const receiptsBefore = structuredClone(
      handle.backend.state.receipts.get(receiptIdentity(request, request.sequence)),
    );
    const conflict = await coordinateSequenceOperation<OpResult>(
      handle,
      { ...request, digest: 'sha-256:different' },
      async () => ({
        status: 'applied' as const,
        result: {
          status: 'applied' as const,
          revision: 'revision-2',
          cursor: 'cursor-2',
          warnings: [],
        },
      }),
    );
    expect(conflict).toMatchObject({ kind: 'sequence_reuse' });
    expect(handle.backend.state.lanes.get(laneIdentity(request))).toEqual(laneBefore);
    expect(handle.backend.state.receipts.get(receiptIdentity(request, request.sequence))).toEqual(
      receiptsBefore,
    );
  });

  it(`same digest replays the durable receipt; divergent digest fails closed ${evidence}`, async () => {
    await fc.assert(
      fc.asyncProperty(seqModel, async (model) => {
        const handle = new SeqHandle();
        const request = seqRequest({
          operationId: model.operationId,
          replicaId: model.replicaId,
          sequenceScope: model.sequenceScope,
          sequence: model.sequence,
          digest: model.digest,
        });
        let executions = 0;
        const evaluate = async () => {
          executions += 1;
          return {
            status: 'applied' as const,
            result: {
              status: 'applied' as const,
              revision: model.revision,
              cursor: `cursor-${model.sequence}`,
              warnings: [] as string[],
            },
          };
        };

        // Seed prior sequences so the requested sequence is next.
        handle.backend.state.lanes.set(laneIdentity(request), { nextSequence: model.sequence });

        const first = await coordinateSequenceOperation<OpResult>(handle, request, evaluate);
        expect(first.kind).toBe('executed');
        if (first.kind !== 'executed') return;
        expect(executions).toBe(1);

        const replayed = await coordinateSequenceOperation<OpResult>(handle, request, evaluate);
        expect(replayed.kind).toBe('replayed');
        if (replayed.kind === 'replayed') {
          expect(replayed.receipt).toEqual(first.receipt);
        }
        expect(executions).toBe(1);

        const laneBefore = structuredClone(handle.backend.state.lanes.get(laneIdentity(request)));
        const receiptBefore = structuredClone(
          handle.backend.state.receipts.get(receiptIdentity(request, request.sequence)),
        );
        const conflict = await coordinateSequenceOperation<OpResult>(
          handle,
          { ...request, digest: model.altDigest },
          evaluate,
        );
        expect(conflict).toMatchObject({ kind: 'sequence_reuse' });
        expect(handle.backend.state.lanes.get(laneIdentity(request))).toEqual(laneBefore);
        expect(
          handle.backend.state.receipts.get(receiptIdentity(request, request.sequence)),
        ).toEqual(receiptBefore);
        expect(executions).toBe(1);
      }),
      options(),
    );
  });
});
