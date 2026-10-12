import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { setup, scope, installKns03IndexedDb } from './kns-03-bootstrap-harness.js';
import { setup as pullSetup, scope as pullScope, installKns05IndexedDb } from './kns-05-pull-harness.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import {
  mergeRemoteObservation, observationPauseBinding, observationValidForPause,
} from '../src/sync-state/remote-observation.js';
import type { MountPauseBaseline, RemoteObservationRecord } from '../src/sync-state/types.js';

installKns03IndexedDb();
installKns05IndexedDb();

const baseline = (lastAppliedCursor: string): MountPauseBaseline => ({
  generation: 1, boundaryVersion: '2', lastAppliedCursor, completeness: 'complete',
});

function observation(input: {
  readonly pauseCursor?: string | null; readonly pauseGeneration?: number;
  readonly pauseBoundaryVersion?: string; readonly kind?: RemoteObservationRecord['kind'];
  readonly payload?: RemoteObservationRecord['payload'];
}): RemoteObservationRecord {
  const bound = input.pauseCursor !== undefined || input.pauseGeneration !== undefined
    || input.pauseBoundaryVersion !== undefined;
  return {
    scopeKey: 'k', colpId: 'n', remoteRevision: 'r', cursor: 'c', kind: input.kind ?? 'content',
    payload: input.payload ?? { title: 'remote' }, sourceDigest: 'd', observedAt: 1,
    ...(bound ? {
      pauseGeneration: input.pauseGeneration ?? 1,
      pauseBoundaryVersion: input.pauseBoundaryVersion ?? '2',
      pauseCursor: input.pauseCursor ?? null,
    } : {}),
  };
}

test('observations are valid only for an equal pause identity', () => {
  const pause = baseline('cursor-new');
  assert.equal(observationValidForPause(observation({ pauseCursor: 'cursor-new' }), pause), true);
  assert.equal(observationValidForPause(observation({ pauseCursor: 'cursor-old' }), pause), false);
  assert.equal(observationValidForPause(observation({ pauseCursor: 'zzz' }), pause), false);
  assert.equal(observationValidForPause(observation({}), pause), false);
  assert.equal(observationValidForPause(observation({ pauseCursor: 'cursor-new', pauseGeneration: 2 }), pause), false);
});

test('merge does not inherit payload.deleted from a different pause', () => {
  const prior = observation({
    kind: 'tombstone', payload: { deleted: true }, pauseCursor: 'cursor-old', pauseBoundaryVersion: '1',
  });
  const next = observation({
    kind: 'content', payload: { title: 'restored' }, pauseCursor: 'cursor-new', pauseBoundaryVersion: '2',
  });
  assert.equal(mergeRemoteObservation(prior, next).payload.deleted, undefined);
});

test('R3: a previous detach observation cannot roll back a newer applied projection', async () => {
  const { store } = await setup();
  await store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: 'remote-bar',
    boundaryVersion: '2', materialized: true, status: 'detached', rootRole: 'bookmarks-bar',
    pauseBaseline: { generation: 1, boundaryVersion: '2', lastAppliedCursor: 'cursor-new', completeness: 'complete' } });
  await store.putMapping(scope, { nativeId: 'bm-1', colpId: 'remote-bookmark', rootNativeId: 'bar',
    parentNativeId: 'bar', parentColpId: 'remote-bar', nodeKind: 'bookmark',
    projection: { revision: 'r-new', digest: 'sha256:new', content: { title: 'latest-active', url: 'https://example.com/one' } } });
  await store.putRemoteObservation(scope, { colpId: 'remote-bookmark', remoteRevision: 'r-old', cursor: 'cursor-old',
    kind: 'content', payload: { title: 'old-paused', url: 'https://example.com/one' }, sourceDigest: 'sha256:old', observedAt: 1 });
  let native = { title: 'latest-active', url: 'https://example.com/one', parentId: 'bar' };
  await rejoinScopeMount(store, scope, 'mount-bar', new Set(['bar', 'bm-1']), [], {
    getNative: async () => native,
    updateNative: async (_id, changes) => { native = { ...native, ...changes }; return native; },
  });
  expect(native.title).toBe('latest-active');
  expect((await store.getMappingByNativeId(scope, 'bm-1'))?.projection.revision).toBe('r-new');
});

