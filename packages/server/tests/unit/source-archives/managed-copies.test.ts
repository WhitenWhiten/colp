import { expect, test, vi } from 'vitest';
import { parseManagedSave, saveManagedCopy, recoverManagedCopy, managedSlotKey, sourceHash, claimManagedSemantic, releaseManagedSemantic, observeManagedCopy, markManagedChange, relocateManagedCopy,
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
test('a local opt-out suppresses shared reconstruction even when the canonical bookmark is retained', async () => {
  const f = fixture(), c = command(), saved = await saveManagedCopy(f.state, c, f.ports);
  expect(() => markManagedChange(f.state, c.collectionId, c.slot, 'foreign-node', 'suppressed')).toThrow('source_copy_adoption_conflict');
  markManagedChange(f.state, c.collectionId, c.slot, saved.node.nodeId, 'suppressed');
  markManagedChange(f.state, c.collectionId, c.slot, saved.node.nodeId, 'detached');
  expect((await saveManagedCopy(f.state, { ...c, commandId: 'new-device' }, f.ports)).disposition).toBe('suppressed');
  expect(f.nodes.has(saved.node.nodeId)).toBe(true); expect(f.ports.create).toHaveBeenCalledTimes(1);
});
test('a proven host move refreshes all aliases; a late move never revives a deleted copy', async () => {
  const f = fixture(), c = command(), saved = await saveManagedCopy(f.state, c, f.ports);
  if (c.slot.kind !== 'bookmark') throw new Error('fixture');
  const semantic = { kind: 'bookmark' as const, copy: { purpose: 'semantic' as const, content: c.slot.copy.content } };
  await saveManagedCopy(f.state, { ...c, commandId: 'adopt-semantic', slot: semantic, adopt: { nodeId: saved.node.nodeId, revision: saved.node.revision } }, f.ports);
  const moved = { ...saved.node, parentId: 'topic-folder', revision: 'r3' }; f.nodes.set(saved.node.nodeId, moved);
  await observeManagedCopy(f.state, c.collectionId, semantic, f.ports);
  const expected = { nodeId: moved.nodeId, from: saved.node.parentId, to: moved.parentId, title: moved.title, url: moved.url, revision: moved.revision };
  await relocateManagedCopy(f.state, c.collectionId, semantic, expected, f.ports);
  expect(Object.values(f.state.bindings).every(b => b.state === 'active' && b.node.parentId === 'topic-folder')).toBe(true);
  markManagedChange(f.state, c.collectionId, semantic, moved.nodeId, 'suppressed');
  await expect(relocateManagedCopy(f.state, c.collectionId, semantic, expected, f.ports)).rejects.toThrow('source_copy_adoption_conflict');
  expect(Object.values(f.state.bindings).every(b => b.state === 'suppressed')).toBe(true); expect(f.ports.create).toHaveBeenCalledTimes(1);
});
test('an identity version change requires migration instead of creating another copy', async () => {
  const f = fixture(), c = command(); await saveManagedCopy(f.state, c, f.ports);
  if (c.slot.kind !== 'bookmark') throw new Error('fixture');
  await expect(saveManagedCopy(f.state, { ...c, commandId: 'new-version', slot: { kind: 'bookmark', copy: { ...c.slot.copy,
    content: { ...c.slot.copy.content, identityVersion: 2 } } } }, f.ports)).rejects.toThrow('source_identity_migration_required');
  expect(f.ports.create).toHaveBeenCalledTimes(1);
});
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
  expect(claimManagedSemantic(f.state, 'library', copy, 'device-b-job')).toMatchObject({ status: 'waiting' });
  if (first.status !== 'claimed') throw new Error('fixture');
  releaseManagedSemantic(f.state, 'library', copy, first.claim);
  const next = claimManagedSemantic(f.state, 'library', copy, 'device-b-job');
  if (next.status !== 'claimed') throw new Error('fixture');
  releaseManagedSemantic(f.state, 'library', copy, first.claim);
  expect(claimManagedSemantic(f.state, 'library', copy, 'device-a-job')).toMatchObject({ status: 'waiting', claim: next.claim });
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
  expect(result.disposition).toBe(change === 'deleted' ? 'suppressed' : change === 'renamed' ? 'reused' : 'detached');
  expect(f.ports.create).toHaveBeenCalledTimes(1);
  expect(f.state.bindings[managedSlotKey('library', command().slot)]?.state).toBe(change === 'renamed' ? 'active' : result.disposition);
  if (change === 'renamed') expect(result.node.title).toBe('My title');
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

test.each(['singleKeepExisting', 'singlePreferSemantic'] as const)('concurrent source and semantic plans obey %s regardless of commit order', async copyPolicy => {
  for (const semanticFirst of [false, true]) {
    const f = fixture(), source = { ...command(), copyPolicy };
    if (source.slot.kind !== 'bookmark') throw new Error('fixture');
    const semantic: ManagedSaveCommand = { ...source, commandId: 'semantic', replicaId: 'device-b', parentId: 'topics',
      slot: { kind: 'bookmark', copy: { purpose: 'semantic', content: source.slot.copy.content } } };
    if (semantic.slot.kind !== 'bookmark') throw new Error('fixture');
    const claim = claimManagedSemantic(f.state, 'library', semantic.slot.copy, 'semantic');
    if (claim.status !== 'claimed') throw new Error('fixture');
    semantic.semanticClaim = { ownerId: 'semantic', revision: claim.claim.revision };
    const ordered = semanticFirst ? [semantic, source] : [source, semantic];
    const first = await saveManagedCopy(f.state, ordered[0]!, f.ports);
    const next = await saveManagedCopy(f.state, ordered[1]!, f.ports);
    expect(next.node.nodeId).toBe(first.node.nodeId); expect(next.disposition).toBe('reused');
    expect(next.reusedFrom).toBe(semanticFirst ? 'semantic' : 'sourceArchive');
    expect(f.ports.create).toHaveBeenCalledTimes(1);
    expect(recoverManagedCopy(f.state, next.commandId, next.digest)).toEqual(next);
  }
});
test('single-copy arbitration preserves suppression and rejects an existing multi-copy migration', async () => {
  const f = fixture(), c = command(); if (c.slot.kind !== 'bookmark' || c.slot.copy.purpose !== 'sourceArchive') throw new Error('fixture');
  const first = await saveManagedCopy(f.state, c, f.ports);
  markManagedChange(f.state, 'library', c.slot, first.node.nodeId, 'suppressed');
  const other = { ...c, commandId: 'other', copyPolicy: 'singleKeepExisting' as const,
    slot: { kind: 'bookmark' as const, copy: { ...c.slot.copy, sourceCollectionId: 'other' } } };
  expect((await saveManagedCopy(f.state, other, f.ports)).disposition).toBe('suppressed');
  await saveManagedCopy(f.state, { ...other, commandId: 'explicit-multiple', copyPolicy: 'sourceAndSemantic',
    slot: { kind: 'bookmark', copy: { ...c.slot.copy, sourceCollectionId: 'third' } } }, f.ports);
  await expect(saveManagedCopy(f.state, { ...other, commandId: 'single-again' }, f.ports)).rejects.toThrow('source_copy_policy_needs_review');
});

test('negotiated local convergence keeps one shared role and recovers the exact merge receipt', async () => {
  const f = fixture(), c = command();
  const winner = await saveManagedCopy(f.state, c, f.ports);
  const loser = { ...winner.node, nodeId: 'offline-b', revision: 'uploaded-b' }; f.nodes.set(loser.nodeId, loser);
  const converge = vi.fn(async (_: ManagedSaveCommand, target: ManagedNode | null) => {
    if (!target) throw Error('fixture'); f.nodes.set(loser.nodeId, { ...loser, deleted: true }); return target;
  });
  const next = parseManagedSave({ ...command('offline-adopt'), replicaId: 'device-b', adopt: { nodeId: loser.nodeId, revision: loser.revision }, converge: { fromParentId: c.parentId } });
  const receipt = await saveManagedCopy(f.state, next, { ...f.ports, converge });
  expect(receipt).toMatchObject({ disposition: 'reused', convergedFrom: loser.nodeId, node: { nodeId: winner.node.nodeId } });
  expect(await saveManagedCopy(f.state, next, { ...f.ports, converge })).toEqual(receipt);
  expect(recoverManagedCopy(f.state, next.commandId, sourceHash(next))).toEqual(receipt);
  expect(converge).toHaveBeenCalledOnce(); expect(f.ports.create).toHaveBeenCalledOnce();
  expect(() => parseManagedSave({ ...command(), converge: { fromParentId: 'root' } })).toThrow('invalid_managed_command');
});
test('manual suppression and protected aliases never authorize destructive convergence', async () => {
  const f = fixture(), c = command(), winner = await saveManagedCopy(f.state, c, f.ports);
  const converge = vi.fn(async () => winner.node);
  const next = { ...command('offline'), adopt: { nodeId: 'other', revision: 'r2' }, converge: { fromParentId: c.parentId } };
  markManagedChange(f.state, c.collectionId, c.slot, winner.node.nodeId, 'suppressed');
  expect((await saveManagedCopy(f.state, next, { ...f.ports, converge })).disposition).toBe('suppressed');
  expect(converge).not.toHaveBeenCalled();
  f.state.bindings[winner.key]!.state = 'active';
  f.state.bindings.protected = { ...f.state.bindings[winner.key]!, node: { ...winner.node, nodeId: 'other' } };
  await expect(saveManagedCopy(f.state, { ...next, commandId: 'protected' }, { ...f.ports, converge })).rejects.toThrow('source_copy_protected');
  expect(converge).not.toHaveBeenCalled();
});

test('semantic-preferred convergence refreshes every role while retaining the original source receipt', async () => {
  const f = fixture(), source = command(), original = await saveManagedCopy(f.state, source, f.ports);
  if (source.slot.kind !== 'bookmark') throw Error('fixture');
  const semantic: ManagedSaveCommand = { ...command('semantic-offline'), parentId: 'topics', copyPolicy: 'singlePreferSemantic',
    slot: { kind: 'bookmark', copy: { purpose: 'semantic', content: source.slot.copy.content } },
    adopt: { nodeId: 'provisional', revision: 'local-r1' }, converge: { fromParentId: 'topics' } };
  const converge = vi.fn(async (_: ManagedSaveCommand, winner: ManagedNode | null) => ({ ...winner!, parentId: 'topics', revision: 'moved-r1' }));
  const result = await saveManagedCopy(f.state, semantic, { ...f.ports, converge });
  expect(result).toMatchObject({ node: { nodeId: original.node.nodeId, parentId: 'topics' }, reusedFrom: 'sourceArchive' });
  expect(f.state.bindings[original.key]?.node.parentId).toBe('topics');
  expect(converge).toHaveBeenCalledWith(semantic, original.node, source.slot);
  expect(f.state.receipts[original.commandId]?.node.parentId).toBe('folder');
});
