import { expect, test } from 'vitest';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { scope, setup, stores } from './snapshot-boundary-fixture.js';
import { leftoverVirtualChildrenNeedReproject, recoverVerifiedOrFreeze, unprotectedProjectionIntents } from '../src/recovery-guard.js';
import { projectVirtualSnapshotChildren } from '../src/recovery-projection-executor.js';
import { executeNativeCreate } from '../src/native-create-executor.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { pullFixtures } from './pull-effect-fixtures.js';

test.each(['current', 'legacy'])('snapshot creates preserve the selected descendant and legacy single-root paths (%s)', async variant => {
  const f = await setup(variant);
  const result = await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.chrome.api, staged: f.rows, freezeUnprovenIdentity: true });
  const inside = result.find(row => row.colpId === 'inside')!;
  expect(f.chrome.nodes.get(inside.nativeId)).toMatchObject({ title: 'inside', parentId: '10' });
  expect(f.chrome.creates).toBe(variant === 'legacy' ? 2 : 1);
  if (variant === 'current') expect(result.find(row => row.colpId === 'outside')?.nativeId).toBe('recovery:outside');
  expect((await f.store.listQueue(scope))).toEqual([]);
  expect(await leftoverVirtualChildrenNeedReproject(f.store, scope)).toBe(false);
});

test.each(['detached', 'pending', 'private', 'managed', 'missing-parent', 'cycle', 'permission', 'stopped'])
('snapshot cannot use a structural native ancestor after %s makes the chosen subtree unavailable', async variant => {
  const f = await setup(variant), before = [...f.chrome.nodes.values()];
  // Corrupt graph and stopped scope fixtures are restored durable states. The
  // executor must make no native call even when a parent happens to exist.
  if (variant === 'stopped') {
    expect(await leftoverVirtualChildrenNeedReproject(f.store, scope)).toBe(false);
    return;
  }
  const result = await projectVirtualSnapshotChildren({ scope, store: f.store, api: f.chrome.api, bound: f.rows });
  expect(result.find(row => row.colpId === 'inside')?.nativeId).toBe('recovery:inside');
  expect(f.chrome.creates).toBe(0); expect([...f.chrome.nodes.values()]).toEqual(before);
  expect(await f.store.listProjectionIntents(scope)).toEqual([]);
  expect(await leftoverVirtualChildrenNeedReproject(f.store, scope)).toBe(false);
});

test('a pending native create is held when its mount is removed, then resumes once under renewed selection after reopening', async () => {
  const f = await setup('detached');
  await f.store.replaceProjectionIntents(scope, [{ intentId: 'create:inside', kind: 'create', colpId: 'inside', order: 1,
    generation: 1, state: 'pending', suppression: 'recovery:create:inside', parentColpId: 'chosen',
    title: 'inside', url: 'https://inside.example/' }]);
  await projectVirtualSnapshotChildren({ scope, store: f.store, api: f.chrome.api, bound: f.rows });
  expect(f.chrome.creates).toBe(0);
  expect(await unprotectedProjectionIntents(f.store, scope)).toEqual([]);
  expect(await f.store.listProjectionIntents(scope)).toEqual([expect.objectContaining({ state: 'pending' })]);
  f.store.close(); const reopened = createSyncStateStore({ indexedDB: f.indexedDB }); stores.push(reopened);
  const { scopeKey: _scopeKey, ...mount } = (await reopened.getMountBinding(scope, 'selected-mount'))!;
  await reopened.putMountBinding(scope, { ...mount, status: 'active' });
  expect(await leftoverVirtualChildrenNeedReproject(reopened, scope)).toBe(true);
  await recoverVerifiedOrFreeze({ scope, store: reopened, api: f.chrome.api, staged: await reopened.listMappings(scope) });
  expect(f.chrome.creates).toBe(1);
  expect(await unprotectedProjectionIntents(reopened, scope)).toEqual([]);
  expect((await reopened.getMappingByColpId(scope, 'inside'))?.nativeId).toBe('11');
  expect((await reopened.getMappingByColpId(scope, 'outside'))?.nativeId).toBe('recovery:outside');
});

