/**
 * SR-08 (A-09): same-parent reorder produces a real `move_node` uplink.
 *
 * Subject: `reordered()` (the queue entry the `children_reordered` SW seam now
 * delegates to), the per-parent merge window, skipped-child diagnostics, and
 * multi-replica convergence of the staged anchors.
 *
 * Convergence harness: the staged payloads are replayed onto a second replica
 * with `createPullBookmarkEvidence(...).nativeIndex()` — the exact
 * `afterId`/`beforeId` → Chrome index resolver the real Pull applier uses — and
 * `honestChrome()`'s `bookmarks.move` from `kns-05-pull-harness.ts`. A real
 * server round trip is out of scope for host unit tests, so the equivalence is
 * "same anchor resolver + same Chrome move semantics as the applier", which is
 * exactly what the wire contract consists of (a server run is the only missing
 * hop, and it is not what decides the sibling order).
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test, vi } from 'vitest';
import { digestJson } from '../src/bookmark-event-codec.js';
import { createBookmarkEventQueue, type BookmarkEventApi,
  type BookmarkEventNode } from '../src/bookmark-event-queue.js';
import { diffChildOrder, longestIncreasingSubsequence, planReorderPlacements } from '../src/bookmark-reorder-diff.js';
import { projectChildrenReordered, type ReorderUplinkReport } from '../src/bookmark-reorder-projection.js';
import { REORDER_DEBOUNCE_MS, reorderFlushTimer } from '../src/bookmark-reorder-uplink.js';
import { createPullBookmarkEvidence } from '../src/pull-bookmark-evidence.js';
import type { PullApplierOptions } from '../src/pull-applier-types.js';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';
import { honestChrome } from './kns-05-pull-harness.js';

export const scope: SyncScope = Object.freeze({ environment: 'production', serverId: 'server-a',
  serverOrigin: 'https://known.example', accountId: 'account-a', browserProfileId: 'profile-a',
  collectionId: 'collection-a', replicaId: 'replica-a', generation: 1 });
type Store = ReturnType<typeof createSyncStateStore>;

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('the default reorder timer flushes only after its merge window', async () => {
  vi.useFakeTimers();
  try {
    const flush = vi.fn(async () => undefined);
    reorderFlushTimer(flush);
    await vi.advanceTimersByTimeAsync(REORDER_DEBOUNCE_MS - 1);
    assert.equal(flush.mock.calls.length, 0);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(flush.mock.calls.length, 1);
    await vi.runAllTimersAsync();
    assert.equal(flush.mock.calls.length, 1);
  } finally { vi.useRealTimers(); }
});

interface ChildSpec { readonly nativeId: string; readonly colpId?: string }
const CHILDREN: readonly ChildSpec[] = [{ nativeId: 'native-a', colpId: 'colp-a' },
  { nativeId: 'native-b', colpId: 'colp-b' }, { nativeId: 'native-c', colpId: 'colp-c' },
  { nativeId: 'native-d', colpId: 'colp-d' }];

/** Chrome double that really reorders: `index` drives `getChildren`, as in Chromium. */
function treeApi(): BookmarkEventApi & { put(node: JsonObject): void; childIds(parentId: string): string[];
  reorder(parentId: string, childIds: readonly string[]): void } {
  const nodes = new Map<string, BookmarkEventNode>();
  const childrenOf = (parentId: string) => [...nodes.values()].filter((node) => node.parentId === parentId)
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  return {
    put(node) { nodes.set(String(node.id), structuredClone(node) as unknown as BookmarkEventNode); },
    childIds(parentId) { return childrenOf(parentId).map((node) => node.id); },
    reorder(parentId, childIds) { childIds.forEach((id, index) => {
      const node = nodes.get(id); if (node) nodes.set(id, { ...node, index }); }); },
    async get(id) { const node = nodes.get(id); return node ? [structuredClone(node)] : []; },
    async getChildren(id) { return childrenOf(id).map((node) => structuredClone(node)); },
  };
}

