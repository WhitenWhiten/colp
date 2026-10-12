import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  applyRemoteNodeContentUpdate, unqueuedNativeContentFields,
} from '../src/pull-native-content-barrier.js';
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
