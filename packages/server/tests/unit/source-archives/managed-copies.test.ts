import { expect, test, vi } from 'vitest';
import { parseManagedSave, saveManagedCopy, recoverManagedCopy, managedSlotKey, sourceHash, claimManagedSemantic, releaseManagedSemantic, observeManagedCopy,
  type ManagedSaveCommand, type ManagedSaveState, type ManagedNode } from '../../../src/modules/source-archives/index.js';
const command = (id = 'command-1'): ManagedSaveCommand => ({ commandId: id, replicaId: 'device-a', collectionId: 'library', parentId: 'folder', parentRevision: 'r1',
  slot: { kind: 'bookmark', copy: { content: { site: 'fixture.posts', identityVersion: 1, itemId: 'post:one', accountId: null }, purpose: 'sourceArchive', sourceAccount: 'reader', sourceCollectionId: 'saved' } },
  title: 'One', url: 'https://posts.test/one' });
function fixture() {
  const state: ManagedSaveState = { bindings: {}, receipts: {} }, nodes = new Map<string, ManagedNode>();
  const ports = { assertTarget: vi.fn(async () => {}), read: async (_collection: string, id: string) => nodes.get(id) ?? null,
    create: vi.fn(async (c: ManagedSaveCommand) => { const node = { nodeId: `node-${nodes.size}`, parentId: c.parentId, title: c.title, url: c.url, revision: 'r2' }; nodes.set(node.nodeId, node); return node; }) };
  return { state, nodes, ports };
}
test('another replica reuses the same source copy and an immutable receipt recovers a lost reply', async () => {
  const f = fixture(), a = command(), first = await saveManagedCopy(f.state, a, f.ports);
  const second = await saveManagedCopy(f.state, { ...command('command-2'), replicaId: 'device-b' }, f.ports);
  expect(first.disposition).toBe('created'); expect(second.disposition).toBe('reused');
  expect(second.node.nodeId).toBe(first.node.nodeId); expect(f.ports.create).toHaveBeenCalledTimes(1);
  expect(recoverManagedCopy(f.state, a.commandId, sourceHash(a))).toEqual(first);
  await expect(saveManagedCopy(f.state, { ...a, title: 'Changed payload' }, f.ports)).rejects.toThrow('source_command_reused');
});
test('source collections remain separate and semantic content is shared across source accounts', async () => {
  const f = fixture(), a = command();
  if (a.slot.kind !== 'bookmark' || a.slot.copy.purpose !== 'sourceArchive') throw new Error('fixture');
  await saveManagedCopy(f.state, a, f.ports);
  await saveManagedCopy(f.state, { ...command('two'), slot: { kind: 'bookmark', copy: { ...a.slot.copy, sourceCollectionId: 'another' } } }, f.ports);
  const semantic = { ...command('semantic'), slot: { kind: 'bookmark' as const, copy: { content: a.slot.copy.content, purpose: 'semantic' as const } } };
  const reservation = claimManagedSemantic(f.state, 'library', semantic.slot.copy, 'semantic');
  if (reservation.status !== 'claimed') throw new Error('fixture');
  const first = await saveManagedCopy(f.state, { ...semantic, semanticClaim: { ownerId: 'semantic', revision: reservation.claim.revision } }, f.ports);
  const replay = await saveManagedCopy(f.state, { ...semantic, parentId: 'other-semantic-choice', commandId: 'semantic-device-b', replicaId: 'device-b' }, f.ports);
  expect(f.ports.create).toHaveBeenCalledTimes(3); expect(replay.node.nodeId).toBe(first.node.nodeId);
});
test('semantic processing has one owner across devices and explicit retry fences a late old result', async () => {
  const f = fixture(), c = command(); if (c.slot.kind !== 'bookmark') throw new Error('fixture');
  const copy = { content: c.slot.copy.content, purpose: 'semantic' as const };
  const first = claimManagedSemantic(f.state, 'library', copy, 'device-a-job');
  expect(first.status).toBe('claimed');
  expect(claimManagedSemantic(f.state, 'library', copy, 'device-b-job')).toEqual({ status: 'waiting' });
  if (first.status !== 'claimed') throw new Error('fixture');
  releaseManagedSemantic(f.state, 'library', copy, first.claim);
  const next = claimManagedSemantic(f.state, 'library', copy, 'device-b-job');
  if (next.status !== 'claimed') throw new Error('fixture');
  await expect(saveManagedCopy(f.state, { ...c, slot: { kind: 'bookmark', copy }, semanticClaim: { ownerId: 'device-a-job', revision: first.claim.revision } }, f.ports)).rejects.toThrow('source_semantic_claim_changed');
  const saved = await saveManagedCopy(f.state, { ...command('new'), slot: { kind: 'bookmark', copy }, semanticClaim: { ownerId: 'device-b-job', revision: next.claim.revision } }, f.ports);
  expect(saved.disposition).toBe('created'); expect(f.ports.create).toHaveBeenCalledTimes(1);
  expect(claimManagedSemantic(f.state, 'library', copy, 'another-device').status).toBe('saved');
});
test('proven legacy nodes can be adopted without a create and a competing association requires review', async () => {
  const f = fixture(), c = command();
  f.nodes.set('legacy', { nodeId: 'legacy', parentId: c.parentId, title: c.title, url: c.url, revision: 'old-revision' });
  const adopted = await saveManagedCopy(f.state, { ...c, adopt: { nodeId: 'legacy', revision: 'old-revision' } }, f.ports);
  expect(adopted).toMatchObject({ disposition: 'reused', node: { nodeId: 'legacy' } });
  expect(f.ports.create).not.toHaveBeenCalled();
  await expect(saveManagedCopy(f.state, { ...command('conflict'), adopt: { nodeId: 'different-copy', revision: 'old-revision' } }, f.ports)).rejects.toThrow('source_copy_adoption_conflict');
});
test('shared lookup propagates user deletion and never treats an unreadable node as absent', async () => {
  const f = fixture(), c = command(), saved = await saveManagedCopy(f.state, c, f.ports);
  await expect(observeManagedCopy(f.state, c.collectionId, c.slot, { read: async () => { throw new Error('unavailable'); } })).rejects.toThrow('unavailable');
  expect(f.state.bindings[saved.key]?.state).toBe('active');
  f.nodes.delete(saved.node.nodeId);
  expect(await observeManagedCopy(f.state, c.collectionId, c.slot, f.ports)).toMatchObject({ state: 'suppressed' });
  expect(f.ports.create).toHaveBeenCalledTimes(1);
});
test.each(['deleted', 'moved', 'renamed'] as const)('user changes (%s) never create a replacement or overwrite the edited node', async change => {
  const f = fixture(), first = await saveManagedCopy(f.state, command(), f.ports);
  if (change === 'deleted') f.nodes.delete(first.node.nodeId);
  else f.nodes.set(first.node.nodeId, { ...first.node, ...(change === 'moved' ? { parentId: 'manual-folder' } : { title: 'My title' }) });
  const result = await saveManagedCopy(f.state, command('second-device'), f.ports);
  expect(result.disposition).toBe(change === 'deleted' ? 'suppressed' : 'detached');
  expect(f.ports.create).toHaveBeenCalledTimes(1);
  expect(f.state.bindings[managedSlotKey('library', command().slot)]?.state).toBe(result.disposition);
});
test('changing mapping roots stops for migration and source renaming does not create a new identity', async () => {
  const f = fixture(); await saveManagedCopy(f.state, command(), f.ports);
  const renamed = await saveManagedCopy(f.state, { ...command('renamed'), title: 'New source title' }, f.ports);
  expect(renamed.node.title).toBe('One'); expect(renamed.disposition).toBe('reused');
  await expect(saveManagedCopy(f.state, { ...command('new-root'), parentId: 'other-folder' }, f.ports)).rejects.toThrow('source_mapping_migration_required');
  expect(f.ports.create).toHaveBeenCalledTimes(1);
});
test('failed creation leaves no saved receipt and retries retain the same command identity', async () => {
  const f = fixture(); f.ports.create.mockRejectedValueOnce(new Error('rollback'));
  await expect(saveManagedCopy(f.state, command(), f.ports)).rejects.toThrow('rollback');
  expect(f.state).toEqual({ bindings: {}, receipts: {} });
  expect(recoverManagedCopy(f.state, 'command-1', sourceHash(command()))).toBeNull();
  expect((await saveManagedCopy(f.state, command(), f.ports)).disposition).toBe('created');
});
test('the generic protocol accepts an unregistered site without accepting page credentials or foreign private identity', () => {
  expect(parseManagedSave(command())).toEqual(command());
  expect(() => parseManagedSave({ ...command(), cookie: 'never' })).toThrow('invalid_source_document');
  const c = command(); if (c.slot.kind !== 'bookmark') throw new Error('fixture');
  expect(() => parseManagedSave({ ...c, slot: { kind: 'bookmark', copy: { ...c.slot.copy, content: { ...c.slot.copy.content, accountId: 'other' } } } })).toThrow('invalid_managed_copy');
});
