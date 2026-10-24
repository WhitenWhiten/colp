import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import { bookmark, fixture, folder, mapping, scope } from './bookmark-event-queue-harness.js';
import { endpoints, problem } from './outbound-push-worker-harness.js';

/**
 * N-3 / D-09: placement order is per domain, not a global ingress stall.
 * These cases run the queue. They do not apply afterId on a server, so the
 * preserved order is the commit sequence of operations that name that anchor.
 */
function body(record: QueueOperation): Record<string, unknown> {
  return record.payload.payload as Record<string, unknown>;
}
function assertAuthoritative(record: QueueOperation): void {
  assert.doesNotMatch(String(record.baseRevision ?? ''), /^(?:pending|local)-/);
  assert.doesNotMatch(String(record.payload.targetId ?? ''), /^(?:pending|local)-/);
  for (const field of ['parentId', 'newParentId', 'afterId', 'beforeId',
    'baseSourceParentRevision', 'baseTargetParentRevision']) {
    const value = body(record)[field];
    if (typeof value === 'string') assert.doesNotMatch(value, /^(?:pending|local)-/);
  }
}
async function parked(store: Awaited<ReturnType<typeof fixture>>['store'], eventId: string) {
  const row = (await store.listIngressDiagnostics(scope)).find((item) => item.park?.eventId === eventId);
  return row?.park;
}

