import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resumeLocalProjection } from '../src/local-projection-recovery.js';
import { leftoverVirtualChildrenNeedReproject } from '../src/recovery-guard.js';
import type { StoredSession } from '../src/types.js';
import { ack, json, nonemptyMountSnapshot, emptyPullPage, scope, seedLegacySpc2Bootstrap, setup } from './durable-sync-engine-harness.js';

async function interrupted(boundary = 'before_local_projection') {
  const fixture = await setup({ snapshotRequired: true, emptyCollection: true,
    useVerifiedProjector: true, seedMount: false });
  fixture.snapshotResponses.push(json(200, nonemptyMountSnapshot(true)));
  fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
  fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
  await fixture.engine.wake('startup');
  fixture.clock.now += 2_000;
  fixture.pullResponses.push(json(200, emptyPullPage('cursor-ordinary')));
  fixture.ackResponses.push(json(200, ack('cursor-ordinary')));
  await fixture.engine.wake('manual');
  await fixture.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: '1',
    remoteMountNodeId: 'mount-bar', boundaryVersion: '1', materialized: false,
    status: 'active', rootRole: 'bookmarks-bar' });
  fixture.crashAt = boundary;
  await assert.rejects(() => fixture.engine.wake('manual'), /worker_crash/);
  assert.ok((await fixture.store.getEngineState(scope))?.localProjectionOwner);
  fixture.clock.now += 60_000;
  return fixture;
}

for (const crash of [false, true]) {
  test(`mixed local and virtual mappings use the late-bound mount with empty selectedRoots (restart=${crash})`, async () => {
    const fixture = await setup({ snapshotRequired: true, emptyCollection: true,
      useVerifiedProjector: true, seedMount: false });
    try {
      fixture.snapshotResponses.push(json(200, nonemptyMountSnapshot(true)));
      fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
      fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
      await fixture.engine.wake('startup');
      // B already owns a local bookmark, while its authoritative remote mount
      // and remote children remain placeholders. The binding arrives later.
      fixture.chromeNodes.set('local-own', { id: 'local-own', parentId: '1', title: 'Only B', url: 'https://local.test/' });
      await fixture.store.putMapping(scope, { nativeId: 'local-own', colpId: 'local-own-colp', rootNativeId: '1',
        parentNativeId: '1', parentColpId: 'mount-bar', nodeKind: 'bookmark',
        projection: { revision: 'r-local', digest: 'sha256:local', content: { title: 'Only B', url: 'https://local.test/' } } });
      const { scopeKey: _key, rootRole: _role, ...mount } = (await fixture.store.getMappingByColpId(scope, 'mount-bar'))!;
      await fixture.store.putMapping(scope, { ...mount, projection: { ...mount.projection, content: { title: 'Bar' } } });
      await fixture.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'mount-bar',
        boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
      assert.deepEqual((await fixture.store.getScope(scope))?.selectedRoots, []);
      assert.equal(await leftoverVirtualChildrenNeedReproject(fixture.store, scope), true);
      fixture.clock.now += 2_000;
      fixture.pullResponses.push(json(200, emptyPullPage('cursor-late-bound')));
      fixture.ackResponses.push(json(200, ack('cursor-late-bound')));
      if (crash) {
        fixture.crashAt = 'after_local_projection';
        await assert.rejects(() => fixture.engine.wake('manual'), /worker_crash/);
        assert.ok((await fixture.store.getEngineState(scope))?.localProjectionOwner);
      }
      await fixture.reopen().wake('manual');
      const state = (await fixture.store.getEngineState(scope))!;
      assert.equal(state.recoveryFrozen, false, state.lastError);
      assert.equal(state.localProjectionOwner, undefined);
      assert.equal(state.lastError, undefined);
      assert.equal((await fixture.store.getMappingByColpId(scope, 'mount-bar'))?.nativeId, '1');
      const child = (await fixture.store.getMappingByColpId(scope, 'child-a'))!;
      assert.equal(fixture.chromeNodes.get(child.nativeId)?.parentId, '1');
      assert.equal([...fixture.chromeNodes.values()].filter((node) => node.title === 'Child').length, 1);
      assert.equal((await fixture.store.getMappingByColpId(scope, 'local-own-colp'))?.nativeId, 'local-own');
      assert.equal(await leftoverVirtualChildrenNeedReproject(fixture.store, scope), false);
    } finally { fixture.store.close(); }
  });
}

