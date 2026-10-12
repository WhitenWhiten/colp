import { expect, test } from 'vitest';
import { createMetadataBoundary, assertMetadataTarget } from '../src/metadata-boundary.js';
import type { FolderTreeNode } from '../src/save-folder.js';
const boundary = { selectedNative: new Set(['selected']), privateNative: new Set(['private', 'subscription']), rootStatus: 'ready' as const };
const tree: FolderTreeNode[] = [{ id: '0', title: '', children: [{ id: 'selected', title: 'Mine', children: [
  { id: 'folder', title: 'Folder', children: [{ id: 'bookmark', title: 'Page', url: 'https://a.test/' }] },
  { id: 'private', title: 'Private', children: [{ id: 'secret', title: 'Secret', url: 'https://b.test/' }] },
  { id: 'subscription', title: 'Subscription', children: [{ id: 'sub-note', title: 'Read-only', url: 'https://c.test/' }] },
  { id: 'managed', title: 'Managed', unmodifiable: 'managed', children: [{ id: 'managed-child', title: 'Managed child', url: 'https://d.test/' }] },
] }, { id: 'detached', title: 'Other', children: [{ id: 'outside', title: 'Outside', url: 'https://e.test/' }] }] }];
test('folder descriptions, tags and notes share selected range, private ancestry and subscription/managed exclusions', () => {
  const { allowed } = createMetadataBoundary(tree, boundary);
  expect(allowed({ nativeId: 'folder' })).toBe(true); expect(allowed({ nativeId: 'bookmark' })).toBe(true);
  for (const nativeId of ['secret', 'private', 'subscription', 'sub-note', 'managed', 'managed-child', 'outside', 'missing']) {
    expect(allowed({ nativeId })).toBe(false);
  }
});
test('unready roots, missing parents and cyclic ancestry never authorize metadata', () => {
  expect(createMetadataBoundary(tree, { ...boundary, rootStatus: 'corrupt' }).allowed({ nativeId: 'bookmark' })).toBe(false);
  const malformed = [{ id: 'selected', title: 'Bad', parentId: 'missing' }];
  expect(createMetadataBoundary(malformed, boundary).allowed({ nativeId: 'selected' })).toBe(false);
  expect(createMetadataBoundary([{ id: 'selected', title: 'Cycle', parentId: 'selected' }], boundary).allowed({ nativeId: 'selected' })).toBe(false);
  expect(() => createMetadataBoundary([tree[0]!, tree[0]!], boundary)).toThrow('metadata_tree_invalid');
});

test('dispatch guards refuse a remapped id, reused native id, changed URL or newly private ancestry', async () => {
  const { nodes } = createMetadataBoundary(tree, boundary), expected = nodes.get('bookmark')!;
  const target = { nativeId: expected.id, colpId: 'cloud-original' };
  const deps = { assertCurrent: async () => undefined, mapping: async () => ({ colpId: target.colpId }),
    boundary: async () => boundary, node: async (id: string) => nodes.get(id) };
  await expect(assertMetadataTarget(target, expected, deps)).resolves.toBeUndefined();
  await expect(assertMetadataTarget(target, expected, { ...deps, mapping: async () => ({ colpId: 'remapped' }) }))
    .rejects.toThrow('metadata_mapping_changed');
  for (const changed of [{ ...expected, dateAdded: 99 }, { ...expected, url: 'https://different.test/' }]) {
    await expect(assertMetadataTarget(target, expected, { ...deps, node: async id => id === expected.id ? changed : nodes.get(id) }))
      .rejects.toThrow('metadata_boundary_changed');
  }
  await expect(assertMetadataTarget(target, expected, { ...deps,
    boundary: async () => ({ ...boundary, privateNative: new Set(['folder']) }) })).rejects.toThrow('metadata_boundary_changed');
});
