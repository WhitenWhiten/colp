import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { matchLocalRemote, type LocalNodeFact, type MappingFact } from '../src/bootstrap/matcher.js';
import { barMount, baseConfirm, installKns03IndexedDb, root, scope, setup } from './kns-03-bootstrap-harness.js';

installKns03IndexedDb();
const local: LocalNodeFact = { nativeId: 'bookmark', mountNativeRootId: 'bar', parentNativeId: 'bar',
  kind: 'bookmark', title: 'Same title', url: 'https://example.test/exact' };
const remote = [root,
  { nodeId: 'cloud-bar', parentId: root.nodeId, kind: 'folder' as const, title: 'Bar', folderRole: 'bookmarks-bar', revision: 'r-bar' },
  { nodeId: 'new-bookmark', parentId: 'cloud-bar', kind: 'bookmark' as const, title: local.title, url: local.url, revision: 'r-new' },
  { nodeId: 'other-bookmark', parentId: 'cloud-bar', kind: 'bookmark' as const, title: 'Other', url: 'https://example.test/other', revision: 'r-other' },
];
type Input = Parameters<typeof matchLocalRemote>[0];
const match = (input: Partial<Input> = {}) => matchLocalRemote({ scopeKey: 'identity-scope', confirmationId: 'identity-confirm',
  local: [local], remote, mappings: [], mounts: [barMount('cloud-bar')], rootNodeId: root.nodeId,
  bootstrapMode: 'merge', ...input });
const proof = (kind: 'mapping' | 'sourceRef' | 'sidecar', colpId: string): Partial<Input> => kind === 'mapping'
  ? { mappings: [{ nativeId: local.nativeId, colpId }] }
  : kind === 'sourceRef' ? { local: [{ ...local, sourceRefColpId: colpId }] }
    : { sidecars: [{ nativeId: local.nativeId, colpId }] };

test.each(['mapping', 'sourceRef', 'sidecar'] as const)('%s identity missing from the snapshot cannot adopt a similar replacement', kind => {
  const report = match(proof(kind, 'deleted-bookmark'));
  expect(report.matched).toEqual([]);
  expect(report.planned).toEqual([]);
  expect(report.localOnly).toEqual(['bookmark']);
  expect(report.remoteOnly).toContain('new-bookmark');
});

test.each(['mapping', 'sourceRef', 'sidecar'] as const)('%s identity still wins over different current content when the node exists', kind => {
  const report = match(proof(kind, 'other-bookmark'));
  expect(report.matched).toEqual([{ nativeId: 'bookmark', nodeId: 'other-bookmark' }]);
  expect(report.planned).toEqual([]);
  expect(report.conflicts.map(row => row.kind)).toEqual(['title', 'url']);
});

const conflicting: Array<{ name: string; input: Partial<Input> }> = [
  { name: 'mapping and source reference', input: { ...proof('mapping', 'new-bookmark'), ...proof('sourceRef', 'other-bookmark') } },
  { name: 'mapping and sidecar', input: { ...proof('mapping', 'new-bookmark'), ...proof('sidecar', 'other-bookmark') } },
  { name: 'source reference and sidecar', input: { ...proof('sourceRef', 'new-bookmark'), ...proof('sidecar', 'other-bookmark') } },
  { name: 'absent mapping and existing source reference', input: { ...proof('mapping', 'deleted-bookmark'), ...proof('sourceRef', 'new-bookmark') } },
  { name: 'absent mapping and existing sidecar', input: { ...proof('mapping', 'deleted-bookmark'), ...proof('sidecar', 'new-bookmark') } },
  { name: 'absent source reference and existing sidecar', input: { ...proof('sourceRef', 'deleted-bookmark'), ...proof('sidecar', 'new-bookmark') } },
  { name: 'two contradictory sidecars', input: { sidecars: [{ nativeId: 'bookmark', colpId: 'new-bookmark' },
    { nativeId: 'bookmark', colpId: 'other-bookmark' }] } },
];
test.each(conflicting)('$name cannot silently choose a different identity', ({ input }) => {
  expect(() => match(input)).toThrow('mapping_identity_conflict');
});

test('agreeing identity sources remain idempotent and unresolved placeholders do not conflict', () => {
  const report = match({ ...proof('sourceRef', 'other-bookmark'), ...proof('sidecar', 'other-bookmark'),
    mappings: [{ nativeId: 'bookmark', colpId: 'pending-bookmark' }] });
  expect(report.matched).toEqual([{ nativeId: 'bookmark', nodeId: 'other-bookmark' }]);
  expect(report.planned).toEqual([]);
});

