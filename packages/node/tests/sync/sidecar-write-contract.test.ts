import { describe, expect, it } from 'vitest';
import { persistSyncSidecar, type SyncSidecarAdapter, type SyncSidecarRecord } from '../../src/sync/sidecar.js';

const evidence = '[evidence:sync.sidecar-write]';

type Record = SyncSidecarRecord<string, string, string, string, string, number, { readonly value: string }>;

const record: Record = {
  browser: 'firefox',
  profile: 'bookmarks-v1',
  collectionId: 'collection-1',
  nodeId: 'node-1',
  nativeId: 'native-1',
  generation: 0,
  data: { value: 'preserved' },
};

function adapterFor(
  initial?: Record,
  options: { readonly failWrite?: boolean; readonly dropWrite?: boolean; readonly mismatch?: boolean } = {},
): SyncSidecarAdapter<Record> & { readonly state: Map<string, Record>; readonly trace: string[] } {
  const state = new Map<string, Record>(initial === undefined ? [] : [[initial.nodeId, structuredClone(initial)]]);
  const trace: string[] = [];
  return {
    state,
    trace,
    async writeSidecar(next) {
      trace.push('write');
      if (options.failWrite) throw new Error('sidecar write failed');
      if (!options.dropWrite) state.set(next.nodeId, structuredClone(next));
    },
    async loadSidecar(nodeId) {
      trace.push('read');
      const loaded = state.get(nodeId);
      if (loaded === undefined) return undefined;
      if (!options.mismatch) return structuredClone(loaded);
      return { ...structuredClone(loaded), nodeId: 'wrong-node' };
    },
  };
}

