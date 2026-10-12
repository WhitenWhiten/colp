import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { validMetadataReassociationCommand } from '../src/metadata-reassociation-commands.js';
import type { LocalBackup } from '../src/local-backup/codec.js';

const f = vi.hoisted(() => ({ owner: 'guest', excluded: new Set<string>() }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true,
  workCoordinator: { run: async (_lane: string, work: () => Promise<unknown>) => work() } }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => ({ serverOrigin: 'https://known.test', accountId: f.owner,
  collectionId: null, authorityGeneration: 1 }), assertCaptureOwner: async (owner: { accountId: string }) => {
  if (owner.accountId !== f.owner) throw new Error('capture_scope_changed');
} }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => f.excluded,
  assertPersonalNativeAllowed: async (id: string) => { if (f.excluded.has(id)) throw new Error('excluded'); } }));
import { handleMetadataReassociation } from '../src/sw/metadata-reassociation.js';

afterEach(() => { vi.unstubAllGlobals(); f.excluded.clear(); f.owner = 'guest'; });
async function setup() {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const bookmark = { id: 'new-bookmark', parentId: 'new-folder', title: 'A', url: 'https://example.test/a', dateAdded: 3 };
  const folder = { id: 'new-folder', parentId: 'new-bar', title: 'Read', dateAdded: 2, children: [bookmark] };
  const bar = { id: 'new-bar', parentId: '0', title: 'Bar', folderType: 'bookmarks-bar', dateAdded: 1, children: [folder] };
  const nodes = [bar, folder, bookmark];
  vi.stubGlobal('chrome', { bookmarks: { getTree: async () => [{ id: '0', title: 'Bookmarks', children: [bar] }],
    get: async (id: string) => nodes.filter(node => node.id === id) },
    runtime: { sendMessage: async () => undefined } });
  const backup: LocalBackup = { format: 'known-browser-backup', version: 1, exportedAt: 10,
    nodes: [{ sourceId: 'old-bar', parentIndex: null, title: 'Bar' },
      { sourceId: 'old-folder', parentIndex: 0, title: 'Read', description: 'Description' },
      { sourceId: 'old-bookmark', parentIndex: 1, title: 'A', url: bookmark.url, tags: ['imported'], note: 'Backup note' }],
    history: [], preferences: {}, language: 'en', defaultFolderSourceId: null, aiConfig: null };
  const preview = async () => {
    const result = await handleMetadataReassociation({ kind: 'known.metadataRestore.preview', base64: btoa(JSON.stringify(backup)) });
    expect('token' in result).toBe(true); return result as { token: string; matches: number };
  };
  return { bookmark, folder, preview };
}
test('changed extension/native identities restore sidecars to existing bookmarks without creating nodes', async () => {
  const f = await setup(), plan = await f.preview(); expect(plan.matches).toBe(2);
  expect(await handleMetadataReassociation({ kind: 'known.metadataRestore.confirm', token: plan.token, userGesture: true })).toMatchObject({ ok: true, restored: 2 });
  const annotations = createBookmarkAnnotationStore(), descriptions = createFolderDescriptionStore();
  try {
    expect(await annotations.get(f.bookmark)).toMatchObject({ tags: ['imported'], note: 'Backup note' });
    expect(await descriptions.get(f.folder)).toMatchObject({ description: 'Description' });
  } finally { annotations.close(); descriptions.close(); }
  await expect(handleMetadataReassociation({ kind: 'known.metadataRestore.confirm', token: plan.token, userGesture: true })).rejects.toThrow('metadata_preview_stale');
});
test('native edits and account switches invalidate a preview before any metadata writes', async () => {
  for (const cause of ['native', 'account']) {
    const fixture = await setup(), plan = await fixture.preview();
    if (cause === 'native') fixture.bookmark.title = 'Changed'; else f.owner = 'other';
    await expect(handleMetadataReassociation({ kind: 'known.metadataRestore.confirm', token: plan.token, userGesture: true })).rejects.toThrow(/metadata_preview_stale|capture_scope_changed/);
    const annotations = createBookmarkAnnotationStore();
    try { expect(await annotations.get(fixture.bookmark)).toBeNull(); } finally { annotations.close(); }
  }
});
test('existing notes and tags survive repeated restore; subscription ancestors exclude their descendants', async () => {
  const fixture = await setup(), annotations = createBookmarkAnnotationStore();
  try {
    await annotations.save(fixture.bookmark, { tags: ['mine'], note: 'My draft' });
    for (let i = 0; i < 2; i++) {
      const plan = await fixture.preview();
      expect(await handleMetadataReassociation({ kind: 'known.metadataRestore.confirm', token: plan.token, userGesture: true })).toMatchObject({ conflicts: 1 });
    }
    expect(await annotations.get(fixture.bookmark)).toMatchObject({ tags: expect.arrayContaining(['mine', 'imported']), note: 'My draft' });
    expect((await annotations.get(fixture.bookmark))!.tags).toHaveLength(2);
    f.excluded.add('new-folder'); expect((await fixture.preview()).matches).toBe(0);
  } finally { annotations.close(); }
});
test('restore commands reject supplied identity, unknown keys and missing gestures', () => {
  expect(validMetadataReassociationCommand({ kind: 'known.metadataRestore.preview', base64: 'e30=' })).toBe(true);
  for (const command of [{ kind: 'known.metadataRestore.preview', base64: 'e30=', accountId: 'other' },
    { kind: 'known.metadataRestore.confirm', token: crypto.randomUUID(), userGesture: false },
    { kind: 'known.metadataRestore.confirm', token: crypto.randomUUID(), userGesture: true, nativeId: 'untrusted' }]) {
    expect(validMetadataReassociationCommand(command)).toBe(false);
  }
});
