import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  applyRemoteNodeContentUpdate, unqueuedNativeContentFields,
} from '../src/pull-native-content-barrier.js';
import { PullChromeUrlRejected } from '../src/pull-projection.js';
import type { MappingInput } from '../src/sync-state-store.js';

const mapping: MappingInput = {
  nativeId: 'native-1', colpId: 'node-1', rootNativeId: 'native-root', nodeKind: 'bookmark',
  parentNativeId: 'native-root',
  projection: { revision: 'revision-old', digest: 'sha256:old', content: { title: 'Known', url: 'https://known.example/' } },
};

const node = {
  id: 'node-1', collectionId: 'collection-1', kind: 'bookmark' as const, parentId: 'root-colp',
  position: 'p1', visibility: 'private' as const, revision: 'revision-next',
  createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z',
  title: 'Remote', url: 'https://known.example/',
};

test('unqueued overlay keeps live values that match neither the projection nor the remote', () => {
  assert.deepEqual(unqueuedNativeContentFields(
    { title: 'Live', url: 'https://live.example/' },
    { title: 'Known', url: 'https://known.example/' },
    { title: 'Remote', url: 'https://known.example/' },
  ), { title: 'Live', url: 'https://live.example/' });
  assert.deepEqual(unqueuedNativeContentFields(
    { title: 'Remote', url: 'https://known.example/' },
    { title: 'Known', url: 'https://known.example/' },
    { title: 'Remote', url: 'https://known.example/' },
  ), {});
});

test('file and chrome urls are not passed to chrome.bookmarks.update; https still is', async () => {
  const updates: unknown[] = [];
  const apply = (url: string) => applyRemoteNodeContentUpdate({
    store: {
      getScope: async () => ({ selectedRoots: [] }),
      stageBookmarkEvent: async () => undefined,
      getPullEvent: async () => null,
    } as never,
    scope: {} as never,
    api: { update: async (_id: string, changes: unknown) => { updates.push(changes); } } as never,
    mapping, node: { ...node, url, title: 'Remote' }, effectDigest: 'sha256:effect', eventId: 'event-1',
    mounts: [], now: () => 1,
    lookup: async () => ({ class: 'present', nodes: [{ id: 'native-1', title: 'Known', url: 'https://known.example/' }] }),
    targetMissingError: async () => new Error('missing'),
    queuedLocal: {},
  });
  await apply('https://example.test/kept');
  assert.deepEqual(updates, [{ title: 'Remote', url: 'https://example.test/kept' }]);
  for (const url of ['file:///tmp/secret', 'chrome://settings']) {
    updates.length = 0;
    await assert.rejects(() => apply(url), (error: unknown) =>
      error instanceof PullChromeUrlRejected && error.code === 'unsupported_url_scheme');
    assert.deepEqual(updates, []);
  }
});

test('a folder content update has no url and still reaches chrome.bookmarks.update', async () => {
  const updates: unknown[] = [];
  await applyRemoteNodeContentUpdate({
    store: {
      getScope: async () => ({ selectedRoots: [] }),
      stageBookmarkEvent: async () => undefined,
      getPullEvent: async () => null,
    } as never,
    scope: {} as never,
    api: { update: async (_id: string, changes: unknown) => { updates.push(changes); } } as never,
    mapping: { ...mapping, nodeKind: 'folder', projection: { ...mapping.projection, content: { title: 'Known' } } },
    node: { ...node, kind: 'folder', title: 'Remote folder', url: undefined },
    effectDigest: 'sha256:effect', eventId: 'event-folder', mounts: [], now: () => 1,
    lookup: async () => ({ class: 'present', nodes: [{ id: 'native-1', title: 'Known' }] }),
    targetMissingError: async () => new Error('missing'),
    queuedLocal: {},
  });
  assert.deepEqual(updates, [{ title: 'Remote folder' }]);
});

test('a failed native content barrier does not call the Chrome update API', async () => {
  const updates: unknown[] = [];
  await assert.rejects(() => applyRemoteNodeContentUpdate({
    store: {
      getScope: async () => ({ selectedRoots: [] }),
      stageBookmarkEvent: async () => { throw new Error('barrier_failed'); },
      getPullEvent: async () => null,
    } as never,
    scope: {} as never,
    api: { update: async (_id: string, changes: unknown) => { updates.push(changes); } } as never,
    mapping, node, effectDigest: 'sha256:effect', eventId: 'event-1', mounts: [], now: () => 1,
    lookup: async () => ({ class: 'present', nodes: [{ id: 'native-1', title: 'Live', url: 'https://live.example/' }] }),
    targetMissingError: async () => new Error('missing'),
    queuedLocal: {},
  }), /barrier_failed/);
  assert.deepEqual(updates, []);
});
