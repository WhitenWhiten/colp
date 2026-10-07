import { describe, expect, it, vi } from 'vitest';

import * as rootApi from '../../src/sync/index.js';
import {
  transformExportExtensionCarrier,
  type ConversionResult,
  type ConversionWarning,
} from '../../src/adapters/index.js';
import {
  loadSyncExtensionCarrier,
  relaySyncExtensionCarrier,
  type StoredSyncExtensionCarrier,
  type SyncExtensionRelayRequest,
  type SyncExtensionRelayResult,
  type SyncExtensionReceiptStore,
  type SyncExtensionReplacement,
  type SyncExtensionResourceKey,
  type SyncExtensionStore,
  type SyncExtensionStoreWrite,
  type SyncExtensionStoreWriteResult,
  type SyncExtensionTransaction,
  type SyncExtensionUnitOfWork,
  type SyncOperationClaim,
  type SyncOperationReuseAudit,
} from '../../src/sync/index.js';

const evidence = '[evidence:core.sync-unknown-extension-roundtrip]';
const unknownNamespace = 'https://future.vendor.example/extensions/opaque/v9';
const secondNamespace = 'https://another.vendor.example/extensions/state/v2';

type RelayResult = SyncExtensionRelayResult;

interface DurableState {
  readonly carriers: Map<string, StoredSyncExtensionCarrier>;
  readonly receipts: Map<string, RelayResult>;
  readonly operationClaims: Map<string, SyncOperationClaim>;
  readonly reuseAudits: Map<string, SyncOperationReuseAudit>;
  readonly reservedOperationIds: Set<string>;
}

function identity(key: SyncExtensionResourceKey): string {
  return `${key.resourceType}\u0000${key.resourceId}`;
}

function receiptIdentity(request: SyncExtensionRelayRequest): string {
  return JSON.stringify([
    request.operationId,
    request.replicaId,
    request.sequenceScope,
    request.sequence,
  ]);
}

function cloneCarrier(carrier: StoredSyncExtensionCarrier): StoredSyncExtensionCarrier {
  return structuredClone(carrier);
}

function cloneResult(result: RelayResult): RelayResult {
  return structuredClone(result);
}

function cloneState(state: DurableState): DurableState {
  return {
    carriers: new Map([...state.carriers].map(([key, carrier]) => [key, cloneCarrier(carrier)])),
    receipts: new Map([...state.receipts].map(([key, result]) => [key, cloneResult(result)])),
    operationClaims: new Map([...state.operationClaims].map(([key, claim]) => [key, structuredClone(claim)])),
    reuseAudits: new Map([...state.reuseAudits].map(([key, audit]) => [key, structuredClone(audit)])),
    reservedOperationIds: new Set(state.reservedOperationIds),
  };
}

class DurableMemoryExtensionAdapter implements SyncExtensionUnitOfWork {
  private state: DurableState;
  private queue: Promise<void> = Promise.resolve();

  failWrite = false;
  failReceipt = false;
  rejectAfterCommitOnce = false;
  mutateWriteInput = false;
  ignoreExpectedRevision = false;
  rejectUnknownWriteMembers = false;
  storedResultOverride?: (carrier: StoredSyncExtensionCarrier) => StoredSyncExtensionCarrier;
  savedReceiptOverride?: (result: RelayResult) => RelayResult;

  constructor(seed?: DurableState) {
    this.state = seed === undefined
      ? { carriers: new Map(), receipts: new Map(), operationClaims: new Map(), reuseAudits: new Map(), reservedOperationIds: new Set() }
      : cloneState(seed);
  }

  restart(): DurableMemoryExtensionAdapter {
    return new DurableMemoryExtensionAdapter(this.snapshot());
  }

  snapshot(): DurableState {
    return cloneState(this.state);
  }

  extensionStore(): SyncExtensionStore {
    return {
      load: async (key) => {
        const carrier = this.state.carriers.get(identity(key));
        return carrier === undefined ? undefined : cloneCarrier(carrier);
      },
      compareAndSet: async () => {
        throw new Error('Reads must not expose a non-transactional write path.');
      },
    };
  }

