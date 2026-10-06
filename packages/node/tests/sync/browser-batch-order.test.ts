import { describe, expect, it } from 'vitest';
import {
  applySyncBrowserBatch,
  type SyncBrowserBatchDriver,
} from '../../src/sync/index.js';

const evidence = '[evidence:sync.browser-batch-order]';

type BatchWrite = {
  readonly kind: 'create' | 'move';
  readonly nodeId: string;
  readonly folderId: string;
  readonly index: number;
};

type BrowserBatchDriver = SyncBrowserBatchDriver<BatchWrite, string, string>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe(`SYNC-0019 browser batch ordering and re-read semantics ${evidence}`, () => {
  it(`waits for each Firefox Create/Move before starting the next write ${evidence}`, async () => {
    const events: string[] = [];
    const gates = [deferred<void>(), deferred<void>()];
    const moveStarted = deferred<void>();
    const driver: BrowserBatchDriver = {
      write: async (change) => {
        events.push(`start:${change.kind}:${change.nodeId}`);
        if (change.kind === 'move') moveStarted.resolve();
        await gates[events.filter((event) => event.startsWith('start')).length - 1]!.promise;
        events.push(`done:${change.nodeId}`);
      },
      readFolder: async () => [],
    };
    const pending = applySyncBrowserBatch([
      { kind: 'create', nodeId: 'n1', folderId: 'f1', index: 0 },
      { kind: 'move', nodeId: 'n2', folderId: 'f1', index: 1 },
    ], driver);
    await Promise.resolve();
    expect(events).toEqual(['start:create:n1']);
    gates[0]!.resolve();
    await moveStarted.promise;
    expect(events).toEqual(['start:create:n1', 'done:n1', 'start:move:n2']);
    gates[1]!.resolve();
    await expect(pending).resolves.toEqual([]);
  });

  it(`re-reads every affected folder after a mixed Create/Move batch ${evidence}`, async () => {
    const writes: string[] = [];
    const reads: string[] = [];
    const driver: BrowserBatchDriver = {
      write: async (change) => { writes.push(change.nodeId); },
      readFolder: async (folderId) => { reads.push(folderId); return [`${folderId}:fresh`]; },
    };
    await expect(applySyncBrowserBatch([
      { kind: 'create', nodeId: 'a', folderId: 'f1', index: 0 },
      { kind: 'move', nodeId: 'b', folderId: 'f2', index: 0 },
      { kind: 'create', nodeId: 'c', folderId: 'f1', index: 1 },
    ], driver)).resolves.toEqual(['f1:fresh', 'f2:fresh']);
    expect(writes).toEqual(['a', 'b', 'c']);
    expect(reads).toEqual(['f1', 'f2']);
  });

  it.each([
    ['empty batch', [] as const],
    ['single write', [{ kind: 'create', nodeId: 'only', folderId: 'f1', index: 0 }] as const],
  ])(`handles the %s boundary without speculative writes ${evidence}`, async (_label, changes) => {
    let writes = 0;
    let reads = 0;
    const driver: BrowserBatchDriver = {
      write: async () => { writes += 1; },
      readFolder: async () => { reads += 1; return []; },
    };
    await applySyncBrowserBatch(changes, driver);
    expect(writes).toBe(changes.length);
    expect(reads).toBe(changes.length === 0 ? 0 : 1);
  });

  it(`does not continue or re-read when an ordered write fails ${evidence}`, async () => {
    const writes: string[] = [];
    let reads = 0;
    const driver: BrowserBatchDriver = {
      write: async (change) => {
        writes.push(change.nodeId);
        if (change.nodeId === 'bad') throw new Error('native write failed');
      },
      readFolder: async () => { reads += 1; return []; },
    };
    await expect(applySyncBrowserBatch([
      { kind: 'create', nodeId: 'ok', folderId: 'f1', index: 0 },
      { kind: 'move', nodeId: 'bad', folderId: 'f1', index: 1 },
      { kind: 'create', nodeId: 'never', folderId: 'f1', index: 2 },
    ], driver)).rejects.toThrow('native write failed');
    expect(writes).toEqual(['ok', 'bad']);
    expect(reads).toBe(0);
  });

  it(`rejects a synchronous native boundary instead of treating it as completed ${evidence}`, async () => {
    const driver = {
      write: (() => undefined) as unknown as BrowserBatchDriver['write'],
      readFolder: async () => [],
    };
    await expect(applySyncBrowserBatch([
      { kind: 'create', nodeId: 'n1', folderId: 'f1', index: 0 },
    ], driver)).rejects.toThrow();
  });

  // Production documents empty batches as an accepted no-op: zero writes, zero
  // rereads, resolved empty array — not a reject boundary.
  it(`accepts an empty batch as a settled no-op without touching the driver ${evidence}`, async () => {
    let writes = 0;
    let reads = 0;
    const driver: BrowserBatchDriver = {
      write: async () => { writes += 1; },
      readFolder: async () => { reads += 1; return ['should-not-run']; },
    };
    await expect(applySyncBrowserBatch([], driver)).resolves.toEqual([]);
    expect(writes).toBe(0);
    expect(reads).toBe(0);
  });

  it(`preserves multi-change write order across three sequential mutations ${evidence}`, async () => {
    const order: string[] = [];
    const driver: BrowserBatchDriver = {
      write: async (change) => {
        order.push(`w:${change.nodeId}`);
      },
      readFolder: async (folderId) => {
        order.push(`r:${folderId}`);
        return [`item:${folderId}`];
      },
    };
    await expect(applySyncBrowserBatch([
      { kind: 'create', nodeId: 'first', folderId: 'f1', index: 0 },
      { kind: 'move', nodeId: 'second', folderId: 'f1', index: 1 },
      { kind: 'create', nodeId: 'third', folderId: 'f2', index: 0 },
    ], driver)).resolves.toEqual(['item:f1', 'item:f2']);
    expect(order).toEqual(['w:first', 'w:second', 'w:third', 'r:f1', 'r:f2']);
  });

  it(`rejects a non-Promise folder re-read after writes have settled ${evidence}`, async () => {
    const writes: string[] = [];
    const driver = {
      write: async (change: BatchWrite) => { writes.push(change.nodeId); },
      readFolder: (() => ['stale']) as unknown as BrowserBatchDriver['readFolder'],
    };
    await expect(applySyncBrowserBatch([
      { kind: 'create', nodeId: 'n1', folderId: 'f1', index: 0 },
    ], driver)).rejects.toThrow(TypeError);
    await expect(applySyncBrowserBatch([
      { kind: 'create', nodeId: 'n1', folderId: 'f1', index: 0 },
    ], driver)).rejects.toThrow(/must return a Promise/u);
    expect(writes).toEqual(['n1', 'n1']);
  });

  it(`fails closed on a driver write rejection for a bad entry without rereading ${evidence}`, async () => {
    const writes: string[] = [];
    let reads = 0;
    const driver: BrowserBatchDriver = {
      write: async (change) => {
        writes.push(change.nodeId);
        if (change.nodeId === 'invalid') throw new TypeError('invalid batch entry');
      },
      readFolder: async () => { reads += 1; return []; },
    };
    await expect(applySyncBrowserBatch([
      { kind: 'create', nodeId: 'ok', folderId: 'f1', index: 0 },
      { kind: 'move', nodeId: 'invalid', folderId: 'f1', index: 1 },
    ], driver)).rejects.toThrow(/invalid batch entry/u);
    expect(writes).toEqual(['ok', 'invalid']);
    expect(reads).toBe(0);
  });

  it(`rejects malformed change entries before any write or reread ${evidence}`, async () => {
    let writes = 0;
    let reads = 0;
    const driver: BrowserBatchDriver = {
      write: async () => { writes += 1; },
      readFolder: async () => { reads += 1; return []; },
    };
    await expect(applySyncBrowserBatch([
      null as unknown as BatchWrite,
    ], driver)).rejects.toThrow(TypeError);
    await expect(applySyncBrowserBatch([
      { kind: 'create', nodeId: 'n1', index: 0 } as unknown as BatchWrite,
    ], driver)).rejects.toThrow(/folderId/u);
    await expect(applySyncBrowserBatch([
      { kind: 'create', nodeId: 'n1', folderId: '   ', index: 0 },
    ], driver)).rejects.toThrow(/folderId/u);
    expect(writes).toBe(0);
    expect(reads).toBe(0);
  });
});
