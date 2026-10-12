import { resolveCreateIdentity } from '../src/projection-native-occupancy.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

// Independent acceptance: assertions describe required behavior, not the observed defects.
installKns05IndexedDb();

async function fixture(crash?: string, source: 'active' | 'detached' = 'active', dest: 'active' | 'detached' | 'pending' = 'active') {
  const f = await setup(crash);
  await f.store.setFirstRun(scope, 'completed');
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: false, status: source, rootRole: 'bookmarks-bar' });
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other', remoteMountNodeId: 'other-colp',
    boundaryVersion: '1', materialized: false, status: dest, rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other', nodeKind: 'folder',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other', content: { title: 'Other' } } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.deleteMapping(scope, 'native-child'); await f.api.remove('native-child'); f.api.calls.length = 0;
  return f;
}

test('IA-07: create after-browser-call restart does not create a third identical bookmark', async () => {
  const f = await fixture('after_browser_call');
  f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'Remote', url: 'https://example.test/' });
  await f.applier.stage(f.page([f.createEvent('Bookmark', 75)]));
  await assert.rejects(() => f.applier.resume(), /worker_crash/);
  assert.equal((await f.api.getChildren('native-root')).filter(n => n.title === 'Remote').length, 2);
  const evidenceId = (await f.store.exportScope(scope)).intents
    .map((intent) => intent.apiResultEvidence?.nativeId).find((id) => typeof id === 'string');
  assert.equal(typeof evidenceId, 'string');
  f.disableCrash(); await f.applier.resume();
  const children = (await f.api.getChildren('native-root')).filter(n => n.title === 'Remote');
  assert.equal(children.length, 2);
  assert.equal(f.api.calls.filter((call) => call.kind === 'create').length, 1);
  assert.equal((await f.store.getMappingByColpId(scope, 'node-created-75'))?.nativeId, evidenceId);
});


test('range entry materialization reuses its create after worker restart', async () => {
  const f = await fixture('after_browser_call', 'detached', 'active');
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 79, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp' });
  await f.applier.stage(f.page([event])); await assert.rejects(() => f.applier.resume(), /worker_crash/);
  f.disableCrash(); await f.applier.resume();
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 1);
  assert.equal((await f.api.get('native-node'))[0]?.parentId, 'native-root');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.parentNativeId, 'native-other');
});

test('an executing recovery projection never creates again from ambiguous content', () => {
  const result = resolveCreateIdentity({ intent: { state: 'executing', colpId: 'remote', title: 'Equal' },
    children: [{ id: 'one', title: 'Equal' }, { id: 'two', title: 'Equal' }], occupancy: new Map() });
  assert.equal(result.action, 'ambiguous');
});

test('an executing recovery projection does not reuse a unique title+URL without observedNativeId', () => {
  const result = resolveCreateIdentity({ intent: { state: 'executing', colpId: 'remote', title: 'Equal' },
    children: [{ id: 'one', title: 'Equal' }], occupancy: new Map() });
  assert.equal(result.action, 'ambiguous');
});
