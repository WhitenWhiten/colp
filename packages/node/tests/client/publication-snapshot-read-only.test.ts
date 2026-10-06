import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { getHeapStatistics } from 'node:v8';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient, PublicationSnapshotState } from '../../src/client/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[review:u17-snapshot-copy]';
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const extraBookmarks = 2_000;
const detachedCopies = 4;

async function largePublicationSnapshot(): Promise<Snapshot> {
  const snapshot = JSON.parse(await readFile(resolve(fixturesRoot, 'collection-snapshot.json'), 'utf8')) as Snapshot;
  snapshot.annotations = [];
  snapshot.attachments = [];
  snapshot.relations = [];
  snapshot.tombstones = [];
  const template = snapshot.nodes[1];
  if (template?.kind !== 'bookmark') throw new Error('expected a bookmark fixture');
  const rootId = snapshot.nodes[0]!.id;
  for (let index = 0; index < extraBookmarks; index += 1) {
    snapshot.nodes.push({
      ...structuredClone(template),
      id: `bm-${index}`,
      parentId: rootId,
      position: `b${index.toString(36)}`,
      title: `Bookmark ${index}`,
    });
  }
  return snapshot;
}

describe(`U-17 fixed-context Snapshot copy and read-only view ${evidence}`, () => {
  it(`measures detached fixed-context copies and reuses one frozen view ${evidence}`, async () => {
    const snapshot = await largePublicationSnapshot();
    const client = new ColpClient({
      manifestUrl,
      fetch: () => {
        throw new Error('fixed-context copy measurement must not fetch');
      },
    });
    client.replaceSnapshot(snapshot);
    // Drop fixture and replace garbage before the timed window when the
    // process exposes gc. The recorded heap delta is then the retained copies.
    void client.currentSnapshot;
    const collect = (globalThis as { gc?: () => void }).gc;
    collect?.();

    const retained: Snapshot[] = [];
    // V8 heap counters do not query OS resident memory, which is unavailable
    // in some sandboxed runtimes (uv_resident_set_memory).
    const heapBefore = getHeapStatistics().used_heap_size;
    const started = performance.now();
    for (let index = 0; index < detachedCopies; index += 1) {
      retained.push(client.currentSnapshot!);
    }
    const elapsedMs = performance.now() - started;
    const heapDeltaBytes = getHeapStatistics().used_heap_size - heapBefore;
    const copyJsonBytes = Buffer.byteLength(JSON.stringify(retained[0]), 'utf8');
    process.stdout.write(
      `U-17 fixed-context snapshot copy cost nodes=${snapshot.nodes.length} copies=${detachedCopies} elapsedMs=${elapsedMs.toFixed(3)} heapDeltaBytes=${heapDeltaBytes} copyJsonBytes=${copyJsonBytes} gc=${typeof collect === 'function'}\n`,
    );

    expect(client.currentSnapshot).not.toBe(retained[0]);
    expect(retained[0]).not.toBe(retained[1]);
    expect(elapsedMs).toBeGreaterThan(0);
    expect(copyJsonBytes).toBeGreaterThan(500_000);
    if (typeof collect === 'function') expect(heapDeltaBytes).toBeGreaterThan(0);
    retained[0]!.collection.title = 'detached mutation';
    expect(client.currentSnapshot?.collection.title).toBe(snapshot.collection.title);

    const state = new PublicationSnapshotState();
    state.replace(snapshot);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const view = state.readOnlySnapshot;
    const viewAgain = state.readOnlySnapshot;
    expect(clone).toHaveBeenCalledTimes(1);
    expect(viewAgain).toBe(view);
    expect(view).toBeDefined();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view!.nodes)).toBe(true);
    expect(Object.isFrozen(view!.nodes[0])).toBe(true);
    expect(Object.isFrozen(view!.collection)).toBe(true);
    expect(() => {
      view!.collection.title = 'frozen mutation';
    }).toThrow(TypeError);
    expect(() => {
      view!.nodes.push(structuredClone(snapshot.nodes[0]!));
    }).toThrow(TypeError);
    expect(state.current?.collection.title).toBe(snapshot.collection.title);
    expect(state.readOnlySnapshot).toBe(view);

    clone.mockClear();
    const detached = state.current!;
    const detachedAgain = state.current!;
    expect(clone).toHaveBeenCalledTimes(2);
    expect(detached).not.toBe(view);
    expect(detachedAgain).not.toBe(detached);
    detached.collection.title = 'second detached mutation';
    expect(state.current?.collection.title).toBe(snapshot.collection.title);
    expect(view!.collection.title).toBe(snapshot.collection.title);

    const replacement = structuredClone(snapshot);
    replacement.snapshotId = 'snapshot-replaced';
    replacement.revision = 'revision-replaced';
    state.replace(replacement);
    expect(state.readOnlySnapshot).not.toBe(view);
    expect(state.readOnlySnapshot?.snapshotId).toBe('snapshot-replaced');
    expect(view!.snapshotId).toBe(snapshot.snapshotId);
  }, 30_000);
});