test('a boundary change after children are read prevents the native create and keeps its durable attempt retryable', async () => {
  const f = await setup(), getChildren = f.chrome.api.getChildren;
  let changed = false;
  f.chrome.api.getChildren = async id => {
    const children = await getChildren(id);
    if (!changed && id === '10') {
      changed = true;
      const { scopeKey: _scopeKey, ...mount } = (await f.store.getMountBinding(scope, 'selected-mount'))!;
      await f.store.putMountBinding(scope, { ...mount, status: 'detached' });
    }
    return children;
  };
  await expect(projectVirtualSnapshotChildren({ scope, store: f.store, api: f.chrome.api, bound: f.rows })).rejects.toThrow('need_authority');
  expect(changed).toBe(true); expect(f.chrome.creates).toBe(0);
  expect(await f.store.getApplyIntent(scope, 'projection:create:inside')).toMatchObject({ nativeResult: 'not_started', replayState: 'not_started' });
  expect(await f.store.listProjectionIntents(scope)).toEqual([expect.objectContaining({ state: 'recovery' })]);
  f.store.close(); const reopened = createSyncStateStore({ indexedDB: f.indexedDB }); stores.push(reopened);
  const { scopeKey: _scopeKey, ...mount } = (await reopened.getMountBinding(scope, 'selected-mount'))!;
  await reopened.putMountBinding(scope, { ...mount, status: 'active' });
  await projectVirtualSnapshotChildren({ scope, store: reopened, api: f.chrome.api, bound: await reopened.listMappings(scope) });
  expect(f.chrome.creates).toBe(1);
  expect(await reopened.getApplyIntent(scope, 'projection:create:inside')).toMatchObject({ nativeResult: 'applied_with_evidence' });
});

test('an unknown started create remains unknown after range removal and restart without adopting or duplicating its native copy', async () => {
  const f = await setup(), create = f.chrome.api.create;
  f.chrome.api.create = async input => { await create(input); throw new Error('worker_crash'); };
  await expect(projectVirtualSnapshotChildren({ scope, store: f.store, api: f.chrome.api, bound: f.rows })).rejects.toThrow('worker_crash');
  const started = await f.store.getApplyIntent(scope, 'projection:create:inside');
  expect(started).toMatchObject({ state: 'browser_call_started', replayState: 'started' });
  expect(started?.apiResultEvidence).toBeUndefined();
  const { scopeKey: _scopeKey, ...mount } = (await f.store.getMountBinding(scope, 'selected-mount'))!;
  await f.store.putMountBinding(scope, { ...mount, status: 'detached' });
  f.store.close(); const reopened = createSyncStateStore({ indexedDB: f.indexedDB }); stores.push(reopened);
  f.chrome.api.create = create;
  await expect(projectVirtualSnapshotChildren({ scope, store: reopened, api: f.chrome.api, bound: await reopened.listMappings(scope) }))
    .rejects.toThrow('snapshot_native_projection_ambiguous');
  expect(f.chrome.creates).toBe(1);
  expect([...f.chrome.nodes.values()].filter(row => row.title === 'inside')).toHaveLength(1);
  expect((await reopened.getMappingByColpId(scope, 'inside'))?.nativeId).toBe('recovery:inside');
  // The projection's ambiguous-identity guard leaves the original started marker
  // intact. An absent API receipt must not become a not-started replay permit.
  expect(await reopened.getApplyIntent(scope, 'projection:create:inside')).toEqual(started);
  expect(await reopened.listProjectionIntents(scope)).toEqual([expect.objectContaining({ state: 'ambiguous' })]);
  expect((await reopened.getMountBinding(scope, 'selected-mount'))?.status).toBe('detached');
});