async function setup(options: { readonly children?: readonly ChildSpec[]; readonly order?: readonly string[];
  readonly baseline?: readonly string[]; readonly autoFlush?: boolean; readonly exclude?: readonly string[];
  readonly reorderDebounceMs?: number; readonly scheduleReorderFlush?: (flush: () => void, delayMs: number) => void;
  readonly onReorderQueued?: () => void } = {}) {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: ['root-colp'],
    rootStatus: 'ready' });
  const content: JsonObject = options.baseline === undefined ? { title: 'Root' }
    : { title: 'Root', childrenOrder: [...options.baseline],
      childrenOrderDigest: digestJson([...options.baseline]) };
  await store.putMapping(scope, { nativeId: 'native-root', colpId: 'root-colp', rootNativeId: 'native-root',
    nodeKind: 'folder', projection: { revision: 'revision-root', resourceRevision: 'revision-root',
      childrenRevision: 'children-root-r1', digest: 'sha256:root', content } });
  for (const child of options.children ?? CHILDREN) {
    if (!child.colpId) continue;
    await store.putMapping(scope, { nativeId: child.nativeId, colpId: child.colpId, rootNativeId: 'native-root',
      nodeKind: 'bookmark', parentNativeId: 'native-root',
      projection: { revision: `revision-${child.colpId}`, digest: `sha256:${child.colpId}`,
        content: { title: child.nativeId, url: `https://example.test/${child.nativeId}` } } });
  }
  for (const nativeId of options.exclude ?? []) {
    await store.putLocalSyncExclusion(scope, { nativeId, decisionId: `keep:${nativeId}`, rootNativeId: 'native-root',
      generation: scope.generation, sourceKind: 'remote_delete', priorColpId: `colp-${nativeId.slice(-1)}` });
  }
  const api = treeApi();
  api.put({ id: 'native-root', title: 'Root', type: 'folder', index: 0 });
  (options.children ?? CHILDREN).forEach((child, index) => api.put({ id: child.nativeId, parentId: 'native-root',
    index, title: child.nativeId, type: 'bookmark', url: `https://example.test/${child.nativeId}` }));
  const children = (options.children ?? CHILDREN).filter((child) => child.colpId);
  api.reorder('native-root', options.order ?? children.map((child) => child.nativeId));
  const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-09-12T00:00:00Z',
    uuid: (() => { let value = 0; return () => `reorder-${++value}`; })(), autoFlush: options.autoFlush ?? false,
    ...(options.reorderDebounceMs === undefined ? {} : { reorderDebounceMs: options.reorderDebounceMs }),
    ...(options.scheduleReorderFlush === undefined ? {} : { scheduleReorderFlush: options.scheduleReorderFlush }),
    ...(options.onReorderQueued === undefined ? {} : { onReorderQueued: options.onReorderQueued }) });
  return { store, api, queue };
}

const rows = (store: Store) => store.listQueue(scope);
const inner = (row: { readonly payload: JsonObject }) => row.payload.payload as JsonObject;
const codes = async (store: Store) => (await store.listIngressDiagnostics(scope)).map((row) => row.code);

function assertWireAnchors(queued: readonly { readonly payload: JsonObject }[]) {
  for (const row of queued) {
    for (const value of [row.payload.targetId, inner(row).newParentId, inner(row).afterId, inner(row).beforeId]) {
      if (value === undefined) continue;
      assert.match(String(value), /^root-colp$|^colp-[a-z]$/, `anchor ${String(value)} must be a colpId`);
    }
  }
}