describe('N-3 placement order domain', () => {
  test('a blocked parent holds a later sibling and the same anchor, and an unrelated parent commits', async () => {
    const { queue, store, api } = await fixture(new IDBFactory());
    await mapping(store, 'folder-target', 'target-colp', 'root-selected', 'target-r1', { title: 'Target' }, 'root-selected');
    await mapping(store, 'folder-ready', 'ready-colp', 'root-selected', 'ready-r1', { title: 'Ready' }, 'root-selected');
    await mapping(store, 'folder-unrelated', 'unrelated-colp', 'root-selected', 'unrelated-r1',
      { title: 'Unrelated' }, 'root-selected');
    await mapping(store, 'folder-other', 'other-colp', 'root-selected', 'other-r1',
      { title: 'Other' }, 'root-selected');
    // No children fence: the first move can be staged but cannot commit.
    await store.putMapping(scope, { nativeId: 'folder-blocked', colpId: 'blocked-colp', rootNativeId: 'root-selected',
      nodeKind: 'folder', parentNativeId: 'root-selected', projection: { revision: 'blocked-r1',
        digest: 'sha256:blocked', content: { title: 'Blocked' } } });
    for (const [id, parent, title] of [
      ['anchor', 'folder-target', 'Anchor'], ['tail', 'folder-target', 'Tail'],
      ['node-x', 'folder-blocked', 'X'], ['node-y', 'folder-ready', 'Y'], ['node-w', 'folder-ready', 'W'],
    ] as const) {
      await mapping(store, id, `${id}-colp`, 'root-selected', `${id}-r1`,
        { title, url: `https://example.test/${id}` }, parent);
    }
    api.put(folder('folder-target', 'root-selected', 1, 'Target'));
    api.put(folder('folder-blocked', 'root-selected', 2, 'Blocked'));
    api.put(folder('folder-ready', 'root-selected', 3, 'Ready'));
    api.put(folder('folder-unrelated', 'root-selected', 4, 'Unrelated'));
    api.put(folder('folder-other', 'root-selected', 5, 'Other'));
    api.put(bookmark('anchor', 'folder-target', 0, 'Anchor', 'https://example.test/anchor'));
    api.put(bookmark('tail', 'folder-target', 1, 'Tail', 'https://example.test/tail'));
    api.put(bookmark('node-x', 'folder-blocked', 0, 'X', 'https://example.test/node-x'));
    api.put(bookmark('node-y', 'folder-ready', 0, 'Y', 'https://example.test/node-y'));
    api.put(bookmark('node-w', 'folder-ready', 1, 'W', 'https://example.test/node-w'));
    api.put(bookmark('node-z', 'folder-unrelated', 0, 'Z', 'https://example.test/node-z'));

    assert.equal((await queue.moved('node-x', { parentId: 'folder-target', index: 1,
      oldParentId: 'folder-blocked', oldIndex: 0 })).outcome, 'staged');
    assert.equal((await queue.moved('node-y', { parentId: 'folder-target', index: 1,
      oldParentId: 'folder-ready', oldIndex: 0 })).outcome, 'staged');
    assert.equal((await queue.moved('node-w', { parentId: 'folder-target', index: 2,
      oldParentId: 'folder-ready', oldIndex: 1 })).outcome, 'staged');
    assert.equal((await queue.created('node-z', api.node('node-z'))).outcome, 'staged');
    const staged = await store.listBookmarkEvents(scope);
    const context = (nativeId: string) => staged.find((event) => event.nativeId === nativeId)!.details.context as
      Record<string, unknown>;
    assert.equal(context('node-x').afterNativeId, 'anchor');
    assert.equal(context('node-y').afterNativeId, 'anchor');
    assert.equal(context('node-w').afterNativeId, 'tail');
    assert.notEqual(context('node-w').afterNativeId, context('node-x').afterNativeId);

    await queue.flush();
    assert.deepEqual((await store.listQueue(scope)).map((row) => body(row).node &&
      (body(row).node as { title?: string }).title), ['Z']);
    assertAuthoritative((await store.listQueue(scope))[0]!);
    assert.deepEqual((await store.listBookmarkEvents(scope)).filter((event) => event.kind === 'move')
      .map((event) => event.status), ['pending', 'pending', 'pending']);

    for (let round = 1; round < 4; round += 1) await queue.flush();
    api.put(bookmark('node-z2', 'folder-other', 0, 'Z2', 'https://example.test/node-z2'));
    assert.equal((await queue.created('node-z2', api.node('node-z2'))).outcome, 'staged');
    await queue.flush();
    const blocked = (await store.listBookmarkEvents(scope)).find((event) => event.nativeId === 'node-x')!;
    assert.equal((await parked(store, blocked.eventId))?.code, 'children_fence_missing');
    assert.equal((await parked(store, blocked.eventId))?.state, 'open');
    assert.deepEqual((await store.listBookmarkEvents(scope)).filter((event) => event.kind === 'move')
      .map((event) => event.status), ['pending', 'pending', 'pending']);
    assert.deepEqual((await store.listQueue(scope)).map((row) => (body(row).node as { title?: string } | undefined)?.title),
      ['Z', 'Z2']);

    await mapping(store, 'folder-blocked', 'blocked-colp', 'root-selected', 'blocked-r2',
      { title: 'Blocked' }, 'root-selected');
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.deepEqual(records.map((row) => row.payload.type),
      ['create_node', 'create_node', 'move_node', 'move_node', 'move_node']);
    assert.deepEqual(records.map((row) => row.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(records.slice(2).map((row) => row.payload.targetId), ['node-x-colp', 'node-y-colp', 'node-w-colp']);
    assert.equal(body(records[2]!).afterId, 'anchor-colp');
    assert.equal(body(records[3]!).afterId, 'anchor-colp');
    assert.equal(body(records[4]!).afterId, 'tail-colp');
    assert.ok((records[2]!.sequence) < (records[3]!.sequence));
    for (const record of records) assertAuthoritative(record);
    assert.equal((await store.listBookmarkEvents(scope)).some((event) => event.status === 'pending'), false);
    assert.equal(JSON.stringify(records).includes('pending-'), false);
  });

  test('ready placements that share a parent still commit in ingress order in one flush', async () => {
    const { queue, store, api } = await fixture(new IDBFactory());
    await mapping(store, 'folder-dest', 'dest-colp', 'root-selected', 'dest-r1', { title: 'Dest' }, 'root-selected');
    await mapping(store, 'folder-src', 'src-colp', 'root-selected', 'src-r1', { title: 'Src' }, 'root-selected');
    await mapping(store, 'anchor', 'anchor-colp', 'root-selected', 'anchor-r1',
      { title: 'Anchor', url: 'https://example.test/anchor' }, 'folder-dest');
    await mapping(store, 'node-a', 'node-a-colp', 'root-selected', 'node-a-r1',
      { title: 'A', url: 'https://example.test/a' }, 'folder-src');
    await mapping(store, 'node-b', 'node-b-colp', 'root-selected', 'node-b-r1',
      { title: 'B', url: 'https://example.test/b' }, 'folder-src');
    api.put(folder('folder-dest', 'root-selected', 1, 'Dest'));
    api.put(folder('folder-src', 'root-selected', 2, 'Src'));
    api.put(bookmark('anchor', 'folder-dest', 0, 'Anchor', 'https://example.test/anchor'));
    api.put(bookmark('node-a', 'folder-src', 0, 'A', 'https://example.test/a'));
    api.put(bookmark('node-b', 'folder-src', 1, 'B', 'https://example.test/b'));
    // Both land on the confirmed anchor, so neither identity becomes the other's anchor.
    assert.equal((await queue.moved('node-a', { parentId: 'folder-dest', index: 1,
      oldParentId: 'folder-src', oldIndex: 0 })).outcome, 'staged');
    assert.equal((await queue.moved('node-b', { parentId: 'folder-dest', index: 1,
      oldParentId: 'folder-src', oldIndex: 1 })).outcome, 'staged');
    await queue.flush();
    const records = await store.listQueue(scope);
    assert.deepEqual(records.map((row) => [row.sequence, row.payload.targetId]),
      [[1, 'node-a-colp'], [2, 'node-b-colp']]);
    assert.equal(body(records[0]!).afterId, 'anchor-colp');
    assert.equal(body(records[1]!).afterId, 'anchor-colp');
    for (const record of records) assertAuthoritative(record);
  });

  test('a rejected dependency does not permanently block an unrelated parent', async () => {
    const { queue, store, api } = await fixture(new IDBFactory(), { mappedNode: true });
    api.put(folder('folder-new', 'root-selected', 1, 'New folder'));
    assert.equal((await queue.created('folder-new', api.node('folder-new'))).outcome, 'staged');
    await queue.flush();
    api.put(bookmark('child', 'folder-new', 0, 'Child', 'https://example.test/child'));
    api.put(bookmark('root-later', 'root-selected', 2, 'Later', 'https://example.test/later'));
    assert.equal((await queue.created('child', api.node('child'))).outcome, 'staged');
    assert.equal((await queue.created('root-later', api.node('root-later'))).outcome, 'staged');
    await queue.flush();
    const refused = await createOutboundPushWorker({ scope, store, endpoints: async () => endpoints,
      sessions: { async get() { return { credential: { accessToken: 'token-n3' }, session: {
        sessionId: 'session-n3', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
        credentialAuthorityDigest: 'a'.repeat(64), snapshotRequired: false,
        collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
        replicaLease: { leaseId: 'lease-n3', generation: String(scope.generation), state: 'active',
          expiresAt: '2099-01-01T00:00:00Z' } } }; } },
      now: () => 1_000, random: () => 0, ownerId: () => 'owner-n3', schedule: () => undefined,
      fetch: async () => problem(422, 'invalid_document', { retryable: false }) }).drain();
    assert.equal(refused.outcome, 'rejected');

    await mapping(store, 'folder-unrelated', 'unrelated-colp', 'root-selected', 'unrelated-r1',
      { title: 'Unrelated' }, 'root-selected');
    api.put(folder('folder-unrelated', 'root-selected', 4, 'Unrelated'));
    api.put(bookmark('independent', 'folder-unrelated', 0, 'Independent', 'https://example.test/independent'));
    api.put(bookmark('mapped', 'root-selected', 3, 'Server before', 'https://example.test/before'));
    // Source is the rejected sibling's parent. A rejected quarantine must not pin that parent.
    assert.equal((await queue.moved('mapped', { parentId: 'folder-parent', index: 0,
      oldParentId: 'root-selected', oldIndex: 3 })).outcome, 'staged');
    assert.equal((await queue.created('independent', api.node('independent'))).outcome, 'staged');
    await queue.flush();
    let rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => [row.sequence, row.status, row.payload.type]),
      [[1, 'rejected', 'create_node'], [2, 'pending', 'create_node'], [3, 'pending', 'move_node'], [4, 'pending', 'create_node']]);
    assert.equal((body(rows[1]!).node as { title?: string }).title, 'Later');
    assert.equal(body(rows[1]!).afterId, undefined);
    assert.equal(rows[2]!.payload.targetId, 'mapped-colp');
    assert.equal((body(rows[3]!).node as { title?: string }).title, 'Independent');
    for (const row of rows.slice(1)) assertAuthoritative(row);
    const child = (await store.listBookmarkEvents(scope)).find((event) => event.nativeId === 'child')!;
    const later = (await store.listBookmarkEvents(scope)).find((event) => event.nativeId === 'root-later')!;
    assert.equal(child.status, 'pending');
    assert.equal(later.status, 'processed');
    assert.equal((await parked(store, child.eventId))?.code, 'dependency_rejected');
    assert.notEqual((await parked(store, later.eventId))?.state, 'parked');
    assert.equal(JSON.stringify(rows).includes('pending-'), false);

    await mapping(store, 'folder-later', 'later-colp', 'root-selected', 'later-r1', { title: 'Later folder' }, 'root-selected');
    api.put(folder('folder-later', 'root-selected', 5, 'Later folder'));
    api.put(bookmark('independent-2', 'folder-later', 0, 'Independent 2', 'https://example.test/independent-2'));
    assert.equal((await queue.created('independent-2', api.node('independent-2'))).outcome, 'staged');
    await queue.flush();
    rows = await store.listQueue(scope);
    assert.equal((body(rows[4]!).node as { title?: string }).title, 'Independent 2');
    assert.equal(rows[4]!.sequence, 5);
    assert.equal((await store.listBookmarkEvents(scope)).find((event) => event.nativeId === 'child')?.status, 'pending');
    assertAuthoritative(rows[4]!);
  });

  test('a quarantined poison draft does not pin its parent or an unrelated parent', async () => {
    const { queue, store, api } = await fixture(new IDBFactory(), { mappedNode: true });
    await mapping(store, 'folder-unrelated', 'unrelated-colp', 'root-selected', 'unrelated-r1',
      { title: 'Unrelated' }, 'root-selected');
    await mapping(store, 'other', 'other-colp', 'root-selected', 'other-r1',
      { title: 'Other', url: 'https://example.test/other' }, 'root-selected');
    // Identity exists, so prepare reaches the schema check and quarantines the draft as poison.
    await store.stageBookmarkEvent(scope, { eventId: 'poison-move', dedupeKey: 'dedupe-poison-move',
      occurredAt: '2026-07-27T00:00:00Z', kind: 'move', nativeId: 'mapped',
      details: { draft: { type: 'not_a_protocol_operation' }, context: { sourceParentNativeId: 'root-selected',
        targetParentNativeId: 'folder-parent', afterNativeId: 'other' } } });
    api.put(bookmark('mapped', 'root-selected', 1, 'Server before', 'https://example.test/before'));
    api.put(bookmark('other', 'root-selected', 2, 'Other', 'https://example.test/other'));
    api.put(folder('folder-unrelated', 'root-selected', 3, 'Unrelated'));
    assert.equal((await queue.moved('other', { parentId: 'folder-parent', index: 0,
      oldParentId: 'root-selected', oldIndex: 2 })).outcome, 'staged');
    api.put(bookmark('elsewhere', 'folder-unrelated', 0, 'Elsewhere', 'https://example.test/elsewhere'));
    assert.equal((await queue.created('elsewhere', api.node('elsewhere'))).outcome, 'staged');
    await queue.flush();
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => row.payload.type), ['move_node', 'create_node']);
    assert.equal(rows[0]!.payload.targetId, 'other-colp');
    assert.equal((body(rows[1]!).node as { title?: string }).title, 'Elsewhere');
    for (const row of rows) assertAuthoritative(row);
    assert.equal((await parked(store, 'poison-move'))?.state, 'parked');
    assert.equal((await parked(store, 'poison-move'))?.code, 'operation_schema_invalid');
    assert.equal((await store.listBookmarkEvents(scope)).find((event) => event.eventId === 'poison-move')?.status,
      'pending');

    await mapping(store, 'folder-later', 'later-colp', 'root-selected', 'later-r1', { title: 'Later' }, 'root-selected');
    api.put(folder('folder-later', 'root-selected', 4, 'Later'));
    api.put(bookmark('elsewhere-2', 'folder-later', 0, 'Elsewhere 2', 'https://example.test/elsewhere-2'));
    assert.equal((await queue.created('elsewhere-2', api.node('elsewhere-2'))).outcome, 'staged');
    await queue.flush();
    assert.equal((await store.listQueue(scope)).length, 3);
    assert.equal((await parked(store, 'poison-move'))?.attempts, 1);
  });
});