test.each(['mapping', 'mount', 'sourceRef', 'sidecar'] as const)('a special-root %s identity is not replaced by a later same-role node', kind => {
  const report = match({ local: [{ nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: null,
    kind: 'folder', title: 'Bookmarks bar', folderRole: 'bookmarks-bar',
    ...(kind === 'sourceRef' ? { sourceRefColpId: 'deleted-bar' } : {}) }],
  mounts: [barMount(kind === 'mount' ? 'deleted-bar' : null)],
  mappings: kind === 'mapping' ? [{ nativeId: 'bar', colpId: 'deleted-bar' }] : [],
  sidecars: kind === 'sidecar' ? [{ nativeId: 'bar', colpId: 'deleted-bar' }] : [] });
  expect(report.matched).toEqual([]);
  expect(report.planned).toEqual([]);
});

test.each(['mapping', 'mount', 'sourceRef', 'sidecar'] as const)('a custom-root %s identity is not replaced by a same-title mount', kind => {
  const report = match({ local: [{ nativeId: 'custom', mountNativeRootId: 'custom', parentNativeId: null,
    kind: 'folder', title: 'Custom root', ...(kind === 'sourceRef' ? { sourceRefColpId: 'deleted-custom' } : {}) }],
  remote: [root, { nodeId: 'new-custom', parentId: root.nodeId, kind: 'folder', folderRole: 'custom',
    title: 'Custom root', revision: 'new-custom-revision' }],
  mounts: [{ nativeRootId: 'custom', customSourceKey: 'native-custom', remoteMountNodeId: kind === 'mount' ? 'deleted-custom' : null }],
  mappings: kind === 'mapping' ? [{ nativeId: 'custom', colpId: 'deleted-custom' }] : [],
  sidecars: kind === 'sidecar' ? [{ nativeId: 'custom', colpId: 'deleted-custom' }] : [] });
  expect(report.matched).toEqual([]);
  expect(report.planned).toEqual([]);
});

test('a bound mount cannot overwrite contradictory persisted identity', () => {
  expect(() => match({ mappings: [{ nativeId: 'bar', colpId: 'old-bar' }] }))
    .toThrow('mapping_identity_conflict');
});

test.each(['sourceRef', 'sidecar'] as const)('real coordinator does not persist or enqueue a replacement for absent %s evidence', async kind => {
  const { store, coordinator } = await setup();
  const evidence = proof(kind, 'deleted-bookmark');
  const input = baseConfirm({ localFacts: evidence.local ?? [local], remoteFacts: remote,
    mounts: [barMount('cloud-bar')], sidecars: evidence.sidecars });
  try {
    const view = await coordinator.confirm(input);
    expect(view.report?.matched).toEqual([]);
    expect(await store.getMappingByNativeId(scope, 'bookmark')).toBeNull();
    expect(await store.listQueue(scope)).toEqual([]);
    store.close();
    expect((await coordinator.confirm(input)).report?.matched).toEqual([]);
    expect(await store.getMappingByNativeId(scope, 'bookmark')).toBeNull();
    expect(await store.listQueue(scope)).toEqual([]);
  } finally { store.close(); }
});

test('real coordinator fails contradictory sidecar evidence without changing the durable mapping or queue', async () => {
  const { store, coordinator } = await setup();
  await store.putMapping(scope, { nativeId: 'bookmark', colpId: 'deleted-bookmark', rootNativeId: 'bar',
    parentNativeId: 'bar', parentColpId: 'cloud-bar', nodeKind: 'bookmark',
    projection: { revision: 'old-revision', digest: 'sha256:old', content: { title: local.title, url: local.url! } } });
  const prior = await store.getMappingByNativeId(scope, 'bookmark');
  try {
    await expect(coordinator.confirm(baseConfirm({ localFacts: [local], remoteFacts: remote,
      mounts: [barMount('cloud-bar')], sidecars: [{ nativeId: 'bookmark', colpId: 'new-bookmark' }] })))
      .rejects.toThrow('mapping_identity_conflict');
    expect(await store.getMappingByNativeId(scope, 'bookmark')).toEqual(prior);
    expect(await store.listQueue(scope)).toEqual([]);
    const identities: MappingFact[] = (await store.listMappings(scope)).filter(row => row.nativeId === 'bookmark');
    expect(identities).toHaveLength(1);
    // Corrected explicit evidence can resume the same durable run; no implicit
    // reset or rebind to the structurally similar replacement is required.
    store.close();
    const recovered = await coordinator.confirm(baseConfirm({ localFacts: [local], remoteFacts: remote.concat({
      nodeId: 'deleted-bookmark', parentId: 'cloud-bar', kind: 'bookmark', title: local.title, url: local.url, revision: 'r-returned',
    }), mounts: [barMount('cloud-bar')], sidecars: [{ nativeId: 'bookmark', colpId: 'deleted-bookmark' }] }));
    expect(recovered.report?.matched).toEqual([{ nativeId: 'bookmark', nodeId: 'deleted-bookmark' }]);
    expect(await store.getMappingByNativeId(scope, 'bookmark')).toEqual(prior);
    expect(await store.listQueue(scope)).toEqual([]);
  } finally { store.close(); }
});