describe('SR-08 child order planning', () => {
  test('keeps a longest increasing subsequence and moves only the rest', () => {
    assert.deepEqual(longestIncreasingSubsequence([2, 0, 1]), [1, 2]);
    assert.deepEqual(longestIncreasingSubsequence([1, 2, 3]), [0, 1, 2]);
    const plan = diffChildOrder(['a', 'b', 'c', 'd'], ['c', 'd', 'a', 'b']);
    assert.deepEqual(plan.retained, ['a', 'b']);
    assert.deepEqual(plan.moves.map((move) => [move.nativeId, move.index, move.previousIndex]),
      [['c', 0, 2], ['d', 1, 3]]);
    assert.equal(diffChildOrder(['a', 'b', 'c'], ['a', 'b', 'c']).changed, false);
    // A child that left the parent is not this event's business.
    assert.equal(diffChildOrder(['a', 'b', 'c'], ['a', 'c']).changed, false);
  });

  test('an unknown baseline re-asserts the order as a chain from the first child', () => {
    const plan = diffChildOrder(undefined, ['c', 'a', 'b']);
    assert.deepEqual(plan.retained, ['c']);
    assert.deepEqual(plan.moves.map((move) => move.nativeId), ['a', 'b']);
    assert.equal(diffChildOrder(undefined, ['a']).changed, false);
  });

  test('moved children are anchored to retained children, never to each other', () => {
    assert.deepEqual(planReorderPlacements({ order: ['c', 'd', 'a', 'b'], retained: ['a', 'b'],
      moved: ['c', 'd'] }),
    [{ nativeId: 'c', anchor: { beforeNativeId: 'a' } }, { nativeId: 'd', anchor: { beforeNativeId: 'a' } }]);
    // A gap after a retained child is emitted right-to-left so every insertion
    // lands directly after that same retained child.
    assert.deepEqual(planReorderPlacements({ order: ['s1', 'm1', 'm2', 's2'], retained: ['s1', 's2'],
      moved: ['m1', 'm2'] }),
    [{ nativeId: 'm2', anchor: { afterNativeId: 's1' } }, { nativeId: 'm1', anchor: { afterNativeId: 's1' } }]);
  });
});