for (const blocker of ['no owner', 'identity unknown', 'snapshot staging', 'bootstrap Ack pending', 'authority unknown']) {
  test(`local projection does not clear freeze with ${blocker}`, async () => {
    const fixture = await interrupted(blocker === 'identity unknown' ? 'after_local_projection' : undefined);
    const state = (await fixture.store.getEngineState(scope))!;
    if (blocker === 'no owner') {
      const { localProjectionOwner: _owner, ...rest } = state;
      await fixture.store.transitionEngine(scope, rest);
    } else if (blocker === 'identity unknown') {
      const record = (await fixture.store.getScope(scope))!;
      await fixture.store.registerScope({ ...record, lifecycle: 'recovery_required' });
    } else if (blocker === 'snapshot staging') {
      await fixture.store.stageRecoveryPage(scope, { snapshotId: 'pending-snapshot', revision: 'r1',
        syncCursor: 'pending-cursor', identityDigest: 'sha256:identity', rootNodeId: 'root-server',
        page: 0, pageDigest: 'sha256:page', previousPageDigest: null, nextCursor: 'next', complete: false,
        sessionId: 'session-renewed', nodes: [] });
    } else if (blocker === 'bootstrap Ack pending') {
      await seedLegacySpc2Bootstrap(fixture.store);
    } else fixture.sessionFailures.push(new Error('session_invalid'));
    const calls = fixture.projectCalls;
    await fixture.reopen().wake('startup');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal(fixture.projectCalls, calls);
  });
}

test('local projection resumes nonterminal intent even after all child mappings are native', async () => {
  const fixture = await interrupted('after_local_projection');
  const intents = await fixture.store.listProjectionIntents(scope);
  const child = intents.find((intent) => intent.colpId === 'child-a')!;
  await fixture.store.settleProjectionIntent(scope, child.intentId, { state: 'executing' });
  fixture.pullResponses.push(json(200, emptyPullPage('cursor-resumed')));
  fixture.ackResponses.push(json(200, ack('cursor-resumed')));
  await fixture.reopen().wake('startup');
  assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, false);
  assert.equal((await fixture.store.getEngineState(scope))?.localProjectionOwner, undefined);
  assert.ok((await fixture.store.listProjectionIntents(scope)).every((intent) => intent.state === 'terminal'));
  assert.equal([...fixture.chromeNodes.values()].filter((node) => node.title === 'Child').length, 1);
});

test('an empty native read retains local projection recovery without inventing an identity failure', async () => {
  const fixture = await interrupted('after_local_projection');
  const intents = await fixture.store.listProjectionIntents(scope);
  await fixture.store.settleProjectionIntent(scope, intents[0]!.intentId, { state: 'executing' });
  fixture.chromeNodes.delete('1');
  await fixture.reopen().wake('startup');
  const state = (await fixture.store.getEngineState(scope))!;
  assert.equal(state.recoveryFrozen, true);
  assert.equal(state.authorityRefreshRequired, false);
  assert.equal(state.lastError, 'bookmark_lookup_empty');
  assert.ok(state.localProjectionOwner);
  const sessionCalls = fixture.sessionForces.length;
  fixture.clock.now += 60_000;
  await fixture.reopen().wake('startup');
  assert.equal((await fixture.store.getEngineState(scope))?.lastError, 'bookmark_lookup_empty');
  assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
  assert.ok(fixture.sessionForces.length > sessionCalls);
});

test('refreshing transport authority cannot clear an unproven deletion identity', async () => {
  const fixture = await interrupted('after_local_projection');
  const state = (await fixture.store.getEngineState(scope))!;
  await fixture.store.transitionEngine(scope, { phase: 'recovery', recoveryFrozen: true,
    authorityRefreshRequired: true, lastError: 'deletion_identity_unproven', notBefore: 0, updatedAt: state.updatedAt });
  const calls = fixture.sessionForces.length;
  await fixture.reopen().wake('manual');
  assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
  assert.equal((await fixture.store.getEngineState(scope))?.lastError, 'deletion_identity_unproven');
  assert.equal(fixture.sessionForces.length, calls);
});

