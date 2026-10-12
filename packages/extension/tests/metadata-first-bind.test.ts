import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createBookmarkAnnotationStore, annotationSyncProblem } from '../src/bookmark-annotation-store.js';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { reconcileBookmarkTags } from '../src/bookmark-tag-sync.js';
import { reconcileBookmarkNotes } from '../src/bookmark-note-sync.js';
import { reconcileFolderDescriptions } from '../src/folder-description-sync.js';
import { observeMetadata, type MetadataBinding } from '../src/local-metadata-state.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';

test('first binding unions local tags and protects populated cloud notes and descriptions', async () => {
  const factory = new IDBFactory(), f = await fixture(factory, { mappedNode: true });
  const annotations = createBookmarkAnnotationStore({ indexedDB: factory }), descriptions = createFolderDescriptionStore({ indexedDB: factory });
  const bookmark = { id: 'mapped', title: 'Page', url: 'https://example.test/', parentId: 'root-selected' };
  const folder = { id: 'folder-parent', title: 'Parent' };
  const input = { scope, sync: f.store, annotations, descriptions, tree: [bookmark, folder], queue: f.queue, allowed: () => true, assertCurrent: async () => undefined };
  try {
    f.api.put(bookmark);
    const mappings: [string, JsonObject, 'bookmark' | 'folder'][] = [[bookmark.id, { title: 'Page', url: bookmark.url, tags: ['cloud-a', 'cloud-b'] }, 'bookmark'],
      [folder.id, { title: 'Parent', description: 'Cloud description' }, 'folder']];
    for (const [id, content, kind] of mappings) {
      const { scopeKey: _key, ...mapping } = (await f.store.getMappingByNativeId(scope, id))!;
      await f.store.putMapping(scope, { ...mapping, nodeKind: kind, projection: { ...mapping.projection, content } });
    }
    await annotations.save(bookmark, { tags: ['mine'], note: 'Local note' }); await descriptions.save(folder, 'Local description');
    const note = { scopeKey: scopeKey(scope), resourceId: 'mapped-colp', revision: 'r1', value: 'Cloud note', annotationId: 'note', supported: true };
    let sends = 0;
    const client = { read: async () => note, send: async () => { sends++; return note; } };
    await reconcileBookmarkNotes({ ...input, clientFor: () => client });
    await reconcileBookmarkNotes({ ...input, clientFor: () => client });
    expect(sends).toBe(0); expect(annotationSyncProblem(await annotations.get(bookmark))).toBe('note-conflict');
    expect((await annotations.get(bookmark))?.note).toBe('Local note');
    expect((await reconcileBookmarkTags(input)).staged).toBe(1); await f.queue.flush();
    expect((await f.store.listQueue(scope))[0]!.payload).toMatchObject({ payload: { base: { tags: ['cloud-a', 'cloud-b'] }, value: { tags: ['cloud-a', 'cloud-b', 'mine'] } } });
    expect((await reconcileFolderDescriptions(input)).staged).toBe(0);
    expect((await reconcileFolderDescriptions(input)).staged).toBe(0);
    expect(await descriptions.get(folder)).toMatchObject({ description: 'Local description', reviewVersion: 1, remote: { description: 'Cloud description' } });
  } finally { annotations.close(); descriptions.close(); f.store.close(); }
});

test.each([[null, 'Cloud', 'Cloud', 'synced'], ['Local', null, 'Local', 'dirty'], ['Same', 'Same', 'Same', 'synced']] as const)(
  'first scalar binding safely handles local=%s and cloud=%s', (local, cloud, value, state) => {
    expect(observeMetadata<string | null, MetadataBinding<string | null>>({ value: local, version: 1, state: 'dirty' }, { scopeKey: 'scope', resourceId: 'node', revision: 'r1', value: cloud }, (a, b) => a === b))
      .toMatchObject({ value, state });
  });