describe('SR-08 reorder uplink', () => {
  test('stages move_node operations anchored by colpId after reordered()', async () => {
    const three: readonly ChildSpec[] = CHILDREN.slice(0, 3);
    const { store, api, queue } = await setup({ children: three, order: ['native-c', 'native-a', 'native-b'] });
    assert.equal((await queue.reordered('native-root', ['native-c', 'native-a', 'native-b'])).outcome, 'staged');
    await queue.flush();
    const queued = await rows(store);
    assert.deepEqual(queued.map((row) => row.payload.type), ['move_node', 'move_node']);
    assertWireAnchors(queued);
    // Gap after C, emitted right-to-left: both children are placed against C,
    // the one retained child, so no operation anchors to a child that still moves.
    assert.equal(queued[0]!.payload.targetId, 'colp-b');
    assert.equal(queued[0]!.payload.baseRevision, 'revision-colp-b');
    assert.equal(inner(queued[0]!).newParentId, 'root-colp');
    assert.equal(inner(queued[0]!).afterId, 'colp-c');
    assert.equal(inner(queued[0]!).baseSourceParentRevision, 'children-root-r1');
    assert.equal(inner(queued[0]!).baseTargetParentRevision, 'children-root-r1');
    assert.equal(queued[1]!.payload.targetId, 'colp-a');
    assert.equal(inner(queued[1]!).afterId, 'colp-c');
    assert.deepEqual(api.childIds('native-root'), ['native-c', 'native-a', 'native-b']);
    assert.ok((await codes(store)).includes('reorder_uplink_staged'), 'upload must not be reported as local-only');
  });

  test('a repeated identical order adds no operation', async () => {
    const three: readonly ChildSpec[] = CHILDREN.slice(0, 3);
    const { store, api, queue } = await setup({ children: three, order: ['native-c', 'native-a', 'native-b'] });
    await queue.reordered('native-root', ['native-c', 'native-a', 'native-b']);
    await queue.flush();
    const first = await rows(store);
    assert.equal(first.length > 0, true);
    assert.equal((await queue.reordered('native-root', ['native-c', 'native-a', 'native-b'])).outcome, 'filtered');
    await queue.flush();
    assert.deepEqual((await rows(store)).map((row) => row.opId), first.map((row) => row.opId));
    assert.deepEqual(api.childIds('native-root'), ['native-c', 'native-a', 'native-b']);
  });

  test('a drag burst on one parent merges into one batch and persists the last order', async () => {
    const three: readonly ChildSpec[] = CHILDREN.slice(0, 3);
    const { store, api, queue } = await setup({ children: three,
      baseline: ['native-a', 'native-b', 'native-c'], order: ['native-a', 'native-b', 'native-c'] });
    // The drag Chrome reports: A,B,C -> C,A,B -> B,C,A with no flush in between.
    api.reorder('native-root', ['native-b', 'native-c', 'native-a']);
    assert.equal((await queue.reordered('native-root', ['native-c', 'native-a', 'native-b'])).outcome, 'staged');
    assert.equal((await queue.reordered('native-root', ['native-b', 'native-c', 'native-a'])).outcome, 'staged');
    assert.equal((await rows(store)).length, 0, 'nothing is staged while the merge window is open');
    await queue.flush();
    const queued = await rows(store);
    assert.equal(queued.length, 1, 'the burst is one merged batch, minimised against the recorded order');
    assert.equal(queued[0]!.payload.targetId, 'colp-a');
    assert.equal(inner(queued[0]!).afterId, 'colp-c');
    const mapping = await store.getMappingByNativeId(scope, 'native-root');
    assert.deepEqual(mapping?.projection.childrenOrder, ['native-b', 'native-c', 'native-a']);
    assert.equal(mapping?.projection.content?.childrenOrderDigest, undefined);
  });

  test('unmapped children are skipped, reported, and never reach the wire', async () => {
    const children: readonly ChildSpec[] = [{ nativeId: 'native-a', colpId: 'colp-a' },
      { nativeId: 'native-b', colpId: 'colp-b' }, { nativeId: 'native-ghost' }];
    const { store, api, queue } = await setup({ children, order: ['native-ghost', 'native-a', 'native-b'] });
    assert.equal((await queue.reordered('native-root', ['native-ghost', 'native-a', 'native-b'])).outcome, 'staged');
    await queue.flush();
    const queued = await rows(store);
    assert.deepEqual(queued.map((row) => row.payload.type), ['move_node']);
    assert.equal(queued[0]!.payload.targetId, 'colp-b');
    assert.equal(inner(queued[0]!).afterId, 'colp-a');
    assert.doesNotMatch(JSON.stringify(queued), /ghost/);
    assert.ok((await codes(store)).includes('reorder_children_unmapped'));
    const mapping = await store.getMappingByNativeId(scope, 'native-root');
    assert.deepEqual(mapping?.projection.childrenOrder, ['native-ghost', 'native-a', 'native-b']);
    assert.deepEqual(api.childIds('native-root'), ['native-ghost', 'native-a', 'native-b']);
  });

  test('an order that is entirely unmapped or locally excluded stages nothing', async () => {
    const children: readonly ChildSpec[] = [{ nativeId: 'native-a', colpId: 'colp-a' },
      { nativeId: 'native-b', colpId: 'colp-b' }, { nativeId: 'native-ghost' }];
    const { store, queue } = await setup({ children, exclude: ['native-b'],
      order: ['native-ghost', 'native-b', 'native-a'] });
    assert.equal((await queue.reordered('native-root', ['native-ghost', 'native-b', 'native-a'])).outcome,
      'filtered');
    await queue.flush();
    assert.deepEqual(await rows(store), []);
    const recorded = await codes(store);
    assert.ok(recorded.includes('reorder_children_unmapped'));
    assert.ok(recorded.includes('reorder_children_excluded'));
    // The local order is still recorded: local consistency has its own value.
    const mapping = await store.getMappingByNativeId(scope, 'native-root');
    assert.deepEqual(mapping?.projection.childrenOrder, ['native-ghost', 'native-b', 'native-a']);
  });

  test('an out-of-boundary parent stays local-only and authors nothing', async () => {
    const { store, queue } = await setup({ order: ['native-c', 'native-a', 'native-b'] });
    await store.putMapping(scope, { nativeId: 'native-outsider', colpId: 'outsider-colp',
      rootNativeId: 'native-other-root', nodeKind: 'folder',
      projection: { revision: 'revision-outsider', childrenRevision: 'children-outsider',
        digest: 'sha256:outsider', content: { title: 'Other' } } });
    const reordered = ['native-c', 'native-a', 'native-b'];
    assert.equal((await queue.reordered('native-outsider', reordered)).outcome, 'filtered');
    await queue.flush();
    assert.deepEqual(await rows(store), []);
    assert.ok((await codes(store)).includes('unselected_range'));
    // The local projection is still consistent, and says so honestly.
    const mapping = await store.getMappingByNativeId(scope, 'native-outsider');
    assert.deepEqual(mapping?.projection.childrenOrder, reordered);
    assert.ok((await codes(store)).includes('reorder_children_local_only'));
  });

  test('capture-only queues persist reorders without scheduling a flush', async () => {
    const scheduled: Array<() => void> = [];
    const { store, queue } = await setup({ autoFlush: false,
      scheduleReorderFlush: flush => scheduled.push(flush) });
    try {
      assert.equal((await queue.reordered('native-root', ['native-c', 'native-a', 'native-b'])).outcome, 'staged');
      assert.equal((await store.listPendingReorders(scope)).length, 1);
      assert.deepEqual(await rows(store), []);
      assert.equal(scheduled.length, 0, 'advanced and frozen captures must wait for an explicit drain');
      await queue.flush();
      assert.ok((await rows(store)).length > 0);
      assert.deepEqual(await store.listPendingReorders(scope), []);
    } finally { store.close(); }
  });

  test('the merge window is the injected scheduleFlush, and onReorderQueued fires once per batch', async () => {
    const scheduled: Array<{ flush: () => void; delayMs: number }> = [];
    let wakes = 0;
    const fixture = await setup({ autoFlush: true, onReorderQueued: () => { wakes += 1; },
      scheduleReorderFlush: (flush, delayMs) => scheduled.push({ flush, delayMs }) });
    assert.equal((await fixture.queue.reordered('native-root', ['native-c', 'native-a', 'native-b'])).outcome,
      'staged');
    assert.equal((await rows(fixture.store)).length, 0, 'the window holds the batch');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]!.delayMs, REORDER_DEBOUNCE_MS);
    scheduled[0]!.flush();
    await fixture.queue.flush();
    assert.equal((await rows(fixture.store)).length, 2);
    assert.equal(wakes, 1);
    await fixture.queue.flush();
    assert.equal(wakes, 1, 'a flush without a merged batch must not wake Push');
  });

  test('the children_reordered projection path reports what the uplink did', async () => {
    const { store } = await setup({ order: ['native-c', 'native-a', 'native-b'] });
    const seen: Array<readonly string[] | undefined> = [];
    const report: ReorderUplinkReport = { changed: true, staged: 1, retained: 1,
      unmapped: [], excluded: [], reserved: [] };
    const first = await projectChildrenReordered({ scope, store, parentNativeId: 'native-root',
      childIds: ['native-c', 'native-a', 'native-b'],
      uplink: (context) => { seen.push(context.previousOrder); return report; } });
    assert.equal(first.code, 'uplink_staged');
    assert.equal(first.outcome, 'projected');
    assert.equal(seen[0], undefined, 'the uplink diffs before the baseline is rewritten');
    assert.equal((await store.listQueue(scope)).length, 0, 'the projection path itself authors no operation');
    const mapping = await store.getMappingByNativeId(scope, 'native-root');
    assert.deepEqual(mapping?.projection.childrenOrder, ['native-c', 'native-a', 'native-b']);
    assert.equal(mapping?.projection.contentDigest, 'sha256:root', 'reorder preserves the content authority digest');
    // A second call now sees the recorded baseline; an unmapped report is named as such.
    const second = await projectChildrenReordered({ scope, store, parentNativeId: 'native-root',
      childIds: ['native-a', 'native-c', 'native-b'],
      uplink: (context) => { seen.push(context.previousOrder);
        return { ...report, staged: 0, unmapped: ['native-x'] }; } });
    assert.deepEqual(seen[1], ['native-c', 'native-a', 'native-b']);
    assert.equal(second.code, 'unmapped_children');
    const bare = await projectChildrenReordered({ scope, store, parentNativeId: 'native-root',
      childIds: ['native-c', 'native-a', 'native-b'] });
    assert.equal(bare.code, 'local_projection_only');
    const diagnostics = await store.exportDiagnostics();
    assert.ok(diagnostics.records.some((row) => row.kind === 'children_reordered' && row.code === 'uplink_staged'));
  });

  test('a second replica replays the staged anchors into the same order', async () => {
    const order = ['native-c', 'native-d', 'native-a', 'native-b'];
    const { store, api, queue } = await setup({ order,
      baseline: ['native-a', 'native-b', 'native-c', 'native-d'] });
    assert.equal((await queue.reordered('native-root', order)).outcome, 'staged');
    await queue.flush();
    const queued = await rows(store);
    assert.deepEqual(queued.map((row) => row.payload.targetId), ['colp-c', 'colp-d']);
    assert.deepEqual(queued.map((row) => inner(row).beforeId), ['colp-a', 'colp-a']);
    assertWireAnchors(queued);

    // Second replica: same collection ids, its own native tree, still in the old order.
    const receiver = createSyncStateStore({ indexedDB: new IDBFactory() });
    await receiver.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-b', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: ['root-colp'],
      rootStatus: 'ready' });
    await receiver.putMapping(scope, { nativeId: 'native-b-root', colpId: 'root-colp',
      rootNativeId: 'native-b-root', nodeKind: 'folder',
      projection: { revision: 'revision-root', digest: 'sha256:root', content: { title: 'Root' } } });
    const chrome = honestChrome();
    chrome.seed({ id: 'native-b-root', title: 'Root' });
    const colpOf = new Map<string, string>();
    for (const [index, colpId] of ['colp-a', 'colp-b', 'colp-c', 'colp-d'].entries()) {
      const nativeId = `native-b-${colpId.slice(-1)}`;
      colpOf.set(nativeId, colpId);
      await receiver.putMapping(scope, { nativeId, colpId, rootNativeId: 'native-b-root', nodeKind: 'bookmark',
        parentNativeId: 'native-b-root',
        projection: { revision: `revision-${colpId}`, digest: `sha256:${colpId}`, content: { title: nativeId } } });
      chrome.seed({ id: nativeId, parentId: 'native-b-root', index, title: nativeId,
        url: `https://example.test/${nativeId}` });
    }
    const evidence = createPullBookmarkEvidence({ store: receiver, scope } as unknown as PullApplierOptions, chrome);
    const byColp = new Map((await receiver.listMappings(scope)).map((mapping) => [mapping.colpId, mapping.nativeId]));
    for (const row of queued) {
      const payload = inner(row);
      const index = await evidence.nativeIndex(payload.afterId === undefined ? null : String(payload.afterId),
        payload.beforeId === undefined ? null : String(payload.beforeId));
      await chrome.move(byColp.get(String(row.payload.targetId))!, {
        parentId: byColp.get(String(payload.newParentId))!, index });
    }
    const replicated = (await chrome.getChildren(byColp.get('root-colp')!)).map((node) => colpOf.get(node.id));
    assert.deepEqual(replicated, order.map((nativeId) => `colp-${nativeId.slice(-1)}`));
    assert.deepEqual(replicated, api.childIds('native-root').map((nativeId) => `colp-${nativeId.slice(-1)}`));
  });
});

