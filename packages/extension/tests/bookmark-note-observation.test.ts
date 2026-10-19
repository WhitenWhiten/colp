import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import type { NoteBinding } from '../src/bookmark-annotation-sync-types.js';

/**
 * Note confirmation is the observed echo of the attempted value (and the
 * response of the command itself), not a node-content queue receipt. Single
 * and batch observation must therefore treat the same transition identically:
 * a confirmed attempt clears dirty without losing a newer local draft.
 */
const scope = 'note-scope';
const binding = (value: string | null, revision = 'note-r1', annotationId: string | null = 'note-a'): NoteBinding =>
  ({ scopeKey: scope, resourceId: 'node-a', revision, annotationId, value, supported: true });
const bookmark = (id: string) => ({ id, url: `https://example.test/${id}` });

async function prepare(store: ReturnType<typeof createBookmarkAnnotationStore>, target: ReturnType<typeof bookmark>) {
  await store.observeNote(target, binding(null, 'absent', null));
  await store.save(target, { tags: [], note: 'Sent' });
  await store.prepareNote(target, scope, 'node-a');
  await store.save(target, { tags: [], note: 'Newer' });
}

test('single and batch note observation confirm an echoed draft identically', async () => {
  const store = createBookmarkAnnotationStore({ indexedDB: new IDBFactory() });
  try {
    const single = bookmark('single'), batch = bookmark('batch');
    for (const target of [single, batch]) {
      await store.observeNote(target, binding(null, 'absent', null));
      await store.save(target, { tags: [], note: 'Draft' });
      await store.prepareNote(target, scope, 'node-a');
    }
    await store.observeNote(single, binding('Draft', 'note-r2'));
    await store.observeNotesMany([{ bookmark: batch, binding: binding('Draft', 'note-r2') }]);
    const [one, many] = [await store.get(single), await store.get(batch)];
    expect([one?.note, many?.note]).toEqual(['Draft', 'Draft']);
    expect(many?.noteSync).toEqual(one?.noteSync);
    for (const row of [one, many]) expect(row?.noteSync).toMatchObject({ value: 'Draft', state: 'synced', remote: { revision: 'note-r2' } });
  } finally { store.close(); }
});

test('an older confirmation advances the base without overwriting a newer local draft, in both paths', async () => {
  const store = createBookmarkAnnotationStore({ indexedDB: new IDBFactory() });
  try {
    const single = bookmark('single'), batch = bookmark('batch');
    for (const target of [single, batch]) await prepare(store, target);
    await store.observeNote(single, binding('Sent', 'note-r2'));
    await store.observeNotesMany([{ bookmark: batch, binding: binding('Sent', 'note-r2') }]);
    for (const target of [single, batch]) {
      const row = (await store.get(target))!;
      expect(row.note).toBe('Newer');
      expect(row.noteSync).toMatchObject({ value: 'Newer', state: 'dirty', remote: { revision: 'note-r2' } });
      expect(row.noteSync?.attempt).toBeUndefined();
      // Replaying the settled intent against the confirmed revision still keeps the newer draft.
      await store.finishNote(target, row.noteIntent!, { kind: 'applied', binding: binding('Sent', 'note-r2') });
      expect((await store.get(target))?.note).toBe('Newer');
    }
    expect((await store.prepareNote(single, scope, 'node-a'))?.noteIntent).toMatchObject({ value: 'Newer', revision: 'note-r2' });
  } finally { store.close(); }
});

test('a cloud note that does not echo the attempt keeps the newer draft and its old base in both paths', async () => {
  const store = createBookmarkAnnotationStore({ indexedDB: new IDBFactory() });
  try {
    const single = bookmark('single'), batch = bookmark('batch');
    for (const target of [single, batch]) await prepare(store, target);
    await store.observeNote(single, binding('Other', 'note-r9'));
    await store.observeNotesMany([{ bookmark: batch, binding: binding('Other', 'note-r9') }]);
    for (const target of [single, batch]) {
      const row = (await store.get(target))!;
      expect(row.note).toBe('Newer');
      expect(row.noteSync).toMatchObject({ value: 'Newer', state: 'dirty', remote: { revision: 'absent' } });
    }
  } finally { store.close(); }
});