test('an already projected unselected sibling remains a local copy after upgrade, remote updates, and local edits', async () => {
  const f = await setup();
  // Restore the prior release's real durable outcome: a Chrome create receipt,
  // its exact mapping and terminal projection under the unselected structural
  // Bar. No current selection is expanded to legitimize that historical copy.
  const outcome = await executeNativeCreate({ scope, store: f.store, api: f.chrome.api,
    intentId: 'projection:create:outside', owner: { scopeKey: scopeKey(scope), generation: 1,
      commandId: 'projection', eventId: 'create:outside', colpId: 'outside', substep: 'projection' },
    parentNativeId: '1', expected: { title: 'Local copy from old release' },
    create: () => f.chrome.api.create({ parentId: '1', title: 'Local copy from old release' }) });
  if (outcome.result !== 'applied_with_evidence') throw new Error('historical_receipt_missing');
  const historical = { ...f.rows.find(row => row.colpId === 'outside')!, nodeKind: 'folder' as const,
    nativeId: outcome.nativeId, projection: { revision: 'old-outside', digest: 'old-outside',
      childrenRevision: 'old-outside-children', content: { title: 'Local copy from old release' } } };
  await f.store.putMapping(scope, historical);
  await f.store.replaceProjectionIntents(scope, [{ intentId: 'create:outside', kind: 'create', colpId: 'outside',
    generation: 1, order: 1, state: 'terminal', observedNativeId: outcome.nativeId,
    parentNativeId: '1', parentColpId: 'bar', suppression: 'recovery:create:outside', title: 'Local copy from old release' }]);
  const receipt = await f.store.getApplyIntent(scope, 'projection:create:outside');
  const before = structuredClone(f.chrome.nodes.get(outcome.nativeId));
  f.store.close(); const reopened = createSyncStateStore({ indexedDB: f.indexedDB }); stores.push(reopened);
  const staged = (await reopened.listMappings(scope)).map(row => row.colpId === 'outside' ? { ...row,
    projection: { ...row.projection, revision: 'new-outside', content: { title: 'Cloud changed after upgrade' } } } : row);
  await recoverVerifiedOrFreeze({ scope, store: reopened, api: f.chrome.api, staged, freezeUnprovenIdentity: true });
  expect(f.chrome.nodes.get(outcome.nativeId)).toEqual(before);
  expect((await reopened.getRemoteObservation(scope, 'outside'))?.payload).toMatchObject({ title: 'Cloud changed after upgrade' });
  expect(await reopened.getApplyIntent(scope, 'projection:create:outside')).toEqual(receipt);

  const applier = createPullApplier({ scope, store: reopened, api: f.chrome.api,
    session: { acceptedProtocolVersion: '0.2', sessionId: 'current-session', collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: 'https://boundary.test/effects/{effectId}/{pageNumber}', effectPageAuthority: 'https://boundary.test' });
  for (const [index, kind] of (['update', 'move'] as const).entries()) {
    const event = pullFixtures.mutationEvent({ kind, sequence: 10 + index, collectionId: scope.collectionId,
      targetId: 'outside', targetKind: 'folder', parentId: 'bar' });
    await applier.stage(pullFixtures.page({ events: [event], nextCursor: `history-${index}`, collectionRevision: `history-r${index}` }));
    await applier.resume();
    expect(f.chrome.nodes.get(outcome.nativeId)).toEqual(before);
    expect(await reopened.listPullEvents(scope)).toEqual(Array.from({ length: index + 1 }, () => expect.objectContaining({ state: 'page_complete' })));
  }
  f.chrome.nodes.set(outcome.nativeId, { ...f.chrome.nodes.get(outcome.nativeId)!, title: 'Local edit after upgrade' });
  const queue = createBookmarkEventQueue({ scope, store: reopened, autoFlush: false, api: {
    get: async id => (await f.chrome.api.get(id)).map(row => {
      if (typeof row.title !== 'string') throw new Error('native_title_missing');
      return { ...row, title: row.title };
    }),
    getChildren: async id => (await f.chrome.api.getChildren(id)).map(row => {
      if (typeof row.title !== 'string') throw new Error('native_title_missing');
      return { ...row, title: row.title };
    }),
  } });
  await queue.changed(outcome.nativeId, { title: 'Local edit after upgrade' }); await queue.flush();
  expect(await reopened.listQueue(scope)).toEqual([]);
  expect((await reopened.listBookmarkEvents(scope)).filter(row => row.kind === 'change')).toEqual([]);
  expect(f.chrome.nodes.get(outcome.nativeId)).toMatchObject({ title: 'Local edit after upgrade', parentId: '1' });
  expect(f.chrome.creates).toBe(2); // historical copy plus the legitimate selected child
  expect(await reopened.getScope(scope)).toMatchObject({ selectedRoots: ['chosen'], lifecycle: 'active' });
  expect(await leftoverVirtualChildrenNeedReproject(reopened, scope)).toBe(false);
});
