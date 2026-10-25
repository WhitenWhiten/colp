import { expect, test, vi } from 'vitest';
import { reconcileManagedCopy, undoManagedReconcile, parseManagedReconcile, managedSlotKey, markManagedChange, type ManagedReconcileCommand, type ManagedNode, type ManagedSaveState } from '../../../src/modules/source-archives/index.js';
const node: ManagedNode = { nodeId: 'node', parentId: 'folder', title: 'Original', url: 'https://posts.test/one', revision: 'r1' };
const command: ManagedReconcileCommand = { commandId: 'reconcile-1', collectionId: 'library', replicaId: 'replica', action: 'move', expected: node,
  slot: { kind: 'bookmark', copy: { purpose: 'sourceArchive', sourceAccount: 'reader', sourceCollectionId: 'saved', content: { site: 'fixture.posts', identityVersion: 1, itemId: 'post', accountId: null } } },
  parentId: 'history', title: 'Original', retire: true };
function fixture() {
  let current = { ...node }; const state: ManagedSaveState = { bindings: {}, receipts: {} };
  state.bindings[managedSlotKey('library', command.slot!)] = { collectionId: 'library', slot: command.slot!, node, state: 'active' };
  const mutate = vi.fn(async (c: ManagedReconcileCommand, deleted = false) => { current = { ...current, parentId: c.parentId, title: c.title, revision: `${current.revision}-next`, deleted }; return current; });
  return { state, ports: { read: async () => current, mutate }, edit: () => { current = { ...current, title: 'My title', revision: 'manual' }; } };
}
test('a shared reconciliation operation preserves identity and repeated dispatch returns its original receipt', async () => {
  const f = fixture(), receipt = await reconcileManagedCopy(f.state, command, f.ports);
  expect(receipt).toMatchObject({ before: node, after: { nodeId: 'node', parentId: 'history' } });
  expect(await reconcileManagedCopy(f.state, command, f.ports)).toEqual(receipt); expect(f.ports.mutate).toHaveBeenCalledOnce();
  await expect(reconcileManagedCopy(f.state, { ...command, title: 'different' }, f.ports)).rejects.toThrow('source_command_reused');
});
test('another role sharing a physical bookmark blocks source cleanup', async () => {
  const f = fixture(), slot = { kind: 'bookmark' as const, copy: { purpose: 'semantic' as const, content: { site: 'fixture.posts', identityVersion: 1, itemId: 'post', accountId: null } } };
  f.state.bindings[managedSlotKey('library', slot)] = { collectionId: 'library', slot, node, state: 'active' };
  await expect(reconcileManagedCopy(f.state, command, f.ports)).rejects.toThrow('source_copy_protected'); expect(f.ports.mutate).not.toHaveBeenCalled();
});
test('a user edit after preview blocks only the affected operation', async () => {
  const f = fixture(); f.edit(); await expect(reconcileManagedCopy(f.state, command, f.ports)).rejects.toThrow('source_reconcile_conflict');
  expect(f.ports.mutate).not.toHaveBeenCalled();
});
test('undo is receipted and never overwrites a later user edit', async () => {
  const f = fixture(); await reconcileManagedCopy(f.state, command, f.ports);
  const undo = { commandId: 'undo-1', collectionId: 'library', replicaId: 'replica', original: command.commandId };
  expect(await undoManagedReconcile(f.state, undo, f.ports)).toMatchObject({ after: { parentId: 'folder', title: 'Original' } });
  await undoManagedReconcile(f.state, undo, f.ports); expect(f.ports.mutate).toHaveBeenCalledTimes(2);
  const g = fixture(); await reconcileManagedCopy(g.state, command, g.ports); g.edit();
  await expect(undoManagedReconcile(g.state, undo, g.ports)).rejects.toThrow('source_reconcile_conflict'); expect(g.ports.mutate).toHaveBeenCalledOnce();
});
test('malformed commands never become persistent receipt keys', () => {
  expect(parseManagedReconcile(command)).toEqual(command);
  expect(parseManagedReconcile({ ...command, title: '', expected: { ...node, title: '' } })).toMatchObject({ title: '', expected: { title: '' } });
  expect(() => parseManagedReconcile({ ...command, commandId: '__proto__' })).toThrow('invalid_managed_command');
});
test('undoing a metadata restoration preserves the physical node needed by another role', async () => {
  const f = fixture(), semantic = { kind: 'bookmark' as const, copy: { purpose: 'semantic' as const, content: { site: 'fixture.posts', identityVersion: 1, itemId: 'post', accountId: null } } };
  f.state.bindings[managedSlotKey('library', command.slot!)]!.state = 'suppressed';
  f.state.bindings[managedSlotKey('library', semantic)] = { collectionId: 'library', slot: semantic, node, state: 'active' };
  await reconcileManagedCopy(f.state, { ...command, action: 'restore', parentId: node.parentId, retire: false }, f.ports);
  expect(await undoManagedReconcile(f.state, { commandId: 'undo-shared', collectionId: 'library', replicaId: 'replica', original: command.commandId }, f.ports))
    .toMatchObject({ after: node, keepPhysical: true });
  expect(f.ports.mutate).not.toHaveBeenCalled();
  expect(f.state.bindings[managedSlotKey('library', semantic)]?.state).toBe('active');
});
test('a late offline deletion cannot override a newer explicit restoration', async () => {
  const f = fixture(), key = managedSlotKey('library', command.slot!);
  markManagedChange(f.state, 'library', command.slot!, node.nodeId, 'suppressed');
  await reconcileManagedCopy(f.state, { ...command, action: 'restore', parentId: node.parentId, retire: false }, f.ports);
  expect(f.state.bindings[key]).toMatchObject({ state: 'active', controlRevision: 1 });
  expect(() => markManagedChange(f.state, 'library', command.slot!, node.nodeId, 'suppressed', 0)).toThrow('source_association_changed');
  expect(f.state.bindings[key]?.state).toBe('active'); expect(f.ports.mutate).not.toHaveBeenCalled();
  markManagedChange(f.state, 'library', command.slot!, node.nodeId, 'suppressed', 1);
  await expect(undoManagedReconcile(f.state, { commandId: 'undo-late', collectionId: 'library', replicaId: 'replica', original: command.commandId }, f.ports)).rejects.toThrow('source_association_changed');
});
test.each(['forward', 'undo'] as const)('%s protects new canonical descendants even when their cached association location is stale', async direction => {
  const folder = { ...node, url: null };
  let current = folder;
  const state: ManagedSaveState = { bindings: {}, receipts: {} };
  const nodes = new Map<string, ManagedNode>();
  const ports = {
    read: async (_collection: string, id: string) => id === folder.nodeId ? current : nodes.get(id) ?? null,
    mutate: vi.fn(async (c: ManagedReconcileCommand) => (current = { ...current, parentId: c.parentId, revision: `${current.revision}-next` })),
  };
  const move = { ...command, expected: folder, slot: null, retire: false };
  if (direction === 'undo') await reconcileManagedCopy(state, move, ports);
  const child = { ...node, nodeId: 'semantic-child', parentId: 'old-location' };
  const semantic = { kind: 'bookmark' as const, copy: { purpose: 'semantic' as const, content: { site: 'fixture.posts', identityVersion: 1, itemId: 'post', accountId: null } } };
  state.bindings[managedSlotKey('library', semantic)] = { collectionId: 'library', slot: semantic, node: child, state: 'active' };
  nodes.set(child.nodeId, { ...child, parentId: 'nested' });
  nodes.set('nested', { ...folder, nodeId: 'nested', parentId: folder.nodeId });
  const action = direction === 'undo'
    ? undoManagedReconcile(state, { commandId: 'undo-folder', collectionId: 'library', replicaId: 'replica', original: move.commandId }, ports)
    : reconcileManagedCopy(state, move, ports);
  await expect(action).rejects.toThrow('source_copy_protected');
  expect(ports.mutate).toHaveBeenCalledTimes(direction === 'undo' ? 1 : 0);
});