  execute<Result>(work: (transaction: SyncExtensionTransaction) => Promise<Result>): Promise<Result> {
    const run = async (): Promise<Result> => {
      const draft = cloneState(this.state);
      const result = await work(this.transaction(draft));
      this.state = draft;
      if (this.rejectAfterCommitOnce) {
        this.rejectAfterCommitOnce = false;
        throw new Error('commit outcome unknown');
      }
      return result;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private transaction(draft: DurableState): SyncExtensionTransaction {
    return {
      extensions: {
        load: async (key) => {
          const carrier = draft.carriers.get(identity(key));
          return carrier === undefined ? undefined : cloneCarrier(carrier);
        },
        compareAndSet: async (write) => this.compareAndSet(draft, write),
      },
      receipts: {
        load: async (request) => {
          const result = draft.receipts.get(receiptIdentity(request));
          return result === undefined ? undefined : cloneResult(result);
        },
        save: async (request, result) => {
          const saved = this.savedReceiptOverride?.(result) ?? result;
          draft.receipts.set(receiptIdentity(request), cloneResult(saved));
          if (this.failReceipt) throw new Error('injected receipt save failure');
        },
      },
      idReservations: {
        reserveAll: async (reservations) => {
          const conflict = reservations.find((reservation) => draft.reservedOperationIds.has(reservation.id));
          if (conflict !== undefined) {
            return {
              state: 'conflict' as const,
              conflict: {
                requested: structuredClone(conflict),
                existing: { id: conflict.id, resourceType: 'operation' as const },
              },
            };
          }
          for (const reservation of reservations) draft.reservedOperationIds.add(reservation.id);
          return { state: 'reserved' as const };
        },
      },
      operationClaims: {
        load: async (operationId) => {
          const claim = draft.operationClaims.get(operationId);
          return claim === undefined ? undefined : structuredClone(claim);
        },
        save: async (claim) => { draft.operationClaims.set(claim.operationId, structuredClone(claim)); },
      },
      reuseAudits: {
        append: async (audit) => {
          const key = `reuse-${draft.reuseAudits.size + 1}`;
          draft.reuseAudits.set(key, structuredClone(audit));
          return key;
        },
        load: async (key) => {
          const audit = draft.reuseAudits.get(key);
          return audit === undefined ? undefined : structuredClone(audit);
        },
      },
    };
  }

  private async compareAndSet(
    draft: DurableState,
    write: SyncExtensionStoreWrite,
  ): Promise<SyncExtensionStoreWriteResult> {
    if (this.failWrite) throw new Error('injected extension write failure');
    if (this.rejectUnknownWriteMembers) {
      expect(Object.keys(write).sort()).toEqual([
        'expectedRevision', 'key', 'replacement', 'revision',
      ]);
    }
    const current = draft.carriers.get(identity(write.key));
    const currentRevision = current?.revision ?? null;
    if (!this.ignoreExpectedRevision && currentRevision !== write.expectedRevision) {
      return {
        state: 'conflict',
        current: current === undefined ? undefined : cloneCarrier(current),
      };
    }

    const candidate: StoredSyncExtensionCarrier = {
      ...write.key,
      revision: write.revision,
      ...(write.replacement.kind === 'replace'
        ? { extensions: structuredClone(write.replacement.extensions) }
        : {}),
    };
    if (this.mutateWriteInput && write.replacement.kind === 'replace') {
      const mutable = write.replacement.extensions as Record<string, unknown>;
      mutable[unknownNamespace] = 'store-mutated-input';
    }
    const durable = this.storedResultOverride?.(candidate) ?? candidate;
    draft.carriers.set(identity(write.key), cloneCarrier(durable));
    return { state: 'stored', carrier: cloneCarrier(durable) };
  }
}

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
      extensions: {
        [unknownNamespace]: {
          falseValue: false,
          zeroValue: 0,
          emptyString: '',
          nullValue: null,
          nested: [{ arrays: [null, false, 0, '', { untouched: true }] }],
        },
      },
    },
    ...overrides,
  };
}

