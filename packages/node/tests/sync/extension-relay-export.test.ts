import { describe, expect, it } from 'vitest';

import {
  loadSyncExtensionCarrier,
  relaySyncExtensionCarrier,
  type StoredSyncExtensionCarrier,
  type SyncExtensionRelayRequest,
  type SyncExtensionRelayResult,
  type SyncExtensionResourceKey,
  type SyncExtensionUnitOfWork,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.extension-relay-export]';
const namespace = 'https://vendor.example/extensions/opaque/v1';

const collectionKey = {
  resourceType: 'collection',
  resourceId: 'collection-1',
} as const satisfies SyncExtensionResourceKey;

function request(
  overrides: Partial<SyncExtensionRelayRequest> = {},
): SyncExtensionRelayRequest {
  return {
    operationId: 'operation-1',
    replicaId: 'replica-1',
    sequenceScope: 'collection-1',
    sequence: 1,
    digest: 'sha-256:opaque-request-1',
    key: collectionKey,
    expectedRevision: null,
    revision: 'revision-1',
    replacement: {
      kind: 'replace',
      extensions: { [namespace]: { nested: [true] } },
    },
    ...overrides,
  };
}

function receiptKey(candidate: SyncExtensionRelayRequest): string {
  return JSON.stringify([
    candidate.operationId,
    candidate.replicaId,
    candidate.sequenceScope,
    candidate.sequence,
  ]);
}

/** Minimal in-memory UoW with draft commit; optional receipt mutation exercises read-back. */
function memoryRelayUnitOfWork(options: {
  readonly corruptSavedReceipt?: boolean;
} = {}): SyncExtensionUnitOfWork & {
  readonly carriers: Map<string, StoredSyncExtensionCarrier>;
  readonly receipts: Map<string, SyncExtensionRelayResult>;
} {
  const carriers = new Map<string, StoredSyncExtensionCarrier>();
  const receipts = new Map<string, SyncExtensionRelayResult>();
  const operationClaims = new Map<string, SyncOperationClaim>();
  const reuseAudits = new Map<string, SyncOperationReuseAudit>();
  const reservedOperationIds = new Set<string>();
  const resourceId = (key: SyncExtensionResourceKey) => `${key.resourceType}\0${key.resourceId}`;

  const cloneCarriers = () => new Map(
    [...carriers].map(([key, value]) => [key, structuredClone(value)]),
  );
  const cloneReceipts = () => new Map(
    [...receipts].map(([key, value]) => [key, structuredClone(value)]),
  );

  return {
    carriers,
    receipts,
    execute: async (work) => {
      const draftCarriers = cloneCarriers();
      const draftReceipts = cloneReceipts();
      const draftOperationClaims = new Map(
        [...operationClaims].map(([key, value]) => [key, structuredClone(value)]),
      );
      const draftReuseAudits = new Map(
        [...reuseAudits].map(([key, value]) => [key, structuredClone(value)]),
      );
      const draftReservedOperationIds = new Set(reservedOperationIds);
      const result = await work({
        extensions: {
          load: async (key) => {
            const stored = draftCarriers.get(resourceId(key));
            return stored === undefined ? undefined : structuredClone(stored);
          },
          compareAndSet: async (write) => {
            const current = draftCarriers.get(resourceId(write.key));
            const currentRevision = current?.revision ?? null;
            if (currentRevision !== write.expectedRevision) {
              return {
                state: 'conflict' as const,
                current: current === undefined ? undefined : structuredClone(current),
              };
            }
            const carrier: StoredSyncExtensionCarrier = {
              ...write.key,
              revision: write.revision,
              ...(write.replacement.kind === 'replace'
                ? { extensions: structuredClone(write.replacement.extensions) }
                : {}),
            };
            draftCarriers.set(resourceId(write.key), structuredClone(carrier));
            return { state: 'stored' as const, carrier: structuredClone(carrier) };
          },
        },
        receipts: {
          load: async (candidate) => {
            const stored = draftReceipts.get(receiptKey(candidate));
            return stored === undefined ? undefined : structuredClone(stored);
          },
          save: async (candidate, result) => {
            const saved: SyncExtensionRelayResult = options.corruptSavedReceipt
              && result.state === 'committed'
              ? {
                  state: 'committed' as const,
                  ...(result.digest === undefined ? {} : { digest: result.digest }),
                  carrier: {
                    ...result.carrier,
                    extensions: { [namespace]: { nested: ['corrupted-read-back'] } },
                  },
                }
              : result;
            draftReceipts.set(receiptKey(candidate), structuredClone(saved));
          },
        },
        idReservations: {
          reserveAll: async (reservations) => {
            const conflict = reservations.find((reservation) => draftReservedOperationIds.has(reservation.id));
            if (conflict !== undefined) {
              return {
                state: 'conflict' as const,
                conflict: {
                  requested: structuredClone(conflict),
                  existing: { id: conflict.id, resourceType: 'operation' as const },
                },
              };
            }
            for (const reservation of reservations) draftReservedOperationIds.add(reservation.id);
            return { state: 'reserved' as const };
          },
        },
        operationClaims: {
          load: async (operationId) => {
            const claim = draftOperationClaims.get(operationId);
            return claim === undefined ? undefined : structuredClone(claim);
          },
          save: async (claim) => { draftOperationClaims.set(claim.operationId, structuredClone(claim)); },
        },
        reuseAudits: {
          append: async (audit) => {
            const key = `reuse-${draftReuseAudits.size + 1}`;
            draftReuseAudits.set(key, structuredClone(audit));
            return key;
          },
          load: async (key) => {
            const audit = draftReuseAudits.get(key);
            return audit === undefined ? undefined : structuredClone(audit);
          },
        },
      });
      // Commit only after the coordinator callback resolves (fail-closed on throw).
      carriers.clear();
      for (const [key, value] of draftCarriers) carriers.set(key, value);
      receipts.clear();
      for (const [key, value] of draftReceipts) receipts.set(key, value);
      operationClaims.clear();
      for (const [key, value] of draftOperationClaims) operationClaims.set(key, value);
      reuseAudits.clear();
      for (const [key, value] of draftReuseAudits) reuseAudits.set(key, value);
      reservedOperationIds.clear();
      for (const id of draftReservedOperationIds) reservedOperationIds.add(id);
      return result;
    },
  };
}

