import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { BookmarkApiError } from '../src/bookmark-api-error.js';
import { planCreatePlacement, type PlacementIntent } from '../src/create-placement-rebase.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { describeSyncAttention } from '../src/sync-attention-ui.js';
import type { BookmarkEventRecord, MappingInput } from '../src/sync-state-store.js';
import { json, problem, resetIndexedDb, scope, setup } from './outbound-push-worker-harness.js';

const intent: PlacementIntent = {
  version: 1, mode: 'top', targetParentNativeId: 'native-parent', collectionId: scope.collectionId,
  batchId: '11111111-1111-4111-8111-111111111111', batchOrder: 1, batchSize: 2,
};

const current = event('current', 'native-current', intent);
const predecessor = event('predecessor', 'native-predecessor', { ...intent, batchOrder: 0 });
const parent: MappingInput = { nativeId: 'native-parent', colpId: 'parent-colp', rootNativeId: 'root-native',
  nodeKind: 'folder', projection: { revision: 'parent-r1', childrenRevision: 'children-r1',
    childrenOrder: [], digest: 'sha256:parent' } };

test('a batch create waits for its predecessor to become authoritative', async () => {
  const pending: MappingInput = { nativeId: 'native-predecessor', colpId: 'pending-predecessor',
    rootNativeId: 'root-native', parentNativeId: parent.nativeId, parentColpId: parent.colpId,
    nodeKind: 'bookmark', projection: { revision: 'local-predecessor', digest: 'sha256:pending' } };
  const plan = await planCreatePlacement(store([parent, pending], [predecessor, current]), scope, current, intent);
  assert.deepEqual(plan, { kind: 'pending', code: 'create_batch_predecessor_pending' });
});

test('a batch create anchors after its authoritative predecessor', async () => {
  const confirmed: MappingInput = { nativeId: 'native-predecessor', colpId: 'predecessor-colp',
    rootNativeId: 'root-native', parentNativeId: parent.nativeId, parentColpId: parent.colpId,
    nodeKind: 'bookmark', projection: { revision: 'predecessor-r1', digest: 'sha256:confirmed' } };
  const plan = await planCreatePlacement(store([parent, confirmed], [predecessor, current]), scope, current, intent);
  assert.deepEqual(plan, { kind: 'ready', parentId: 'parent-colp', afterId: 'predecessor-colp' });
});

test('a top create retry anchors on its real native neighbour, after folders and pinned bookmarks', async () => {
  const single = { ...intent, batchOrder: 0, batchSize: 1 };
  const created = event('created', 'native-created', single);
  const sibling = (nativeId: string, colpId: string, nodeKind: 'folder' | 'bookmark'): MappingInput => ({ nativeId, colpId,
    rootNativeId: 'root-native', parentNativeId: parent.nativeId, parentColpId: parent.colpId, nodeKind,
    projection: { revision: `${colpId}-r1`, digest: `sha256:${colpId}` } });
  const mappings = [parent, sibling('native-folder', 'folder-colp', 'folder'), sibling('native-pinned', 'pinned-colp', 'bookmark'),
    sibling('native-other', 'other-colp', 'bookmark')];
  const plan = await planCreatePlacement(store(mappings, [created]), scope, created, single,
    ['native-folder', 'native-pinned', 'native-created', 'native-other']);
  assert.deepEqual(plan, { kind: 'ready', parentId: 'parent-colp', beforeId: 'other-colp' });
  const last = await planCreatePlacement(store(mappings.slice(0, 3), [created]), scope, created, single,
    ['native-folder', 'native-pinned', 'native-created']);
  assert.deepEqual(last, { kind: 'ready', parentId: 'parent-colp', afterId: 'pinned-colp' });
});

function event(opId: string, nativeId: string, placement: PlacementIntent): BookmarkEventRecord {
  return { scopeKey: 'scope', eventId: `event-${opId}`, ordinal: placement.batchOrder + 1,
    dedupeKey: `dedupe-${opId}`, occurredAt: '2026-09-19T00:00:00.000Z', kind: 'create', nativeId,
    details: { context: { placement: placement as unknown as import('../src/sync-state-store.js').JsonObject } },
    status: 'processed', opId };
}

function store(mappings: readonly MappingInput[], events: readonly BookmarkEventRecord[]) {
  return {
    getMappingByNativeId: async (_scope: unknown, nativeId: string) =>
      mappings.find((mapping) => mapping.nativeId === nativeId) ?? null,
    listMappings: async () => mappings,
    listBookmarkEvents: async (_scope: unknown, after: number, limit: number) =>
      events.filter((row) => row.ordinal > after).slice(0, limit),
  } as never;
}

function applied(opId: string, body: string) {
  const attempt = JSON.parse(body) as { batchId: string };
  return json(200, { batchId: attempt.batchId, results: [{ opId, sequence: 1, status: 'applied',
    targetId: 'node-created', revision: 'node-r1', cursor: 'cursor-1', warnings: [] }], serverCursor: 'cursor-1' });
}