// Review probes: assertions describe the required behavior, not current output.
test('review: returning to baseline cancels the buffered reorder', async () => {
  const baseline = ['native-a', 'native-b', 'native-c', 'native-d'];
  const f = await setup({ baseline, scheduleReorderFlush: () => {} });
  await f.queue.reordered('native-root', ['native-c', 'native-d', 'native-a', 'native-b']);
  await f.queue.reordered('native-root', baseline);
  await f.queue.flush();
  assert.deepEqual(await rows(f.store), [], 'final order equals baseline; no moves may upload');
});
test('review: worker restart recovers a captured reorder', async () => {
  const baseline = ['native-a', 'native-b', 'native-c', 'native-d'];
  const target = ['native-c', 'native-d', 'native-a', 'native-b'];
  const f = await setup({ baseline, scheduleReorderFlush: () => {} });
  f.api.reorder('native-root', target);
  await f.queue.reordered('native-root', target);
  const restarted = createBookmarkEventQueue({ scope, store: f.store, api: f.api,
    autoFlush: false, scheduleReorderFlush: () => {} });
  await restarted.recover();
  await restarted.flush();
  assert.ok((await rows(f.store)).some(row => row.payload.type === 'move_node'), 'restart must not lose accepted reorder');
});

test('partial staging resumes the immutable reorder without duplicating moves', async () => {
  const baseline = ['native-a', 'native-b', 'native-c', 'native-d'];
  const f = await setup({ baseline, scheduleReorderFlush: () => {} });
  let fail = true;
  const interrupted = createBookmarkEventQueue({ scope, api: f.api, autoFlush: false, scheduleReorderFlush: () => {},
    store: { ...f.store, async stageBookmarkEvent(...args: Parameters<typeof f.store.stageBookmarkEvent>) {
      const result = await f.store.stageBookmarkEvent(...args);
      if (fail) { fail = false; throw new Error('worker_crash'); }
      return result;
    } } });
  await interrupted.reordered('native-root', ['native-c', 'native-d', 'native-a', 'native-b']);
  await assert.rejects(() => interrupted.flush(), /worker_crash/);
  assert.equal((await f.store.listPendingReorders(scope)).length, 1);
  const resumed = createBookmarkEventQueue({ scope, store: f.store, api: f.api, autoFlush: false,
    scheduleReorderFlush: () => {} });
  await resumed.flush();
  const queued = await rows(f.store);
  assert.deepEqual(queued.map(row => row.payload.targetId), ['colp-c', 'colp-d']);
  assert.equal(new Set(queued.map(row => row.opId)).size, 2);
  assert.deepEqual(await f.store.listPendingReorders(scope), []);
});

test('a large reorder persists separate bounded move records and keeps the final order', async () => {
  const f = await setup({ scheduleReorderFlush: () => {} });
  const moves = Array.from({ length: 400 }, (_, index) => ({ nativeId: `child-${index}`, eventId: `event-${index}`,
    details: { title: 'x'.repeat(1000), index } }));
  await f.store.putPendingReorder(scope, { parentNativeId: 'native-root', version: 'large',
    childIds: moves.map(move => move.nativeId), moves, retained: 0, unmapped: [], excluded: [], reserved: [] });
  const persisted = (await f.store.listPendingReorders(scope))[0]!;
  assert.equal(persisted.moves.length, 400);
  assert.deepEqual(persisted.moves.map(move => move.eventId), moves.map(move => move.eventId));
  await f.store.deletePendingReorder(scope, 'native-root', 'stale');
  assert.equal((await f.store.listPendingReorders(scope)).length, 1, 'stale drain cannot delete a newer target');
  await f.store.deletePendingReorder(scope, 'native-root', 'large');
  assert.deepEqual(await f.store.listPendingReorders(scope), []);
});
