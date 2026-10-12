import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

type Changes = Record<string, string>;
async function setup() {
  const indexedDB = new IDBFactory();
  let { store } = await fixture(indexedDB, { mappedNode: true });
  const root = (await store.getMappingByNativeId(scope, 'root-selected'))!;
  const api = honestChrome();
  api.seed({ id: 'root-selected', title: 'Selected root', index: 0 });
  api.seed({ id: 'mapped', parentId: 'root-selected', index: 0,
    title: 'Server before', url: 'https://example.test/before' });
  const queueFor = () => createBookmarkEventQueue({ scope, store, api: api as BookmarkEventApi, autoFlush: false });
  const applierFor = () => createPullApplier({ scope, store, api, session: {
    acceptedProtocolVersion: '0.2', sessionId: 'session-echo', collectionId: scope.collectionId,
    conversionPolicy: { separator: 'preserve_remote' },
  }, effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
  effectPageAuthority: 'https://known.example' });
  let queue = queueFor();
  let applier = applierFor();
  let sequence = 0;
  async function remote(changes: Changes, observeEcho = true) {
    const mapping = (await store.getMappingByNativeId(scope, 'mapped'))!;
    const event = pullFixtures.mutationEvent({ kind: 'update', sequence: ++sequence,
      collectionId: scope.collectionId, targetId: mapping.colpId, parentId: root.colpId });
    assert.equal(event.kind, 'operation');
    if (event.kind !== 'operation' || event.effect.kind !== 'node_content_updated') throw new Error('invalid fixture');
    const operation = { ...event.operation, baseRevision: mapping.projection.revision, payload: {
      base: Object.fromEntries(Object.keys(changes).map(key => [key, mapping.projection.content![key]])),
      value: changes,
    } };
    const node = { ...event.effect.node, ...mapping.projection.content, ...changes, revision: `revision-${sequence}` };
    const effect = { ...event.effect, node, operationDigest: canonicalOperationDigest(operation) };
    const updatedEvent = { ...event, operation, effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } };
    await applier.stage(pullFixtures.page({ events: [updatedEvent], nextCursor: `cursor-remote-${sequence}`,
      collectionRevision: `collection-${sequence}` }));
    await applier.resume();
    if (observeEcho) assert.equal((await queue.changed('mapped', changes, 'callback')).outcome, 'apply_intent_reserved');
  }
  return {
    api, remote, store: () => store, queue: () => queue,
    async restart() {
      await store.close(); store = createSyncStateStore({ indexedDB });
      queue = queueFor(); applier = applierFor();
    },
    async emptyPull() {
      await applier.stage(pullFixtures.page({ events: [], nextCursor: `cursor-remote-${sequence}`,
        collectionRevision: `collection-${sequence}` }));
      await applier.resume();
    },
    close: () => store.close(),
  };
}

const cases: { name: string; before: Changes; after: Changes; revert: Changes }[] = [
  { name: 'title', before: { title: 'B' }, after: { title: 'C' }, revert: { title: 'B' } },
  { name: 'URL', before: { url: 'https://example.test/b' }, after: { url: 'https://example.test/c' },
    revert: { url: 'https://example.test/b' } },
  { name: 'one field of a combined update', before: { title: 'B', url: 'https://example.test/b' },
    after: { title: 'C', url: 'https://example.test/c' }, revert: { title: 'B' } },
];
for (const scenario of cases) {
  for (const restart of [false, true]) {
    for (const source of ['callback', 'scan'] as const) {
      test(`real ${scenario.name} revert survives ${source}, restart=${restart}`, async () => {
        const f = await setup();
        try {
          await f.remote(scenario.before); await f.remote(scenario.after);
          if (restart) await f.restart();
          assert.equal((await f.store().listQueue(scope)).length, 0);
          await f.api.update('mapped', scenario.revert);
          assert.equal((await f.queue().changed('mapped', scenario.revert, source)).outcome, 'staged');
          assert.equal((await f.store().listBookmarkEventsByStatus(scope, 'pending', 0, 100)).length, 1);
          await f.queue().flush();
          await f.emptyPull();
          const queued = await f.store().listQueue(scope);
          assert.equal(queued.length, 1);
          assert.equal(queued[0]!.payload.type, 'update_node_content');
          assert.deepEqual(queued[0]!.payload.payload, {
            base: Object.fromEntries(Object.keys(scenario.revert).map(key => [key, scenario.after[key]])),
            value: scenario.revert,
          });
          const projected = (await f.store().getMappingByNativeId(scope, 'mapped'))!.projection.content!;
          for (const [field, value] of Object.entries(scenario.revert)) assert.equal(projected[field], value);
        } finally { await f.close(); }
      });
    }
  }
}

test.each([false, true])('late and duplicate old callbacks remain suppressed, previously observed=%s', async observed => {
  const f = await setup();
  try {
    await f.remote({ title: 'B' }, observed); await f.remote({ title: 'C' });
    await f.restart();
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      assert.equal((await f.queue().changed('mapped', { title: 'B' }, 'callback')).outcome, 'apply_intent_reserved');
    }
    await f.queue().flush();
    assert.equal((await f.store().listQueue(scope)).length, 0);
    assert.equal((await f.store().listBookmarkEventsByStatus(scope, 'pending', 0, 100)).length, 0);
    assert.equal((await f.store().getMappingByNativeId(scope, 'mapped'))!.projection.content!.title, 'C');
    assert.equal((await f.api.get('mapped'))[0]!.title, 'C');
  } finally { await f.close(); }
});