describe(`SYNC-0024 local Sidecar write contract ${evidence}`, () => {
  it(`writes the complete record before transaction-local read-back ${evidence}`, async () => {
    const adapter = adapterFor();

    await expect(persistSyncSidecar(record, adapter)).resolves.toEqual(record);
    expect(adapter.trace).toEqual(['write', 'read']);
    expect(adapter.state.get(record.nodeId)).toEqual(record);
  });

  it(`waits for an asynchronous write and never reads before it settles ${evidence}`, async () => {
    const adapter = adapterFor();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalWrite = adapter.writeSidecar;
    (adapter as { writeSidecar: SyncSidecarAdapter<Record>['writeSidecar'] }).writeSidecar = async (next) => {
      adapter.trace.push('write-start');
      await gate;
      await originalWrite!(next);
      adapter.trace.push('write-end');
    };

    const pending = persistSyncSidecar(record, adapter);
    await Promise.resolve();
    expect(adapter.trace).toEqual(['write-start']);
    release();
    await expect(pending).resolves.toEqual(record);
    expect(adapter.trace).toEqual(['write-start', 'write', 'write-end', 'read']);
  });

  it.each([
    ['write rejection', adapterFor(undefined, { failWrite: true }), /sidecar write failed/u],
    ['silent write drop', adapterFor(undefined, { dropWrite: true }), /not durably persisted/u],
    ['read-back identity mismatch', adapterFor(record, { mismatch: true }), /does not match/u],
  ] as const)(`fails closed on %s without accepting partial state ${evidence}`, async (_label, adapter, error) => {
    const before = structuredClone([...adapter.state.entries()]);
    await expect(persistSyncSidecar(record, adapter)).rejects.toThrow(error);
    expect(adapter.state).toEqual(new Map(before));
  });

  it.each([
    ['browser', { ...record, browser: '' }],
    ['profile', { ...record, profile: '   ' }],
    ['collection', { ...record, collectionId: null as unknown as string }],
    ['node', { ...record, nodeId: '' }],
    ['native', { ...record, nativeId: undefined as unknown as string }],
  ] as const)(`rejects an invalid %s identifier before any sidecar write ${evidence}`, async (_label, invalid) => {
    const adapter = adapterFor();
    await expect(persistSyncSidecar(invalid, adapter)).rejects.toThrow(/identifier/u);
    expect(adapter.trace).toEqual([]);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN] as const)(
    `rejects generation boundary %s before any sidecar write ${evidence}`,
    async (generation) => {
      const adapter = adapterFor();
      await expect(persistSyncSidecar({ ...record, generation }, adapter)).rejects.toThrow(/generation/u);
      expect(adapter.trace).toEqual([]);
    },
  );

  it(`rejects a synchronous write boundary before reading or mutating durable state ${evidence}`, async () => {
    const adapter = adapterFor();
    const before = structuredClone([...adapter.state.entries()]);
    (adapter as { writeSidecar: SyncSidecarAdapter<Record>['writeSidecar'] }).writeSidecar =
      (() => undefined) as unknown as SyncSidecarAdapter<Record>['writeSidecar'];

    await expect(persistSyncSidecar(record, adapter)).rejects.toThrow(/must return a Promise/u);
    expect(adapter.state).toEqual(new Map(before));
    expect(adapter.trace).toEqual([]);
  });

  it(`rejects when the adapter provides neither writeSidecar nor saveSidecar ${evidence}`, async () => {
    const loadCalls: string[] = [];
    const adapter: SyncSidecarAdapter<Record> = {
      async loadSidecar(nodeId) {
        loadCalls.push(String(nodeId));
        return undefined;
      },
    };

    await expect(persistSyncSidecar(record, adapter)).rejects.toThrow(TypeError);
    await expect(persistSyncSidecar(record, adapter)).rejects.toThrow(/write boundary/u);
    expect(loadCalls).toEqual([]);
  });

  it(`uses saveSidecar when writeSidecar is absent and still read-backs by nodeId ${evidence}`, async () => {
    const state = new Map<string, Record>();
    const loadKeys: string[] = [];
    const adapter: SyncSidecarAdapter<Record> = {
      async saveSidecar(next) {
        // Deliberately store only under nodeId so a nativeId load key would fail.
        state.set(next.nodeId, structuredClone(next));
      },
      async loadSidecar(nodeId) {
        loadKeys.push(String(nodeId));
        return state.get(nodeId) === undefined ? undefined : structuredClone(state.get(nodeId)!);
      },
    };

    await expect(persistSyncSidecar(record, adapter)).resolves.toEqual(record);
    expect(loadKeys).toEqual([record.nodeId]);
    expect(state.has(record.nativeId)).toBe(false);
    expect(state.get(record.nodeId)).toEqual(record);
  });

  it(`loads by protocol nodeId and never treats nativeId as the durable load key ${evidence}`, async () => {
    const loadKeys: string[] = [];
    // Map is keyed only by nativeId so a mistaken nativeId load key would "succeed"
    // while the production nodeId key correctly fails closed on missing read-back.
    const byNative = new Map<string, Record>([[record.nativeId, structuredClone(record)]]);
    const adapter: SyncSidecarAdapter<Record> = {
      async writeSidecar(next) {
        byNative.set(next.nativeId, structuredClone(next));
      },
      async loadSidecar(nodeId) {
        loadKeys.push(String(nodeId));
        return byNative.get(String(nodeId));
      },
    };

    await expect(persistSyncSidecar(record, adapter)).rejects.toThrow(/not durably persisted/u);
    expect(loadKeys).toEqual([record.nodeId]);
    expect(loadKeys).not.toContain(record.nativeId);
  });

  it(`rejects a non-Promise saveSidecar boundary as TypeError ${evidence}`, async () => {
    const adapter: SyncSidecarAdapter<Record> = {
      // Intentionally non-Promise write to exercise the Promise boundary.
      saveSidecar: (() => undefined) as unknown as (record: Record) => Promise<void>,
      async loadSidecar() {
        return undefined;
      },
    };

    await expect(persistSyncSidecar(record, adapter)).rejects.toThrow(TypeError);
    await expect(persistSyncSidecar(record, adapter)).rejects.toThrow(/must return a Promise/u);
  });

  it(`rejects a non-Promise loadSidecar read-back after a successful write ${evidence}`, async () => {
    const adapter: SyncSidecarAdapter<Record> = {
      async writeSidecar() {
        /* committed */
      },
      // Intentionally non-Promise read-back to exercise the Promise boundary.
      loadSidecar: (() => record) as unknown as (nodeId: string) => Promise<Record | undefined>,
    };

    await expect(persistSyncSidecar(record, adapter)).rejects.toThrow(TypeError);
    await expect(persistSyncSidecar(record, adapter)).rejects.toThrow(/must return a Promise/u);
  });
});