for (const change of ['snapshot required', 'inactive lease', 'different lease', 'different generation', 'expired session']) {
  test(`owned freeze remains when current Session has ${change}`, async () => {
    const fixture = await interrupted('after_local_projection');
    const session: StoredSession = {
      credentialAuthorityDigest: 'sha256:test', sessionId: 'session-renewed', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
      acceptedProtocolVersion: '0.2', snapshotRequired: change === 'snapshot required',
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-ordinary', serverRevision: 'r1' },
      replicaLease: { leaseId: change === 'different lease' ? 'other' : 'lease-1',
        generation: change === 'different generation' ? '2' : '1',
        state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
      conversionPolicy: { separator: 'preserve_remote' },
    };
    if (change === 'inactive lease') Object.assign(session.replicaLease, { state: 'recovery_required' });
    const record = (await fixture.store.getScope(scope))!;
    await fixture.store.registerScope({ ...record, lease: { ...record.lease, generation: '1' } });
    await resumeLocalProjection({ store: fixture.store, scope, now: () => fixture.clock.now,
      snapshotProjector: async () => { throw new Error('unexpected_projection'); } }, async () => {
      if (change === 'expired session') throw new Error('session_invalid');
      return { credential: { accessToken: 'access-token' }, session };
    }).catch((error: Error) => { assert.equal(error.message, 'session_invalid'); });
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
  });
}

test('a concurrent revision during projection prevents local unfreeze', async () => {
  const fixture = await interrupted();
  await resumeLocalProjection({ store: fixture.store, scope, now: () => fixture.clock.now,
    snapshotProjector: async (mappings) => {
      const state = (await fixture.store.getEngineState(scope))!;
      await fixture.store.transitionEngine(scope, { ...state, phase: 'sleeping' });
      return mappings;
    } }, async () => ({ credential: { accessToken: 'access-token' }, session: {
      credentialAuthorityDigest: 'sha256:test', sessionId: 'session-renewed', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
      acceptedProtocolVersion: '0.2', snapshotRequired: false,
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-ordinary', serverRevision: 'r1' },
      replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
      conversionPolicy: { separator: 'preserve_remote' },
    } }));
  const state = (await fixture.store.getEngineState(scope))!;
  assert.equal(state.recoveryFrozen, true);
  assert.ok(state.localProjectionOwner);
});

test('protocol expiry takes precedence over an existing local projection owner', async () => {
  const fixture = await interrupted();
  const state = (await fixture.store.getEngineState(scope))!;
  await fixture.store.transitionEngine(scope, { ...state, lastError: 'sync_cursor_expired' });
  const calls = fixture.projectCalls;
  await fixture.reopen().wake('startup');
  const recovered = (await fixture.store.getEngineState(scope))!;
  assert.equal(recovered.recoveryFrozen, true);
  assert.equal(recovered.authorityRefreshRequired, true);
  assert.equal(recovered.localProjectionOwner, undefined);
  assert.equal(fixture.projectCalls, calls);
});

for (const confirmation of [undefined, 1]) {
  test(`startup resumes a sleeping owner before cooldown/confirmation ${confirmation}`, async () => {
    const fixture = await interrupted();
    const state = (await fixture.store.getEngineState(scope))!;
    await fixture.store.transitionEngine(scope, { ...state, phase: 'sleeping',
      notBefore: confirmation ? fixture.clock.now - 1 : fixture.clock.now + 30_000,
      ...(confirmation ? { connectivityConfirmationRevision: confirmation } : {}) });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-resumed')));
    fixture.ackResponses.push(json(200, ack('cursor-resumed')));
    await fixture.reopen().wake('startup');
    const resumed = (await fixture.store.getEngineState(scope))!;
    assert.equal(resumed.recoveryFrozen, false);
    assert.equal(resumed.localProjectionOwner, undefined);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-resumed');
    assert.equal([...fixture.chromeNodes.values()].filter((node) => node.title === 'Child').length, 1);
  });
}
