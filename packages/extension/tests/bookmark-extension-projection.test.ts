import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import type { Operation } from '@know-n/colp/types';
import { digestJson } from '../src/bookmark-event-codec.js';
import { createBookmarkEventHealer } from '../src/bookmark-event-heal.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { BOOKMARK_PIN_EXTENSION, extensionsPinned } from '../src/bookmark-pin-order.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createSyncStateStore, type JsonObject, type QueueOperation } from '../src/sync-state-store.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const vendor = 'https://vendor.example/extensions/version';
const extra = 'https://vendor.example/extensions/extra';
const nullable = 'https://vendor.example/extensions/nullable';
const removed = 'https://vendor.example/extensions/removed';
const added = 'https://vendor.example/extensions/added';
const pin = { [BOOKMARK_PIN_EXTENSION]: { pinned: true } };
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function queueFor(store: ReturnType<typeof createSyncStateStore>, api: ReturnType<typeof honestChrome>) {
  return createBookmarkEventQueue({ scope, store, autoFlush: false, api: {
    get: async id => (await api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
    getChildren: async id => (await api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })),
  } });
}
async function setup(extensions: JsonObject) {
  const f = await fixture(new IDBFactory(), { mappedNode: true }); stores.push(f.store);
  const api = honestChrome();
  for (const id of ['0', 'root-selected', 'root-private', 'root-unselected', 'folder-parent']) api.seed(f.api.node(id));
  api.seed(bookmark('mapped', 'root-selected', 1, 'Server before', 'https://example.test/before'));
  const current = (await f.store.getMappingByNativeId(scope, 'mapped'))!;
  const { scopeKey: _key, ...mapping } = current;
  const content = { ...current.projection.content!, extensions };
  await f.store.putMapping(scope, { ...mapping, nodeKind: 'bookmark', parentNativeId: 'root-selected',
    projection: { revision: 'server-new', digest: digestJson(content), content } });
  return { ...f, api, queue: queueFor(f.store, api) };
}
function reopen(f: Awaited<ReturnType<typeof setup>>) {
  f.store.close();
  const store = createSyncStateStore({ indexedDB: f.indexedDB }); stores.push(store);
  return { ...f, store, queue: queueFor(store, f.api) };
}
async function content(f: Awaited<ReturnType<typeof setup>>) {
  return (await f.store.getMappingByNativeId(scope, 'mapped'))!.projection.content!;
}
async function echo(f: Awaited<ReturnType<typeof setup>>, row: QueueOperation, canonical: JsonObject) {
  const parentId = (await f.store.getMappingByNativeId(scope, 'root-selected'))!.colpId;
  const base = pullFixtures.mutationEvent({ kind: 'update', sequence: row.sequence, collectionId: scope.collectionId,
    targetId: 'mapped-colp', parentId, replicaId: scope.replicaId });
  if (base.kind !== 'operation' || base.effect.kind !== 'node_content_updated') throw new Error('test_effect_invalid');
  const operation = row.payload as unknown as Operation, revision = `accepted-${row.sequence}`;
  const effect = { ...base.effect, effectId: row.opId, opId: row.opId, status: 'rebased' as const,
    operationDigest: canonicalOperationDigest(operation), node: { ...base.effect.node, ...canonical, revision } };
  effect.effectDigest = canonicalAuthoritativeEffectDigest(effect);
  await f.store.completeQueueWithReceipt(scope, row.sequence, { opId: row.opId, operationDigest: row.digest,
    kind: 'terminal', receiptId: `receipt-${row.opId}`, resultDigest: `sha256:result-${row.sequence}`,
    result: { results: [{ opId: row.opId, sequence: row.sequence, status: 'rebased', targetId: 'mapped-colp', revision }] } });
  const applier = createPullApplier({ scope, store: f.store, api: f.api,
    session: { acceptedProtocolVersion: '0.2', sessionId: 'session-extensions', collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}', effectPageAuthority: 'https://known.example' });
  await applier.stage(pullFixtures.page({ events: [{ ...base, operation, effect }],
    nextCursor: `echo-${row.sequence}`, collectionRevision: revision }));
  await applier.resume();
  assert.equal((await f.store.getQueueReceipt(scope, row.sequence))?.operationDigest, row.digest);
}

test('pin namespace intent preserves current extensions through pending capture, flush, restart and authoritative Pull echoes', async () => {
  const authored = { [vendor]: { version: 1 } }, independent = { [vendor]: { version: 2 }, [extra]: { keep: true } };
  let f = await setup(independent);
  const baseline = { revision: 'server-old', extensions: authored, eventId: 'offline-pin' };
  assert.equal((await f.queue.pinned('mapped', true, baseline)).outcome, 'staged');
  const firstDraft = (await f.store.getBookmarkEvent(scope, baseline.eventId))!.details.draft;
  assert.equal((await f.queue.tagged('mapped', ['later-tag'], { revision: 'server-new', tags: [], eventId: 'later-tags' })).outcome, 'staged');
  const pending = (await f.store.getBookmarkEvent(scope, 'later-tags'))!;
  const projected = (pending.details.mapping as unknown as { projection: { content: JsonObject } }).projection.content;
  assert.deepEqual(projected.extensions, { ...independent, ...pin }, 'pending identity preserves Current before flush');
  await f.queue.flush();
  const [row] = await f.store.listQueue(scope); assert.ok(row);
  const authoredPayload = { base: { extensions: authored }, value: { extensions: { ...authored, ...pin } } };
  assert.deepEqual(row.payload.payload, authoredPayload);
  assert.deepEqual((await content(f)).extensions, { ...independent, ...pin }, 'flush preserves independent namespaces');
  const bytes = JSON.stringify(row.payload), digest = row.digest;
  f = reopen(f);
  assert.deepEqual((await content(f)).extensions, { ...independent, ...pin });
  assert.deepEqual(await f.queue.pinned('mapped', true, baseline), { outcome: 'filtered' });
  await f.queue.flush();
  assert.equal(JSON.stringify((await f.store.getQueueByOpId(scope, row.opId))!.payload), bytes);
  assert.equal((await f.store.getQueueByOpId(scope, row.opId))!.digest, digest);
  assert.deepEqual((await f.store.getBookmarkEvent(scope, baseline.eventId))!.details.draft, firstDraft);
  await echo(f, row, { title: 'Server before', url: 'https://example.test/before', extensions: { ...independent, ...pin } });
  await f.queue.flush();
  const tagRow = (await f.store.listQueue(scope)).find(candidate => candidate.opId !== row.opId)!;
  assert.ok(tagRow); assert.deepEqual(tagRow.payload.payload, { base: { tags: [] }, value: { tags: ['later-tag'] } });
  assert.deepEqual((await content(f)).extensions, { ...independent, ...pin });
  await echo(f, tagRow, { title: 'Server before', url: 'https://example.test/before',
    tags: ['later-tag'], extensions: { ...independent, ...pin } });
  f = reopen(f);
  assert.deepEqual((await content(f)).extensions, { ...independent, ...pin });
  assert.deepEqual((await content(f)).tags, ['later-tag']);
  assert.equal(extensionsPinned((await content(f)).extensions), true);
  assert.deepEqual(f.api.calls, [], 'opaque namespaces and annotations never become Chrome writes');
});

const cases: { name: string; base: JsonObject; value: JsonObject; current: JsonObject; expected: JsonObject }[] = [
  { name: 'deep equality ignores object key order but retains independent nested changes',
    base: { extensions: { [vendor]: { nested: { a: 1, b: 2 }, list: [{ x: 1, y: 2 }] } } },
    value: { extensions: { [vendor]: { list: [{ y: 2, x: 1 }], nested: { b: 2, a: 1 } }, ...pin } },
    current: { [vendor]: { remote: { value: 2 } }, [extra]: { keep: true } },
    expected: { [vendor]: { remote: { value: 2 } }, [extra]: { keep: true }, ...pin } },
  { name: 'historical full maps still apply every changed, added and removed namespace',
    base: { extensions: { [vendor]: 1, [removed]: { old: true }, [nullable]: null } },
    value: { extensions: { [vendor]: 3, [added]: { new: true }, [nullable]: null } },
    current: { [vendor]: 2, [removed]: { old: true }, [nullable]: { independent: true }, [extra]: true },
    expected: { [vendor]: 3, [added]: { new: true }, [nullable]: { independent: true }, [extra]: true } },
  { name: 'explicit namespace null adds a value instead of deleting it', base: { extensions: {} },
    value: { extensions: { [nullable]: null } }, current: { [extra]: true }, expected: { [nullable]: null, [extra]: true } },
  { name: 'explicit namespace null replaces an authored value while retaining other namespaces',
    base: { extensions: { [nullable]: { old: true } } }, value: { extensions: { [nullable]: null } },
    current: { [nullable]: { remote: true }, [extra]: true }, expected: { [nullable]: null, [extra]: true } },
  { name: 'absence removes a namespace whose old value was null', base: { extensions: { [nullable]: null } },
    value: { extensions: {} }, current: { [nullable]: null, [extra]: true }, expected: { [extra]: true } },
  { name: 'whole-map null clears authored namespaces and retains independently added namespaces',
    base: { extensions: { [vendor]: 1, [nullable]: null } }, value: { extensions: null },
    current: { [vendor]: 2, [nullable]: null, [extra]: true }, expected: { [extra]: true } },
  { name: 'a null extension base is an empty map', base: { extensions: null }, value: { extensions: { [vendor]: 1 } },
    current: { [extra]: true }, expected: { [vendor]: 1, [extra]: true } },
  { name: 'ordinary content fields leave extensions intact', base: { title: 'Old' }, value: { title: 'New' },
    current: { [vendor]: { preserved: true } }, expected: { [vendor]: { preserved: true } } },
];
for (const c of cases) test(c.name, async () => {
  const f = await setup(c.current), payload = { base: c.base, value: c.value };
  const current = (await f.store.getMappingByNativeId(scope, 'mapped'))!;
  const { scopeKey: _key, ...mapping } = current;
  const draft = { type: 'update_node_content', targetId: current.colpId, baseRevision: 'server-old', payload };
  await f.store.stageBookmarkEvent(scope, { eventId: 'legacy-full-map', dedupeKey: 'legacy-full-map', nativeId: 'mapped',
    kind: 'change', occurredAt: '2026-10-20T00:00:00Z', details: { draft,
      mapping: { ...mapping, projection: { ...mapping.projection, revision: 'local-legacy-full-map' } } as unknown as JsonObject } });
  const healer = createBookmarkEventHealer({ scope, store: f.store,
    listPendingEvents: () => f.store.listBookmarkEventsByStatus(scope, 'pending') });
  assert.deepEqual((await healer.identityFor('mapped'))!.content!.extensions, c.expected);
  assert.deepEqual((await f.store.getBookmarkEvent(scope, 'legacy-full-map'))!.details.draft, draft);
  await f.queue.flush();
  assert.deepEqual((await content(f)).extensions, c.expected);
  const [row] = await f.store.listQueue(scope); assert.ok(row);
  assert.deepEqual(row.payload.payload, payload, 'only the local projection changes, never the wire intent');
  if (c.value.title) assert.equal((await content(f)).title, c.value.title);
});
