import { test, expect } from 'vitest';
import { loadClassificationContext } from '../../../src/modules/collections/application/classification-context.js';
import { persistedClassificationContext } from '../../../src/modules/collections/application/classification-execution.js';
import { DEFAULT_CLASSIFICATION_SETTINGS } from '../../../src/modules/collections/application/classification-settings.js';
import { canonicalJson } from '../../../src/modules/commands/application/receipt.js';

const chain = (depth: number, title: string) => Array.from({ length: depth }, (_, index) => ({
  id: `f-${index}`, parentId: index === 0 ? null : `f-${index - 1}`, title, description: null,
}));

async function context(folders: ReturnType<typeof chain>, rejectedFolderIds?: readonly string[], folderSelectionMode?: 'require_candidate') {
  return (await loadClassificationContext({
    ownerSubjectId: 'subject', collectionId: 'collection',
    preview: { source: 'web', requested: { folder: true, tags: false },
      bookmark: { title: 'probe', url: 'https://example.org/x', description: null }, ...rejectedFolderIds ? { rejectedFolderIds } : {},
      ...(folderSelectionMode ? { folderSelectionMode } : {}) },
    tagsEnabled: false,
  }, {
    loadSnapshot: async () => ({
      collectionId: 'collection', title: 'c', summary: null, contentRevision: 'rev-1',
      settings: { contractVersion: '1.0.0', collectionId: 'collection', revision: '1', updatedAt: new Date(0).toISOString(), ...DEFAULT_CLASSIFICATION_SETTINGS },
      folders, tagUsage: [], node: null,
    }),
  }))!;
}

test('persisted execution context drops the expanded candidate allowlist', async () => {
  const built = await context(chain(40, 't'.repeat(512)));
  expect(built.candidates).not.toBeNull();
  const persisted = persistedClassificationContext(built);
  expect(persisted.candidates).toBeNull();
  expect(persisted.snapshot.folders).toHaveLength(40);
  const serialized = canonicalJson(persisted);
  expect(serialized).not.toContain('"path"');
  // The expanded allowlist still reaches the provider through the live context.
  expect(canonicalJson(built)).toContain('"path"');
  expect(serialized.length).toBeLessThan(canonicalJson(built).length / 4);
});

test('turned-down folders persist with the context so the executor rebuilds the same candidates', async () => {
  const folders = [{ id: 'a', parentId: null, title: 'A', description: null }, { id: 'b', parentId: null, title: 'B', description: null }];
  const built = await context(folders, ['a']);
  expect(built.candidates!.l1.map(folder => folder.id)).toEqual(['b']);
  expect(persistedClassificationContext(built).rejectedFolderIds).toEqual(['a']);
  expect(canonicalJson(persistedClassificationContext(await context(folders)))).not.toContain('rejectedFolderIds');
});

test('explicit folder selection survives execution persistence and changes its body identity', async () => {
  const folders = chain(1, 'A');
  const forced = await context(folders, undefined, 'require_candidate');
  expect(persistedClassificationContext(forced).folderSelectionMode).toBe('require_candidate');
  expect(canonicalJson(persistedClassificationContext(forced))).not.toBe(canonicalJson(persistedClassificationContext(await context(folders))));
});
