import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { fixture, scope } from './bookmark-event-queue-harness.js';

test('only proven remote subtree members discard delayed local removal callbacks', async () => {
  const { store } = await fixture(new IDBFactory());
  await store.createApplyIntent(scope, {
    intentId: 'remote-delete', correlationId: 'root-delete-correlation', operationId: 'remote-op',
    expected: { kind: 'remove', nativeId: 'folder' }, expiresAt: Date.now() + 60_000,
  });
  const anchors = {
    deleteMemberSet: [
      { colpId: 'child-colp', nativeId: 'child' },
      { colpId: 'folder-colp', nativeId: 'folder' },
    ],
    deleteMemberResults: { 'child-colp': 'not_started', 'folder-colp': 'not_started' },
  };
  await store.persistApplyIntentFacts(scope, 'remote-delete', { liveWorkKind: 'delete', anchors });
  await store.stageBookmarkEvent(scope, {
    eventId: 'child-remove', dedupeKey: 'child-removal', occurredAt: new Date().toISOString(),
    kind: 'remove', nativeId: 'child', details: {},
  });
  await store.stageBookmarkEvent(scope, {
    eventId: 'unrelated-remove', dedupeKey: 'unrelated-removal', occurredAt: new Date().toISOString(),
    kind: 'remove', nativeId: 'other', details: {},
  });
  assert.equal(await store.discardAppliedRemoteDeleteEcho(scope, 'child', 'child-remove'), false);
  assert.ok(await store.getBookmarkEvent(scope, 'child-remove'));

  await store.persistApplyIntentFacts(scope, 'remote-delete', { anchors: {
    ...anchors, deleteMemberResults: { 'child-colp': 'applied', 'folder-colp': 'absent' },
  } });
  assert.equal(await store.discardAppliedRemoteDeleteEcho(scope, 'child', 'child-remove'), true);
  assert.equal(await store.getBookmarkEvent(scope, 'child-remove'), null);
  assert.equal(await store.discardAppliedRemoteDeleteEcho(scope, 'folder'), false);
  assert.equal(await store.discardAppliedRemoteDeleteEcho(scope, 'other', 'unrelated-remove'), false);
  assert.ok(await store.getBookmarkEvent(scope, 'unrelated-remove'));
});
