import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { resolveEventIdentityTokens } from '../src/bookmark-event-resolve.js';
import { fixture, bookmark, scope } from './bookmark-event-queue-harness.js';

test('identity resolution never rewrites a title or extension resembling an event ID', async () => {
  const f = await fixture(new IDBFactory());
  const node = bookmark('new', 'root-selected', 0, 'Original', 'https://example.test/');
  f.api.put(node); await f.queue.created(node.id, node); await f.queue.flush();
  const event = (await f.store.listBookmarkEvents(scope))[0]!;
  const payload = { base: { title: `local-${event.eventId}` }, value: { title: event.eventId,
    extensions: { 'https://example.test/': `pending-${event.eventId}` } } };
  const resolved = await resolveEventIdentityTokens(f.store, scope, { draft: { type: 'update_node_content',
    targetId: `pending-${event.eventId}`, baseRevision: `local-${event.eventId}`, payload } }, new Map());
  assert.deepEqual(resolved.draft, { type: 'update_node_content', targetId: `pending-${event.opId}`,
    baseRevision: `local-${event.opId}`, payload });
});
