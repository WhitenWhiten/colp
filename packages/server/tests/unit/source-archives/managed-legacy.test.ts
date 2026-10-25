import { expect, test, vi } from 'vitest';
import { adoptLegacyManagedCopy, managedSlotKey, saveManagedCopy, sourceConnectionKey, type ManagedSaveCommand, type ManagedSaveState } from '../../../src/modules/source-archives/index.js';
const source = { site: 'fixture.posts', identityVersion: 1, sourceAccount: 'reader', sourceCollectionId: 'saved' };
const command: ManagedSaveCommand = { commandId: 'new-command', replicaId: 'new-device', collectionId: 'library', parentId: 'root', parentRevision: 'r1', title: 'Renamed source', url: null,
  slot: { kind: 'folder', source } };
const node = { nodeId: 'old-folder', parentId: 'root', title: 'Original title', url: null, revision: 'r2' };
test('a legacy immutable association is reused with its original title without a canonical create', async () => {
  const state: ManagedSaveState = { bindings: {}, receipts: {} }, legacy = { folders: { [JSON.stringify([sourceConnectionKey(source), 'library', 'root', 'saved'])]: node }, copies: {} };
  adoptLegacyManagedCopy(state, legacy, command);
  const create = vi.fn(async () => node);
  expect(await saveManagedCopy(state, command, { assertTarget: async () => {}, read: async () => node, create })).toMatchObject({ disposition: 'reused', node });
  expect(create).not.toHaveBeenCalled(); expect(state.bindings[managedSlotKey('library', command.slot)]?.node.nodeId).toBe('old-folder');
});
test('competing old roots and changed roots require review instead of guessing from names or URLs', () => {
  const connection = sourceConnectionKey(source), first = JSON.stringify([connection, 'library', 'root', 'saved']), second = JSON.stringify([connection, 'library', 'another-root', 'saved']);
  const state: ManagedSaveState = { bindings: {}, receipts: {} };
  expect(() => adoptLegacyManagedCopy(state, { folders: { [first]: node, [second]: { ...node, nodeId: 'other-folder' } }, copies: {} }, command)).toThrow('source_legacy_association_review_required');
  expect(() => adoptLegacyManagedCopy(state, { folders: { [first]: node }, copies: {} }, { ...command, parentId: 'changed-root' })).toThrow('source_mapping_migration_required');
  expect(state.bindings).toEqual({});
});