test('a cleared-attempt placement retry pauses on revoked permission and resumes after it returns', async () => {
  resetIndexedDb();
  const fixture = await setup({ createPlacement: 'top' });
  try {
    let allowed = true; let reads = 0; let sends = 0;
    const worker = createOutboundPushWorker({ ...fixture.options,
      readChildrenOrder: async () => {
        reads += 1;
        if (!allowed) throw new BookmarkApiError('permission_denied', 'permission_required');
        return ['native-anchor-old'];
      },
      fetch: async (_url, init) => {
        sends += 1;
        if (sends === 1) return problem(409, 'position_context_stale', { retryable: true });
        return applied(fixture.queued.opId, String(init?.body));
      } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const cleared = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(cleared.attempt, undefined);
    assert.equal(cleared.retry.attempt, 1);
    allowed = false;
    fixture.clock.now = cleared.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'unknown');
    const paused = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(sends, 1);
    assert.equal(reads, 1);
    assert.equal(paused.status, 'unknown');
    assert.equal(paused.attempt, undefined);
    assert.equal(paused.retry.attempt, 1);
    assert.equal(paused.retry.notBefore <= fixture.clock.now, true);
    assert.equal(paused.recovery?.code, 'permission_required');
    assert.deepEqual(paused.payload, fixture.queued.payload);
    assert.equal(((await fixture.store.listBookmarkEvents(scope))[0]?.details.context as { placement?: { mode?: string } })
      ?.placement?.mode, 'top');
    assert.equal((await fixture.store.getScope(scope))?.rootStatus, 'permission_required');
    assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'active');
    assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.notEqual((await fixture.store.getEngineState(scope))?.lastError, 'create_placement_unproven');
    allowed = true;
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(sends, 2);
    assert.equal(reads, 2);
    assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal(((await fixture.store.listBookmarkEvents(scope))[0]?.details.context as { placement?: { mode?: string } })
      ?.placement?.mode, 'top');
  } finally { fixture.store.close(); }
});

test('an exact network attempt still retries its saved bytes when bookmark permission is revoked', async () => {
  resetIndexedDb();
  const fixture = await setup({ createPlacement: 'top' });
  try {
    const bodies: string[] = []; let reads = 0;
    const worker = createOutboundPushWorker({ ...fixture.options,
      readChildrenOrder: async () => { reads += 1; throw new BookmarkApiError('permission_denied', 'permission_required'); },
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) throw new TypeError('fetch failed');
        return applied(fixture.queued.opId, String(init?.body));
      } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    const held = (await fixture.store.listQueue(scope))[0]!;
    assert.ok(held.attempt);
    fixture.clock.now = held.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'terminal');
    assert.equal(reads, 0);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.notEqual((await fixture.store.getScope(scope))?.rootStatus, 'permission_required');
  } finally { fixture.store.close(); }
});

test('a native parent that is really gone still reports placement repair and is not created again', async () => {
  resetIndexedDb();
  const fixture = await setup({ createPlacement: 'top' });
  try {
    let sends = 0;
    const worker = createOutboundPushWorker({ ...fixture.options,
      readChildrenOrder: async () => { throw new Error("Can't find bookmark for id."); },
      fetch: async () => { sends += 1; return problem(409, 'position_context_stale', { retryable: true }); } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'recovery');
    assert.equal((await worker.drain()).outcome, 'recovery');
    assert.equal(sends, 1);
    const engine = await fixture.store.getEngineState(scope);
    assert.equal(engine?.recoveryFrozen, true);
    assert.equal(engine?.lastError, 'create_placement_parent_deleted');
    const view = describeSyncAttention({ recoveryFrozen: true, lastError: engine?.lastError, recoveryCode: engine?.lastError });
    assert.equal(view.terminal.show, true);
    assert.match(view.terminal.copy, /save location needs review/);
  } finally { fixture.store.close(); }
});

test('an unknown native child read freezes placement repair instead of creating the bookmark again', async () => {
  resetIndexedDb();
  const fixture = await setup({ createPlacement: 'top' });
  try {
    let sends = 0;
    const worker = createOutboundPushWorker({ ...fixture.options,
      readChildrenOrder: async () => { throw new Error('native_result_unknown'); },
      fetch: async () => { sends += 1; return problem(409, 'position_context_stale', { retryable: true }); } });
    assert.equal((await worker.drain()).outcome, 'unknown');
    fixture.clock.now = (await fixture.store.listQueue(scope))[0]!.retry.notBefore;
    assert.equal((await worker.drain()).outcome, 'recovery');
    assert.equal((await worker.drain()).outcome, 'recovery');
    assert.equal(sends, 1);
    assert.equal((await fixture.store.getEngineState(scope))?.lastError, 'create_placement_unproven');
    assert.notEqual((await fixture.store.listQueue(scope))[0]?.recovery?.code, 'permission_required');
  } finally { fixture.store.close(); }
});