test('observation from the current pause applies when local equals baseline and remote differs', async () => {
  const f = await pullSetup();
  await f.store.setFirstRun(pullScope, 'completed');
  await f.store.putMountBinding(pullScope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  await detachScopeMount(f.store, pullScope, 'mount-bar');
  await f.applier.stage(f.page([f.mutationEvent('update')])); await f.applier.resume();
  assert.equal((await f.api.get('native-node'))[0]?.title, 'node-1');
  const paused = await f.store.getMountBinding(pullScope, 'mount-bar');
  const seen = await f.store.getRemoteObservation(pullScope, 'node-1');
  assert.equal(seen?.payload.title, 'Remote update');
  assert.deepEqual(observationPauseBinding(paused?.pauseBaseline), {
    pauseGeneration: seen?.pauseGeneration, pauseBoundaryVersion: seen?.pauseBoundaryVersion,
    pauseCursor: seen?.pauseCursor,
  });
  await rejoinScopeMount(f.store, pullScope, 'mount-bar', new Set(['native-root', 'native-node']), [], {
    getNative: async (id) => (await f.api.get(id))[0],
    updateNative: async (id, changes) => { await f.api.update(id, changes); },
  });
  assert.equal((await f.api.get('native-node'))[0]?.title, 'Remote update');
  assert.equal(await f.store.getRemoteObservation(pullScope, 'node-1'), null);
});

test('a leftover prior-pause observation cannot overlay a newer active projection on the next rejoin', async () => {
  const f = await pullSetup();
  await f.store.setFirstRun(pullScope, 'completed');
  await f.store.putMountBinding(pullScope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  await detachScopeMount(f.store, pullScope, 'mount-bar');
  await f.applier.stage(f.page([f.mutationEvent('update')])); await f.applier.resume();
  await rejoinScopeMount(f.store, pullScope, 'mount-bar', new Set(['native-root', 'native-node']), [], {
    getNative: async (id) => (await f.api.get(id))[0],
    updateNative: async (id, changes) => { await f.api.update(id, changes); },
  });
  assert.equal(await f.store.getRemoteObservation(pullScope, 'node-1'), null);
  await f.api.update('native-node', { title: 'latest-active' });
  const mapping = await f.store.getMappingByNativeId(pullScope, 'native-node');
  assert.ok(mapping);
  const { scopeKey: _key, ...rest } = mapping;
  await f.store.putMapping(pullScope, { ...rest,
    projection: { ...mapping.projection, revision: 'r-new', resourceRevision: 'r-new',
      content: { title: 'latest-active', url: 'https://example.test/' }, digest: 'sha256:new' } });
  await detachScopeMount(f.store, pullScope, 'mount-bar');
  await f.store.putRemoteObservation(pullScope, { colpId: 'node-1', remoteRevision: 'r-old', cursor: 'cursor-old',
    kind: 'content', payload: { title: 'old-paused', url: 'https://example.test/' },
    sourceDigest: 'sha256:old', observedAt: 1,
    pauseGeneration: 1, pauseBoundaryVersion: '1', pauseCursor: 'cursor-old' });
  await rejoinScopeMount(f.store, pullScope, 'mount-bar', new Set(['native-root', 'native-node']), [], {
    getNative: async (id) => (await f.api.get(id))[0],
    updateNative: async (id, changes) => { await f.api.update(id, changes); },
  });
  assert.equal((await f.api.get('native-node'))[0]?.title, 'latest-active');
  assert.equal((await f.store.getMappingByNativeId(pullScope, 'native-node'))?.projection.revision, 'r-new');
});

test('current-pause observations stay when rejoin conflicts', async () => {
  const f = await pullSetup();
  await f.store.setFirstRun(pullScope, 'completed');
  await f.store.putMountBinding(pullScope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  await detachScopeMount(f.store, pullScope, 'mount-bar');
  await f.api.update('native-node', { url: 'https://local.test/' });
  const mount = await f.store.getMountBinding(pullScope, 'mount-bar');
  await f.store.putRemoteObservation(pullScope, { colpId: 'node-1', remoteRevision: 'remote-r2', cursor: 'c2',
    kind: 'content', payload: { url: 'https://remote.test/' }, sourceDigest: 'digest', observedAt: Date.now(),
    ...observationPauseBinding(mount?.pauseBaseline) });
  const result = await rejoinScopeMount(f.store, pullScope, 'mount-bar', new Set(['native-root', 'native-node']), [], {
    getNative: async (id) => (await f.api.get(id))[0],
    updateNative: async (id, changes) => { await f.api.update(id, changes); },
  });
  assert.equal(result.mount.status, 'detached');
  assert.equal((await f.store.getRemoteObservation(pullScope, 'node-1'))?.payload.url, 'https://remote.test/');
});
