import { describe, expect, it } from 'vitest';
import {
  exportSyncSidecars,
  type SyncSidecarExportAdapter,
  type SyncSidecarRecord,
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.sidecar-export]';

type Record = SyncSidecarRecord<string, string, string, string, string, number, { readonly value: string }>;

const first: Record = {
  browser: 'firefox', profile: 'profile-1', collectionId: 'collection-1',
  nodeId: 'node-1', nativeId: 'native-1', generation: 1, data: { value: 'one' },
};
const second: Record = {
  browser: 'firefox', profile: 'profile-1', collectionId: 'collection-1',
  nodeId: 'node-2', nativeId: 'native-2', generation: 0, data: { value: 'two' },
};

function adapter(records: readonly Record[]): SyncSidecarExportAdapter<Record> & {
  readonly listCalls: number;
} {
  let listCalls = 0;
  return {
    get listCalls() { return listCalls; },
    async listSidecars() { listCalls += 1; return records; },
  };
}

describe(`SYNC-0025 Sidecar export entry point ${evidence}`, () => {
  it(`exports every persisted Sidecar ${evidence}`, async () => {
    const source = [first, second] as const;
    expect(await exportSyncSidecars(adapter(source))).toEqual(source);
  });

  it(`awaits the adapter export sink and preserves persisted ordering ${evidence}`, async () => {
    const source = [second, first] as const;
    const seen: readonly Record[][] = [];
    let release!: (value: string) => void;
    const exported = new Promise<string>((resolve) => { release = resolve; });
    const result = exportSyncSidecars({
      ...adapter(source),
      async exportSidecars(records) {
        (seen as Record[][]).push(records as Record[]);
        release('sidecar-export.json');
        return exported;
      },
    });
    await expect(result).resolves.toBe('sidecar-export.json');
    expect(seen[0]).toEqual(source);
    expect(seen[0]?.map((record) => record.nodeId)).toEqual(['node-2', 'node-1']);
  });

  it(`passes a frozen snapshot to an explicit exporter without exposing the adapter array ${evidence}`, async () => {
    const source = [first, second] as Record[];
    let snapshot!: readonly Record[];
    const result = await exportSyncSidecars(adapter(source), async (records) => {
      snapshot = records;
      expect(Object.isFrozen(records)).toBe(true);
      expect(() => (records as Record[]).push(first)).toThrow();
      return JSON.stringify(records);
    });
    source.reverse();
    expect(JSON.parse(result as string)).toEqual([first, second]);
    expect(snapshot).toEqual([first, second]);
  });

  it(`supports an empty sidecar set and still invokes an explicit exporter ${evidence}`, async () => {
    const calls: number[] = [];
    await expect(exportSyncSidecars(adapter([]), async (records) => {
      calls.push(records.length);
      return 'empty.json';
    })).resolves.toBe('empty.json');
    expect(calls).toEqual([0]);
    await expect(exportSyncSidecars(adapter([]))).resolves.toEqual([]);
  });

  it.each([
    ['list rejection', async () => { throw new Error('list failed'); }, /list failed/u],
    ['list non-Promise', () => [] as unknown as Promise<readonly Record[]>, /must return a Promise/u],
  ] as const)(`fails closed on %s before invoking the exporter ${evidence}`, async (_label, listSidecars, error) => {
    let exported = false;
    const candidate = { listSidecars } as unknown as SyncSidecarExportAdapter<Record>;
    await expect(exportSyncSidecars(candidate, async () => {
      exported = true;
      return 'unexpected';
    })).rejects.toThrow(error);
    expect(exported).toBe(false);
  });

  it(`rejects malformed records before offering partial serialized output ${evidence}`, async () => {
    let exported = false;
    const invalid = { ...first, nodeId: '' };
    await expect(exportSyncSidecars(adapter([invalid]), async () => {
      exported = true;
      return 'unexpected';
    })).rejects.toThrow(/identifier/u);
    expect(exported).toBe(false);
  });

  it.each([
    ['export rejection', async () => { throw new Error('sink failed'); }, /sink failed/u],
    ['export non-Promise', () => 'sync' as unknown as Promise<string>, /must return a Promise/u],
  ] as const)(`propagates %s without changing the listed records ${evidence}`, async (_label, exporter, error) => {
    const source = [first, second] as const;
    await expect(exportSyncSidecars(adapter(source), exporter)).rejects.toThrow(error);
    expect(source).toEqual([first, second]);
  });

  it(`rejects a list boundary that resolves to a non-array before invoking the exporter ${evidence}`, async () => {
    let exported = false;
    const candidate = {
      async listSidecars() {
        return { nodeId: 'not-an-array' } as unknown as readonly Record[];
      },
    } as SyncSidecarExportAdapter<Record>;

    await expect(exportSyncSidecars(candidate, async () => {
      exported = true;
      return 'unexpected';
    })).rejects.toThrow(TypeError);
    await expect(exportSyncSidecars(candidate, async () => {
      exported = true;
      return 'unexpected';
    })).rejects.toThrow(/array/u);
    expect(exported).toBe(false);
  });

  it(`rejects empty nodeId records enumerated by list before any export sink runs ${evidence}`, async () => {
    let exported = false;
    await expect(exportSyncSidecars(adapter([{ ...first, nodeId: '   ' }]), async () => {
      exported = true;
      return 'unexpected';
    })).rejects.toThrow(/identifier/u);
    expect(exported).toBe(false);
  });
});
