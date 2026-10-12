// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { loadAnnotation, saveAnnotation, setAnnotationStore } from '../src/popup-annotations.js';
let store: ReturnType<typeof createBookmarkAnnotationStore>;
const bookmark = { id: 'b', url: 'https://example.test/' };
const binding = (value: string, revision = 'r1') => ({ scopeKey: 'scope', resourceId: 'n', revision, value, annotationId: 'note', supported: true });
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); store = createBookmarkAnnotationStore(); setAnnotationStore(store); });
afterEach(() => { store.close(); setAnnotationStore(undefined); vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function choose(index: number) {
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  document.querySelectorAll<HTMLButtonElement>('dialog button')[index]!.click();
}

test('stale note edits show both versions, retain the draft, and preserve unseen tags', async () => {
  await store.save(bookmark, { tags: ['old'], note: 'Before' }); const base = await loadAnnotation(bookmark);
  await store.save(bookmark, { tags: ['old', 'concurrent'], note: 'Elsewhere' });
  const saved = saveAnnotation(bookmark, { tags: ['old', 'typed'], note: 'My draft' }, base);
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  expect(Array.from(document.querySelectorAll<HTMLTextAreaElement>('dialog textarea')).map(node => node.value)).toEqual(['My draft', 'Elsewhere']);
  await choose(2); expect(await saved).toBe(true);
  expect(await store.get(bookmark)).toMatchObject({ tags: ['concurrent', 'old', 'typed'], note: 'My draft' });
});
test('choosing the cloud note clears review without uploading an unchanged value', async () => {
  await store.save(bookmark, { tags: [], note: 'Draft' }); await store.observeNote(bookmark, binding('Cloud'));
  const base = await loadAnnotation(bookmark), saved = saveAnnotation(bookmark, base, base);
  await choose(1); expect(await saved).toBe(true);
  expect(await store.get(bookmark)).toMatchObject({ note: 'Cloud', noteSync: { state: 'synced' } });
  expect((await loadAnnotation(bookmark)).syncProblem).toBeUndefined();
});
test('a newer cloud version during review refuses the old choice and keeps the draft', async () => {
  await store.save(bookmark, { tags: [], note: 'Draft' }); await store.observeNote(bookmark, binding('Cloud'));
  const base = await loadAnnotation(bookmark), saved = saveAnnotation(bookmark, base, base);
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  await store.observeNote(bookmark, binding('New cloud', 'r2'));
  await choose(2); expect(await saved).toBe(false); expect((await store.get(bookmark))?.note).toBe('Draft');
  const retry = saveAnnotation(bookmark, base, base); await choose(1); expect(await retry).toBe(true);
  expect((await store.get(bookmark))?.note).toBe('New cloud');
});
test('cancelling review leaves the stored note and draft unchanged', async () => {
  await store.save(bookmark, { tags: [], note: 'Before' }); const base = await loadAnnotation(bookmark);
  await store.save(bookmark, { tags: [], note: 'Elsewhere' });
  const draft = { tags: [], note: '<script>My draft</script>' }, saved = saveAnnotation(bookmark, draft, base);
  await choose(0); expect(await saved).toBeNull(); expect(draft.note).toBe('<script>My draft</script>');
  expect((await store.get(bookmark))?.note).toBe('Elsewhere'); expect(document.querySelector('script')).toBeNull();
});
test('folder review also rejects a choice against a replaced cloud baseline', async () => {
  const descriptions = createFolderDescriptionStore(), folder = { id: 'f' };
  try {
    await descriptions.save(folder, 'Draft');
    const cloud = { scopeKey: 'scope', colpId: 'f', revision: 'r1', description: 'Cloud' };
    await descriptions.observeRemote([{ folder, binding: cloud }]);
    const base = (await descriptions.get(folder))!;
    await descriptions.observeRemote([{ folder, binding: { ...cloud, revision: 'r2', description: 'New cloud' } }]);
    await expect(descriptions.save(folder, 'Draft', base.version, 'r1')).rejects.toThrow('folder_description_changed');
    expect((await descriptions.get(folder))?.description).toBe('Draft');
  } finally { descriptions.close(); }
});
