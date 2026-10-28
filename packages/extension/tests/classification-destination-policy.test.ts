import { expect, test } from 'vitest';
import { createClassificationDestinationPolicy } from '../src/classification-destination-policy.js';
import { nativeClassificationFolders } from '../src/classification-local-taxonomy.js';
import type { MountBinding } from '../src/site-adapters/contracts.js';
import type { FolderTreeNode } from '../src/save-folder.js';
test('ordinary cloud previews remain available without native permission when no source mount exists', async () => {
  const policy = createClassificationDestinationPolicy({ mounts: async () => [], tree: async () => { throw new Error('permission_required'); }, deviceId: async () => 'device' });
  expect((await policy.snapshot()).constrained).toBe(false); await expect(policy.assertCloudSupported()).resolves.toBeUndefined();
});
test('a proven deleted source root has no AI subtree; a reused native ID or foreign device still needs review', async () => {
  let tree: FolderTreeNode[] = [{ id: '1', title: 'Bar', children: [] }];
  const mount = { id: 'm', connectionId: 'c', rootRuleId: 'r', revision: 1, aiDestination: 'excluded' as const, state: 'suppressed' as const,
    root: { nativeId: 'deleted', dateAdded: 2, deviceId: 'device', bindingId: 'b', kind: 'folder' as const, proof: { kind: 'explicitAdoption' as const, id: 'p' } } };
  const policy = createClassificationDestinationPolicy({ mounts: async () => [mount], tree: async () => tree, deviceId: async () => 'device' });
  expect((await policy.snapshot()).constrained).toBe(false);
  tree = [{ id: '1', title: 'Bar', children: [{ id: 'deleted', title: 'Reused ID', dateAdded: 99 }] }];
  await expect(policy.snapshot()).rejects.toThrow('destination_policy_needs_rebind');
  tree = []; mount.root.deviceId = 'foreign';
  await expect(policy.snapshot()).rejects.toThrow('destination_policy_needs_rebind');
});
test('mount exclusion prunes examples and future descendants while preserving the parent and personal writes', async () => {
  const tree: FolderTreeNode[] = [{ id: '0', children: [{ id: '1', title: 'Bookmarks bar', children: [{ id: 'parent', title: 'Videos', dateAdded: 1,
    parentId: '1', children: [{ id: 'mount', title: 'Source', parentId: 'parent', dateAdded: 2, children: [{ id: 'later', title: 'Future', parentId: 'mount', dateAdded: 3,
      children: [{ id: 'secret', title: 'Source example', url: 'https://example.test/', parentId: 'later' }] }] }, { id: 'allowed', title: 'Semantic', parentId: 'parent', dateAdded: 4 }] }] }] }].map(n => ({ title: '', ...n }));
  let mounts: MountBinding[] = [{ id: 'm', connectionId: 'c', rootRuleId: 'r', revision: 1, aiDestination: 'excluded',
    root: { nativeId: 'mount', dateAdded: 2, deviceId: 'device', bindingId: 'b', kind: 'folder', proof: { kind: 'explicitAdoption', id: 'p' } } }];
  const policy = createClassificationDestinationPolicy({ tree: async () => tree, mounts: async () => mounts, deviceId: async () => 'device' });
  const first = await policy.snapshot();
  expect(nativeClassificationFolders(tree, { excluded: first.excluded }).map(n => n.id)).toEqual(['parent', 'allowed']);
  await expect(policy.assertAllowed('later')).rejects.toThrow('destination_policy_excluded');
  await expect(policy.assertAllowed('allowed', first.digest)).resolves.toBe(first.digest);
  await expect(policy.assertCloudSupported()).rejects.toThrow('cloud_destination_policy_unsupported');
  mounts = [{ ...mounts[0]!, revision: 2, aiDestination: 'allowed' }];
  await expect(policy.assertCurrent(first.digest)).rejects.toThrow('destination_policy_changed');
  await expect(policy.assertAllowed('later')).resolves.toBeTruthy();
  mounts = [{ ...mounts[0]!, root: { ...mounts[0]!.root, dateAdded: 999 }, aiDestination: 'excluded' }];
  await expect(policy.snapshot()).rejects.toThrow('destination_policy_needs_rebind');
});

test('new folders and derived receipts below an excluded root do not cancel independent classification', async () => {
  const source = { id: 'source', title: 'Source', dateAdded: 2, parentId: 'root', children: [] as FolderTreeNode[] };
  const semantic = { id: 'semantic', title: 'Semantic', dateAdded: 3, parentId: 'root' };
  const tree: FolderTreeNode[] = [{ id: 'root', title: 'Root', children: [source, semantic] }];
  const mount: MountBinding = { id: 'source-mount', connectionId: 'c', rootRuleId: 'r', revision: 1, aiDestination: 'excluded',
    root: { nativeId: 'source', dateAdded: 2, deviceId: 'device', bindingId: 'root', kind: 'folder', proof: { kind: 'explicitAdoption', id: 'root' } } };
  const mounts: MountBinding[] = [mount];
  const policy = createClassificationDestinationPolicy({ tree: async () => tree, mounts: async () => mounts, deviceId: async () => 'device' });
  const original = await policy.snapshot();
  source.children.push({ id: 'collection', title: 'New collection', dateAdded: 4, parentId: 'source' });
  mounts.push({ ...mount, id: 'derived-folder', root: { ...mount.root, nativeId: 'collection', dateAdded: 4 } });
  await expect(policy.assertAllowed('semantic', original.digest)).resolves.toBe(original.digest);
  await expect(policy.assertAllowed('collection')).rejects.toThrow('destination_policy_excluded');
  source.children[0] = { ...source.children[0]!, parentId: 'root' };
  await expect(policy.assertCurrent(original.digest)).rejects.toThrow('destination_policy_changed');
  await expect(policy.assertAllowed('collection')).rejects.toThrow('destination_policy_excluded');
});