describe(`Sync extension relay behavior ${evidence}`, () => {
  it(`rejects a receipt whose transaction-local read-back diverges from the requested replacement ${evidence}`, async () => {
    const unitOfWork = memoryRelayUnitOfWork({ corruptSavedReceipt: true });

    await expect(relaySyncExtensionCarrier(unitOfWork, request())).rejects.toThrow(
      /receipt differs from the requested replacement|failed transaction-local read-back/i,
    );
    expect(unitOfWork.carriers.size).toBe(0);
    expect(unitOfWork.receipts.size).toBe(0);
  });

  it(`rejects non-Promise adapter results on the public relay and load paths ${evidence}`, async () => {
    await expect(
      relaySyncExtensionCarrier({ execute: (() => undefined) as never }, request()),
    ).rejects.toThrow(/must return a Promise/i);

    await expect(
      loadSyncExtensionCarrier({
        load: (() => undefined) as never,
        compareAndSet: async () => ({ state: 'stored', carrier: {
          ...collectionKey,
          revision: 'revision-1',
        } }),
      }, collectionKey),
    ).rejects.toThrow(/must return a Promise/i);
  });

  it(`commits and reloads a clean carrier through the public relay path ${evidence}`, async () => {
    const unitOfWork = memoryRelayUnitOfWork();
    const result = await relaySyncExtensionCarrier(unitOfWork, request());

    expect(result).toMatchObject({
      state: 'committed',
      carrier: {
        ...collectionKey,
        revision: 'revision-1',
        extensions: { [namespace]: { nested: [true] } },
      },
    });
    await expect(
      loadSyncExtensionCarrier({
        load: async (key) => {
          const stored = unitOfWork.carriers.get(`${key.resourceType}\0${key.resourceId}`);
          return stored === undefined ? undefined : structuredClone(stored);
        },
        compareAndSet: async () => {
          throw new Error('load path must not write');
        },
      }, collectionKey),
    ).resolves.toEqual(result.state === 'committed' ? result.carrier : undefined);
  });

  it(`retains one lifetime Operation claim when the tuple changes after a receipt exists ${evidence}`, async () => {
    const unitOfWork = memoryRelayUnitOfWork();
    await expect(relaySyncExtensionCarrier(unitOfWork, request())).resolves.toMatchObject({ state: 'committed' });

    await expect(relaySyncExtensionCarrier(unitOfWork, request({
      replicaId: 'replica-other',
      sequenceScope: 'collection-other',
      sequence: 7,
      digest: 'sha-256:changed-tuple',
      expectedRevision: 'revision-1',
      revision: 'revision-2',
    }))).rejects.toMatchObject({ code: 'op_id_reused' });
    expect(unitOfWork.carriers.get('collection\0collection-1')).toMatchObject({ revision: 'revision-1' });
  });
});