async function committed(
  adapter: DurableMemoryExtensionAdapter,
  value: SyncExtensionRelayRequest = request(),
): Promise<StoredSyncExtensionCarrier> {
  const result = await relaySyncExtensionCarrier(adapter, value);
  expect(result.state).toBe('committed');
  if (result.state !== 'committed') throw new Error('Expected committed relay result.');
  return result.carrier;
}

describe(`CORE-0033 durable unknown Sync Extension relay ${evidence}`, () => {
  it.each([
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
    ['empty array', []],
    ['nested arrays and objects', { a: [{ b: [false, 0, '', null, { c: [] }] }] }],
  ] as const)('stores and forwards an unknown namespace with a %s payload unchanged', async (_label, payload) => {
    const adapter = new DurableMemoryExtensionAdapter();
    const extensions = { [unknownNamespace]: payload };
    const carrier = await committed(adapter, request({
      replacement: { kind: 'replace', extensions },
    }));
    const loaded = await loadSyncExtensionCarrier(adapter.extensionStore(), collectionKey);

    expect(carrier.extensions).toEqual(extensions);
    expect(loaded).toEqual(carrier);
  });

  it('does not resolve until the extension write and receipt are durably committed', async () => {
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const durable = new DurableMemoryExtensionAdapter();
    const unitOfWork: SyncExtensionUnitOfWork = {
      execute: async (work) => {
        const pending = durable.execute(work);
        await commitGate;
        return pending;
      },
    };
    let settled = false;
    const relay = relaySyncExtensionCarrier(unitOfWork, request()).finally(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCommit();
    await expect(relay).resolves.toMatchObject({ state: 'committed' });
    expect(durable.snapshot().carriers.size).toBe(1);
    expect(durable.snapshot().receipts.size).toBe(1);
  });

  it.each([
    ['extension write', 'injected extension write failure'],
    ['receipt save', 'injected receipt save failure'],
  ] as const)('rolls the extension write and receipt back together after an injected %s failure', async (point, message) => {
    const adapter = new DurableMemoryExtensionAdapter();
    if (point === 'extension write') adapter.failWrite = true;
    else adapter.failReceipt = true;

    await expect(relaySyncExtensionCarrier(adapter, request())).rejects.toThrow(message);
    expect(adapter.snapshot().carriers.size).toBe(0);
    expect(adapter.snapshot().receipts.size).toBe(0);
  });

  it('recovers an unknown commit outcome by replaying the durable receipt exactly', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    adapter.rejectAfterCommitOnce = true;

    await expect(relaySyncExtensionCarrier(adapter, request())).rejects.toThrow('commit outcome unknown');
    const afterUnknownCommit = adapter.snapshot();
    expect(afterUnknownCommit.carriers.size).toBe(1);
    expect(afterUnknownCommit.receipts.size).toBe(1);

    const retried = await relaySyncExtensionCarrier(adapter, request());
    expect(retried).toEqual({
      state: 'replayed',
      carrier: afterUnknownCommit.carriers.get(identity(collectionKey)),
    });
    expect(adapter.snapshot()).toEqual(afterUnknownCommit);
  });

  it('reloads and exactly replays an unknown extension after process restart', async () => {
    const firstProcess = new DurableMemoryExtensionAdapter();
    const original = await committed(firstProcess);
    const restarted = firstProcess.restart();

    await expect(loadSyncExtensionCarrier(restarted.extensionStore(), collectionKey)).resolves.toEqual(original);
    await expect(relaySyncExtensionCarrier(restarted, request())).resolves.toEqual({
      state: 'replayed',
      carrier: original,
    });
    expect(restarted.snapshot().carriers.size).toBe(1);
  });

  it('rejects operation-id or Sequence reuse with another digest without changing canonical state', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    const original = await committed(adapter);
    const before = adapter.snapshot();

    await expect(relaySyncExtensionCarrier(adapter, request({
      digest: 'sha-256:different-request',
      replacement: { kind: 'delete' },
    }))).rejects.toMatchObject({ code: 'op_id_reused' });
    const after = adapter.snapshot();
    expect(after.carriers).toEqual(before.carriers);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.operationClaims).toEqual(before.operationClaims);
    expect(after.reuseAudits.size).toBe(before.reuseAudits.size + 1);
    await expect(loadSyncExtensionCarrier(adapter.extensionStore(), collectionKey)).resolves.toEqual(original);
  });

  it('rejects a same-digest forged receipt whose committed carrier is not the exact requested replacement', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    await committed(adapter);
    const corrupted = adapter.snapshot();
    corrupted.receipts.set(receiptIdentity(request()), {
      state: 'committed',
      digest: request().digest,
      carrier: {
        ...collectionKey,
        revision: 'revision-1',
        extensions: { [unknownNamespace]: 'forged' },
      },
    });

    await expect(relaySyncExtensionCarrier(
      new DurableMemoryExtensionAdapter(corrupted),
      request(),
    )).rejects.toThrow('receipt differs from the requested replacement');
  });

  it.each([
    ['Collection', { resourceType: 'collection', resourceId: 'collection-2' }],
    ['Node', { resourceType: 'node', resourceId: 'node-1' }],
    ['Annotation', { resourceType: 'annotation', resourceId: 'annotation-1' }],
    ['Attachment', { resourceType: 'attachment', resourceId: 'attachment-1' }],
    ['Relation', { resourceType: 'relation', resourceId: 'relation-1' }],
    ['Release', { resourceType: 'release', resourceId: 'release-1' }],
    ['Replica', { resourceType: 'replica', resourceId: 'replica-2' }],
  ] as const)('keeps %s carrier state isolated and forwards multiple namespaces', async (_label, key) => {
    const adapter = new DurableMemoryExtensionAdapter();
    const extensions = { [unknownNamespace]: false, [secondNamespace]: { count: 0 } };
    const carrier = await committed(adapter, request({
      operationId: `operation-${key.resourceId}`,
      sequenceScope: key.resourceId,
      key,
      replacement: { kind: 'replace', extensions },
    }));

    expect(carrier).toEqual({ ...key, revision: 'revision-1', extensions });
    await expect(loadSyncExtensionCarrier(adapter.extensionStore(), key)).resolves.toEqual(carrier);
  });

  it('distinguishes a missing extensions member from a present empty map across reload', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    const empty = await committed(adapter, request({
      replacement: { kind: 'replace', extensions: {} },
    }));
    expect(empty).toEqual({ ...collectionKey, revision: 'revision-1', extensions: {} });
    expect(Object.hasOwn(empty, 'extensions')).toBe(true);

    const deleted = await committed(adapter, request({
      operationId: 'operation-2', sequence: 2, digest: 'sha-256:delete',
      expectedRevision: 'revision-1', revision: 'revision-2', replacement: { kind: 'delete' },
    }));
    expect(deleted).toEqual({ ...collectionKey, revision: 'revision-2' });
    expect(Object.hasOwn(deleted, 'extensions')).toBe(false);
    const reloaded = await loadSyncExtensionCarrier(adapter.restart().extensionStore(), collectionKey);
    expect(reloaded).toEqual(deleted);
    expect(Object.hasOwn(reloaded!, 'extensions')).toBe(false);
  });

  it('replaces the complete extension map and deletes it only through explicit patch semantics', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    await committed(adapter, request({ replacement: {
      kind: 'replace', extensions: { [unknownNamespace]: 'old', [secondNamespace]: 'removed-by-replacement' },
    } }));
    const replaced = await committed(adapter, request({
      operationId: 'operation-2', sequence: 2, digest: 'sha-256:replace',
      expectedRevision: 'revision-1', revision: 'revision-2',
      replacement: { kind: 'replace', extensions: { [unknownNamespace]: 'new' } },
    }));
    expect(replaced.extensions).toEqual({ [unknownNamespace]: 'new' });
    expect(replaced.extensions).not.toHaveProperty(secondNamespace);

    const deleted = await committed(adapter, request({
      operationId: 'operation-3', sequence: 3, digest: 'sha-256:delete',
      expectedRevision: 'revision-2', revision: 'revision-3', replacement: { kind: 'delete' },
    }));
    expect(deleted).not.toHaveProperty('extensions');
  });

  it('serializes concurrent CAS writes so a stale revision conflicts without a lost update', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    await committed(adapter);
    const first = relaySyncExtensionCarrier(adapter, request({
      operationId: 'operation-2a', sequence: 2, digest: 'sha-256:first',
      expectedRevision: 'revision-1', revision: 'revision-2a',
      replacement: { kind: 'replace', extensions: { [unknownNamespace]: 'first' } },
    }));
    const stale = relaySyncExtensionCarrier(adapter, request({
      operationId: 'operation-2b', sequence: 2, digest: 'sha-256:stale',
      expectedRevision: 'revision-1', revision: 'revision-2b',
      replacement: { kind: 'replace', extensions: { [unknownNamespace]: 'stale' } },
    }));

    await expect(first).resolves.toMatchObject({ state: 'committed' });
    await expect(stale).resolves.toMatchObject({
      state: 'revision_conflict', currentRevision: 'revision-2a',
    });
    await expect(loadSyncExtensionCarrier(adapter.extensionStore(), collectionKey)).resolves.toMatchObject({
      revision: 'revision-2a', extensions: { [unknownNamespace]: 'first' },
    });
  });

  it('fails a stale revision closed even when a broken CAS adapter would ignore its expectation', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    await committed(adapter);
    adapter.ignoreExpectedRevision = true;
    const before = adapter.snapshot();

    await expect(relaySyncExtensionCarrier(adapter, request({
      operationId: 'operation-stale', sequence: 2, digest: 'sha-256:stale-preflight',
      expectedRevision: null, revision: 'revision-stale', replacement: { kind: 'delete' },
    }))).resolves.toEqual({ state: 'revision_conflict', currentRevision: 'revision-1' });
    expect(adapter.snapshot().carriers).toEqual(before.carriers);
  });

  it('rejects a store/load identity or revision mismatch instead of forwarding unverified state', async () => {
    const mismatches: Array<(carrier: StoredSyncExtensionCarrier) => StoredSyncExtensionCarrier> = [
      (carrier) => ({ ...carrier, resourceId: 'different-resource' }),
      (carrier) => ({ ...carrier, resourceType: 'node' }),
      (carrier) => ({ ...carrier, revision: 'different-revision' }),
    ];
    for (const mismatch of mismatches) {
      const adapter = new DurableMemoryExtensionAdapter();
      adapter.storedResultOverride = mismatch;
      await expect(relaySyncExtensionCarrier(adapter, request())).rejects.toThrow(TypeError);
      expect(adapter.snapshot().carriers.size).toBe(0);
      expect(adapter.snapshot().receipts.size).toBe(0);
    }

    for (const invalid of [
      { ...collectionKey, resourceId: 'different-resource', revision: 'revision-1' },
      { ...collectionKey, revision: 'revision-1', extensions: null },
    ]) {
      const invalidLoadStore: SyncExtensionStore = {
        load: async () => invalid as never,
        compareAndSet: async () => { throw new Error('unused'); },
      };
      await expect(loadSyncExtensionCarrier(invalidLoadStore, collectionKey)).rejects.toThrow(TypeError);
    }
  });

  it('rejects non-Promise, invalid, and mutating stores without exposing mutable canonical values', async () => {
    const nonPromise = {
      load: () => undefined,
      compareAndSet: () => ({ state: 'stored' }),
    } as unknown as SyncExtensionStore;
    await expect(loadSyncExtensionCarrier(nonPromise, collectionKey)).rejects.toThrow(TypeError);

    const invalidUnitOfWork: SyncExtensionUnitOfWork = {
      execute: async (work) => work({
        extensions: {
          load: async () => undefined,
          compareAndSet: async () => ({ state: 'stored' } as never),
        },
        receipts: {
          load: async () => undefined,
          save: async () => undefined,
        },
        idReservations: { reserveAll: async () => ({ state: 'reserved' }) },
        operationClaims: { load: async () => undefined, save: async () => undefined },
        reuseAudits: { append: async () => 'unused', load: async () => undefined },
      }),
    };
    await expect(relaySyncExtensionCarrier(invalidUnitOfWork, request())).rejects.toThrow(TypeError);

    const adapter = new DurableMemoryExtensionAdapter();
    adapter.mutateWriteInput = true;
    const callerExtensions = { [unknownNamespace]: { nested: ['original'] } };
    const before = structuredClone(callerExtensions);
    const carrier = await committed(adapter, request({
      replacement: { kind: 'replace', extensions: callerExtensions },
    }));
    expect(callerExtensions).toEqual(before);
    expect(carrier.extensions).toEqual(before);
    (callerExtensions[unknownNamespace].nested as string[])[0] = 'caller-mutated-after-return';
    expect(carrier.extensions).toEqual(before);
  });

  it.each(['unit of work', 'receipt load', 'compare-and-set', 'receipt save'] as const)(
    'rejects a non-Promise %s result',
    async (point) => {
      const adapter = new DurableMemoryExtensionAdapter();
      const unitOfWork: SyncExtensionUnitOfWork = point === 'unit of work'
        ? { execute: (() => undefined) as never }
        : {
            execute: async (work) => adapter.execute(async (transaction) => work({
              ...transaction,
              extensions: {
                load: transaction.extensions.load,
                compareAndSet: point === 'compare-and-set'
                  ? (() => ({ state: 'stored' })) as never
                  : transaction.extensions.compareAndSet,
              },
              receipts: {
                load: point === 'receipt load'
                  ? (() => undefined) as never
                  : transaction.receipts.load,
                save: point === 'receipt save'
                  ? (() => undefined) as never
                  : transaction.receipts.save,
              },
            })),
          };
      await expect(relaySyncExtensionCarrier(unitOfWork, request())).rejects.toThrow('must return a Promise');
      expect(adapter.snapshot().carriers.size).toBe(0);
      expect(adapter.snapshot().receipts.size).toBe(0);
    },
  );

  it('uses the exact declared CAS write shape and verifies the saved receipt by transaction-local read-back', async () => {
    const strict = new DurableMemoryExtensionAdapter();
    strict.rejectUnknownWriteMembers = true;
    await expect(relaySyncExtensionCarrier(strict, request())).resolves.toMatchObject({ state: 'committed' });

    const mismatched = new DurableMemoryExtensionAdapter();
    mismatched.savedReceiptOverride = (result) => result.state === 'committed'
      ? { ...result, carrier: { ...result.carrier, extensions: { [unknownNamespace]: 'partial' } } }
      : result;
    await expect(relaySyncExtensionCarrier(mismatched, request())).rejects.toThrow(
      'receipt differs from the requested replacement',
    );
    expect(mismatched.snapshot().carriers.size).toBe(0);
    expect(mismatched.snapshot().receipts.size).toBe(0);
  });

  it('rejects a UnitOfWork result substitution and recovers only through the committed receipt', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    const substituting: SyncExtensionUnitOfWork = {
      execute: async (work) => {
        await adapter.execute(work);
        return { state: 'receipt_conflict' } as never;
      },
    };

    await expect(relaySyncExtensionCarrier(substituting, request())).rejects.toThrow(
      'returned a result other than its transaction callback result',
    );
    await expect(relaySyncExtensionCarrier(adapter, request())).resolves.toMatchObject({ state: 'replayed' });
  });

  it('detaches and deeply freezes write results, load results, and replay results', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    const caller = request();
    const first = await committed(adapter, caller);
    const loaded = await loadSyncExtensionCarrier(adapter.extensionStore(), collectionKey);
    const replay = await relaySyncExtensionCarrier(adapter, caller);
    expect(replay.state).toBe('replayed');
    if (replay.state !== 'replayed') throw new Error('Expected replay.');

    for (const carrier of [first, loaded!, replay.carrier]) {
      expect(Object.isFrozen(carrier)).toBe(true);
      expect(Object.isFrozen(carrier.extensions)).toBe(true);
      expect(Object.isFrozen(carrier.extensions?.[unknownNamespace])).toBe(true);
      const payload = carrier.extensions?.[unknownNamespace] as { nested: unknown[] };
      expect(Object.isFrozen(payload.nested)).toBe(true);
      expect(() => { payload.nested[0] = 'mutated'; }).toThrow(TypeError);
    }
    expect(loaded).not.toBe(first);
    expect(replay.carrier).not.toBe(first);
  });

  it('never applies a removal or security policy while writing canonical storage', async () => {
    const decide = vi.fn(() => ({ action: 'remove', reason: 'projection-only' } as const));
    const adapter = new DurableMemoryExtensionAdapter();
    const original = await committed(adapter);

    expect(decide).not.toHaveBeenCalled();
    expect(adapter.snapshot().carriers.get(identity(collectionKey))).toEqual(original);
    expect(original.extensions).toHaveProperty(unknownNamespace);
  });

  it('may security-filter only a detached post-load projection and leaves authoritative state intact', async () => {
    const adapter = new DurableMemoryExtensionAdapter();
    const original = await committed(adapter, request({ replacement: {
      kind: 'replace', extensions: { [unknownNamespace]: 'private', [secondNamespace]: 'public' },
    } }));
    const policy = {
      id: 'projection-policy-v1',
      decide: vi.fn(({ namespace }: { readonly namespace: string }) => namespace === unknownNamespace
        ? { action: 'remove' as const, reason: 'not visible to this principal' }
        : { action: 'preserve' as const }),
    };
    const projected = await loadSyncExtensionCarrier(adapter.extensionStore(), collectionKey, {
      extensionSecurityPolicy: policy,
      extensionCarrierPath: '/collections/collection-1',
    });

    expect(projected?.extensions).toEqual({ [secondNamespace]: 'public' });
    expect(projected?.extensionRemovals).toEqual([expect.objectContaining({
      namespace: unknownNamespace,
      policyId: 'projection-policy-v1',
      reason: 'not visible to this principal',
    })]);
    expect(adapter.snapshot().carriers.get(identity(collectionKey))).toEqual(original);
    await expect(loadSyncExtensionCarrier(adapter.restart().extensionStore(), collectionKey)).resolves.toEqual(original);
  });

  it('keeps adapter lossy-conversion warnings as a separate non-storage non-regression', () => {
    const transformed = transformExportExtensionCarrier(
      { extensions: { [unknownNamespace]: 'opaque' } },
      { exported: true },
      {
        extensionSecurityPolicy: {
          id: 'adapter-loss-policy',
          decide: () => ({ action: 'remove', reason: 'target cannot represent namespace' }),
        },
      },
    );
    const warning: ConversionWarning = {
      code: 'lossy_conversion',
      message: 'Target cannot represent the unknown extension namespace.',
    };
    const conversion: ConversionResult<typeof transformed.value> = {
      value: transformed.value,
      lossless: false,
      warnings: [warning],
      extensionRemovals: transformed.extensionRemovals,
    };
    expect(conversion.warnings).toEqual([expect.objectContaining({ code: 'lossy_conversion' })]);
    expect(conversion.extensionRemovals).toHaveLength(1);
  });

  it('publishes the durable relay, read boundary, and repository types from public Sync surfaces', () => {
    expect(rootApi.relaySyncExtensionCarrier).toBe(relaySyncExtensionCarrier);
    expect(rootApi.loadSyncExtensionCarrier).toBe(loadSyncExtensionCarrier);

    const store: SyncExtensionStore = {} as SyncExtensionStore;
    const unitOfWork: SyncExtensionUnitOfWork = {} as SyncExtensionUnitOfWork;
    const transaction: SyncExtensionTransaction = {} as SyncExtensionTransaction;
    const write: SyncExtensionStoreWrite = {} as SyncExtensionStoreWrite;
    const writeResult: SyncExtensionStoreWriteResult = {} as SyncExtensionStoreWriteResult;
    const relayRequest: SyncExtensionRelayRequest = {} as SyncExtensionRelayRequest;
    const relayResult: SyncExtensionRelayResult = {} as SyncExtensionRelayResult;
    const receiptStore: SyncExtensionReceiptStore = {} as SyncExtensionReceiptStore;
    const replacement: SyncExtensionReplacement = {} as SyncExtensionReplacement;
    const stored: StoredSyncExtensionCarrier = {} as StoredSyncExtensionCarrier;
    const key: SyncExtensionResourceKey = {} as SyncExtensionResourceKey;
    expect([
      store, unitOfWork, transaction, write, writeResult, relayRequest, relayResult,
      receiptStore, replacement, stored, key,
    ]).toHaveLength(11);
  });
});
