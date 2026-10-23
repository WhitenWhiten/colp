import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';
import { createProjectionSuppression } from '../src/recovery-overlay.js';

for (const [remoteUrl, chromeUrl] of [
  ['https://github.com', 'https://github.com/'],
  ['https://GITHUB.com:443/a b?q=1#part', 'https://github.com/a%20b?q=1#part'],
] as const) {
  test(`remote creates reserve the Chromium callback for ${remoteUrl}`, async () => {
    const { queue, store, api } = await fixture(new IDBFactory());
    try {
      const details = { parentId: 'folder-parent', node: { kind: 'bookmark', title: 'Remote', url: remoteUrl } };
      const event = { eventId: 'remote-event', cursor: 'cursor-next', operationId: 'remote-op',
        effectId: 'remote-effect', effectDigest: 'sha256:remote-effect', operationDigest: 'sha256:remote-op',
        kind: 'node_created', payload: {} };
      await store.stagePullPage(scope, { pageId: 'remote-page', previousCursor: 'cursor-3', nextCursor: 'cursor-next',
        collectionRevision: 'revision-next', pageDigest: 'sha256:page', events: [event], effectPages: [] });
      await store.preparePullIntent(scope, event.eventId, {
        intentId: 'remote-create', operationId: 'remote-op',
        eventId: event.eventId, effectId: event.effectId,
        correlationId: queue.correlationFor('create', '', details),
        expected: { kind: 'create', nativeId: 'pending:remote' }, expiresAt: Date.now() + 60_000,
        state: 'intent_prepared',
      });
      await store.markPullBrowserCallStarted(scope, event.eventId);
      const native = bookmark('remote-native', 'folder-parent', 0, 'Remote', chromeUrl!);
      api.put(native);
      assert.equal((await queue.created(native.id, native)).outcome, 'apply_intent_reserved');
      assert.equal((await store.listBookmarkEvents(scope)).length, 0);
      assert.equal(await store.getMappingByNativeId(scope, native.id), null);
    } finally { await store.close(); }
  });
}

test('recovery creates reserve canonical URLs while preserving a distinct local URL', async () => {
  const { queue, store, api } = await fixture(new IDBFactory());
  try {
    await store.replaceProjectionIntents(scope, [{
      intentId: 'create:remote', kind: 'create', colpId: 'remote', order: 1,
      parentNativeId: 'folder-parent', title: 'Remote', url: 'https://github.com',
      suppression: createProjectionSuppression('folder-parent', 'Remote', 'https://github.com'),
      generation: scope.generation, state: 'executing',
    }]);
    const remote = bookmark('remote-native', 'folder-parent', 0, 'Remote', 'https://github.com/');
    api.put(remote);
    assert.equal((await queue.created(remote.id, remote)).outcome, 'apply_intent_reserved');
    const local = bookmark('local-native', 'folder-parent', 1, 'Remote', 'https://github.com/?different=1');
    api.put(local);
    assert.equal((await queue.created(local.id, local)).outcome, 'staged');
    assert.equal((await store.listBookmarkEvents(scope)).length, 1);
  } finally { await store.close(); }
});

test('projection update suppression keeps a mismatched local callback in the inbox', async () => {
  const { queue, store, api } = await fixture(new IDBFactory(), { mappedNode: true });
  try {
    await store.replaceProjectionIntents(scope, [{
      intentId: 'update:mapped', kind: 'update', colpId: 'mapped', order: 1,
      nativeId: 'mapped', suppression: 'recovery:update:mapped',
      title: 'Remote title', url: 'https://example.test/remote',
      generation: scope.generation, state: 'executing',
    }]);
    api.put(bookmark('mapped', 'root-selected', 0, 'Local edit', 'https://example.test/before'));

    assert.equal((await queue.changed('mapped', { title: 'Local edit' }, 'callback')).outcome, 'staged');
    const inbox = await store.listBookmarkEventsByStatus(scope, 'pending', 0, 100);
    assert.equal(inbox.length, 1);
    const draft = inbox[0]!.details.draft as {
      readonly payload: { readonly value: { readonly title: string } };
    };
    assert.equal(draft.payload.value.title, 'Local edit');
  } finally { await store.close(); }
});
