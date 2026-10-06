import { describe, expect, it } from 'vitest';

import * as publicSyncApi from '../../src/sync/index.js';
import {
  loadSyncExtensionCarrier,
  relaySyncExtensionCarrier,
  type StoredSyncExtensionCarrier,
  type SyncExtensionRelayRequest,
  type SyncExtensionRelayResult,
  type SyncExtensionResourceKey,
  type SyncExtensionUnitOfWork,
} from '../../src/sync/index.js';
import * as syncApi from '../../src/sync/index.js';

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
      });
      // Commit only after the coordinator callback resolves (fail-closed on throw).
      carriers.clear();
      for (const [key, value] of draftCarriers) carriers.set(key, value);
      receipts.clear();
      for (const [key, value] of draftReceipts) receipts.set(key, value);
      return result;
    },
  };
}

describe(`public Sync extension relay surface ${evidence}`, () => {
  it(`re-exports the relay and load entry points from the Sync public entry ${evidence}`, () => {
    expect(publicSyncApi.relaySyncExtensionCarrier).toBe(relaySyncExtensionCarrier);
    expect(publicSyncApi.loadSyncExtensionCarrier).toBe(loadSyncExtensionCarrier);
    expect(syncApi.relaySyncExtensionCarrier).toBe(relaySyncExtensionCarrier);
    expect(syncApi.loadSyncExtensionCarrier).toBe(loadSyncExtensionCarrier);
    expect(publicSyncApi.relaySyncExtensionCarrier).toBe(syncApi.relaySyncExtensionCarrier);
    expect(publicSyncApi.loadSyncExtensionCarrier).toBe(syncApi.loadSyncExtensionCarrier);
  });

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
});
