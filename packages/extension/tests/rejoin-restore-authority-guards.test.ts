import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { deletionFixture } from './rejoin-decision-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { missingRejoinGroups } from '../src/scope-rejoin-deletion.js';
import { planRejoinRestore } from '../src/scope-rejoin-restore.js';
import { rejoinBoundaryDigest, remoteChildren, remoteSubtree, snapshotMapping } from '../src/scope-rejoin-authority.js';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';
import type { RejoinOrderInput } from '../src/scope-rejoin-order.js';

installKns05IndexedDb();
type Fixture = Awaited<ReturnType<typeof deletionFixture>>;
async function input(f: Fixture): Promise<RejoinOrderInput> {
  return { ...f.input(), mount: (await f.getStore().getMountBinding(scope, 'mount-bar'))! };
}
async function unchangedFailure(f: Fixture, expected: RegExp, custom?: Partial<RejoinOrderInput>) {
  const current = { ...await input(f), ...custom };
  const mappings = await f.getStore().listMappings(scope);
  const [group] = await missingRejoinGroups(current, mappings, []);
  assert.ok(group);
  const before = { mappings, queue: await f.getStore().listQueue(scope), native: f.api.all(), calls: [...f.api.calls] };
  await assert.rejects(planRejoinRestore(current, group), expected);
  assert.deepEqual(await f.getStore().listMappings(scope), before.mappings);
  assert.deepEqual(await f.getStore().listQueue(scope), before.queue);
  assert.deepEqual(f.api.all(), before.native);
  assert.deepEqual(f.api.calls, before.calls);
}
function ancestor(nodeId: string, parentId: string | null, patch: Partial<RemoteNodeFact> = {}): RemoteNodeFact {
  return { nodeId, parentId, kind: 'folder', revision: `rev-${nodeId}`, title: nodeId,
    childrenRevision: `children-${nodeId}`, position: nodeId, ...patch };
}

test.each(['missing', 'cycle', 'bookmark', 'unmounted', 'mapped_cycle', 'mapped_absent'] as const)(
  'Keep cloud refuses %s ancestor authority without changing the browser or durable identities', async shape => {
    const f = await deletionFixture();
    try {
      const store = f.getStore();
      const rootParent = shape === 'unmounted' ? 'outside-root' : 'ancestor-a';
      const facts = f.snapshot().remoteFacts.map(row => row.nodeId === 'restore-folder' ? { ...row, parentId: rootParent } : row);
      if (shape === 'unmounted') facts.push(ancestor('outside-root', null));
      if (shape === 'cycle' || shape === 'mapped_cycle') facts.push(ancestor('ancestor-a', 'ancestor-b'), ancestor('ancestor-b', 'ancestor-a'));
      if (shape === 'bookmark') facts.push(ancestor('ancestor-a', 'root-colp', { kind: 'bookmark', url: 'https://example.test/leaf' }));
      if (shape === 'mapped_cycle' || shape === 'mapped_absent') {
        for (const id of shape === 'mapped_cycle' ? ['ancestor-a', 'ancestor-b'] : ['ancestor-a']) {
          await store.putMapping(scope, { nativeId: `unmounted:${id}`, colpId: id, nodeKind: 'folder',
            rootNativeId: 'native-root', parentColpId: shape === 'mapped_absent' ? 'root-colp'
              : id === 'ancestor-a' ? 'ancestor-b' : 'ancestor-a',
            projection: { revision: `rev-${id}`, digest: `digest-${id}`, content: { title: id } } });
        }
      }
      f.setFacts(facts);
      await unchangedFailure(f, shape === 'unmounted' ? /rejoin_destination_unavailable/ : /rejoin_remote_tree_invalid/);
    } finally { f.getStore().close(); }
  });

test.each(['privateLocal', 'managed'] as const)('a %s cloud member cannot enter a confirmed restore', async flag => {
  const f = await deletionFixture();
  try {
    f.setFacts(f.snapshot().remoteFacts.map(row => row.nodeId === f.children[0]!.nodeId ? { ...row, [flag]: true } : row));
    await unchangedFailure(f, /rejoin_boundary_changed/);
  } finally { f.getStore().close(); }
});

test.each(['missing_revision', 'missing_position', 'duplicate_position'] as const)(
  'restoring children requires complete and unique remote order evidence: %s', async invalid => {
    const f = await deletionFixture();
    try {
      f.setFacts(f.snapshot().remoteFacts.map(row => {
        if (invalid === 'missing_revision' && row.nodeId === 'restore-folder') {
          const { childrenRevision: _revision, ...without } = row; return without;
        }
        if (row.nodeId !== f.children[0]!.nodeId) return row;
        if (invalid === 'duplicate_position') return { ...row, position: f.children[1]!.position };
        if (invalid === 'missing_position') { const { position: _position, ...without } = row; return without; }
        return row;
      }));
      await unchangedFailure(f, /rejoin_remote_order_unavailable/);
    } finally { f.getStore().close(); }
  });

test('an observation-only comparison cannot authorize recreating a whole cloud subtree', async () => {
  const f = await deletionFixture();
  try { await unchangedFailure(f, /rejoin_remote_order_unavailable/, { readRemoteSnapshot: undefined }); }
  finally { f.getStore().close(); }
});

test('a locally rescued descendant prevents recreating or deleting its former ancestor', async () => {
  const f = await deletionFixture();
  try {
    f.api.seed({ id: 'rescued-child', parentId: 'native-root', title: f.children[0]!.title, url: f.children[0]!.url });
    await f.getStore().putMapping(scope, { ...snapshotMapping(f.children[0]!, (await input(f)).mount), nativeId: 'rescued-child',
      parentNativeId: 'native-folder' });
    await unchangedFailure(f, /rejoin_waiting_local_move/);
  } finally { f.getStore().close(); }
});

test('snapshot evidence preserves optional content and rejects repeated members instead of silently truncating them', async () => {
  const f = await deletionFixture();
  try {
    const mount = (await input(f)).mount;
    const fact: RemoteNodeFact = { ...f.snapshot().remoteFacts[0]!, description: 'Description', tags: ['a', 'b'],
      extensions: { vendor: { enabled: true } }, folderRole: 'bookmarks-bar' };
    const mapped = snapshotMapping(fact, mount);
    assert.deepEqual(mapped.projection.content, { title: fact.title, description: 'Description', tags: ['a', 'b'],
      extensions: { vendor: { enabled: true } }, folderRole: 'bookmarks-bar' });
    assert.equal(mapped.parentNativeId, undefined);
    assert.notEqual(rejoinBoundaryDigest(null), rejoinBoundaryDigest(await f.getStore().getScope(scope)));
    assert.deepEqual(remoteSubtree(f.snapshot(), 'missing-node'), []);
    assert.deepEqual(remoteChildren({ ...f.snapshot(), remoteFacts: [fact] }, fact.nodeId), []);
    const duplicate = { ...f.snapshot(), remoteFacts: [...f.snapshot().remoteFacts, f.children[0]!] };
    assert.throws(() => remoteSubtree(duplicate, 'restore-folder'), /rejoin_remote_tree_invalid/);
  } finally { f.getStore().close(); }
});
