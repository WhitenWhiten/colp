import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import {
  ack, json, networkFailure, nonemptyMountSnapshot, problem, emptyPullPage, recoverySnapshot,
  scope, seedLegacySpc2Bootstrap, setup, snapshot,
} from './durable-sync-engine-harness.js';

describe('P3-33 durable extension bootstrap and empty-queue wake', () => {
  test('empty first-run Collection snapshot completes bootstrap and unfreezes without Chrome identity', async () => {
    const fixture = await setup({ snapshotRequired: true, emptyCollection: true, useVerifiedProjector: true });
    fixture.snapshotResponses.push(json(200, snapshot(1, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('startup');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.ackIntents.at(-1)?.state, 'complete');
    assert.equal(exported.mappings.map((item: { colpId: string }) => item.colpId).join(), 'root-server');
    assert.equal(fixture.snapshotRequests.length, 1);
  });

  test('nonempty second-replica snapshot completes bootstrap without inventing mount folders', async () => {
    const fixture = await setup({ snapshotRequired: true, emptyCollection: true, useVerifiedProjector: true, confirmedMount: true });
    fixture.snapshotResponses.push(json(200, nonemptyMountSnapshot(true)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('startup');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.ackIntents.at(-1)?.state, 'complete');
    assert.equal((await fixture.store.listMountBindings(scope))[0]?.remoteMountNodeId, 'mount-bar');
    const child = exported.mappings.find((item: { colpId: string }) => item.colpId === 'child-a');
    assert.equal(child?.nativeId.startsWith('recovery:'), false);
    assert.ok(child?.nativeId);
    assert.equal([...fixture.chromeNodes.values()].filter(row => row.title === 'Child').length, 1);
    assert.equal([...fixture.chromeNodes.values()].filter(row => row.title === 'Bookmarks bar').length, 1);
  });

  test('a pending bootstrap mount keeps the complete canonical Snapshot but grants no native download authority', async () => {
    const fixture = await setup({ snapshotRequired: true, emptyCollection: true, confirmedMount: false });
    try {
      fixture.snapshotResponses.push(json(200, nonemptyMountSnapshot(true)));
      fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
      fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
      await fixture.engine.wake('startup');
      const exported = await fixture.store.exportScope(scope);
      assert.equal(exported.engine.phase, 'sleeping'); assert.equal(exported.engine.recoveryFrozen, false);
      assert.equal(exported.ackIntents.at(-1)?.state, 'complete');
      assert.equal((await fixture.store.listMountBindings(scope))[0]?.status, 'pending');
      assert.equal((await fixture.store.listMountBindings(scope))[0]?.remoteMountNodeId, 'mount-bar');
      assert.equal(exported.mappings.find(row => row.colpId === 'child-a')?.nativeId, 'recovery:child-a');
      assert.deepEqual([...fixture.chromeNodes.values()], [{ id: '1', title: 'Bookmarks bar' }]);
      assert.deepEqual(exported.queue, []); assert.deepEqual(exported.receipts, []);
    } finally { fixture.store.close(); }
  });

  test('reprojects leftover virtual children on a later wake after the bar mount binds', async () => {
    const fixture = await setup({
      snapshotRequired: true, emptyCollection: true, useVerifiedProjector: true, seedMount: false,
    });
    fixture.snapshotResponses.push(json(200, nonemptyMountSnapshot(true)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('startup');
    let exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(fixture.projectCalls, 1);
    assert.equal(fixture.snapshotRequests.length, 1);
    const before = new Map(exported.mappings.map((row: { colpId: string; nativeId: string }) => [row.colpId, row]));
    assert.equal(before.get('child-a')?.nativeId.startsWith('recovery:'), true);
    assert.equal([...fixture.chromeNodes.values()].some((node) => node.title === 'Child'), false);
    await fixture.store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'mount-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-bind')));
    fixture.ackResponses.push(json(200, ack('cursor-after-bind')));
    await fixture.engine.wake('manual');
    exported = await fixture.store.exportScope(scope);
    const after = new Map(exported.mappings.map((row: { colpId: string; nativeId: string }) => [row.colpId, row]));
    assert.equal(fixture.snapshotRequests.length, 1);
    assert.ok(fixture.projectCalls >= 2);
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(after.get('mount-bar')?.nativeId, '1');
    assert.equal(after.get('child-a')?.nativeId.startsWith('recovery:'), false);
    assert.ok(after.get('child-a')?.nativeId);
    assert.equal(fixture.chromeNodes.get(after.get('child-a')!.nativeId)?.parentId, '1');
    assert.equal(fixture.chromeNodes.get(after.get('child-a')!.nativeId)?.title, 'Child');
    assert.equal([...fixture.chromeNodes.values()].some((node) => node.title === 'Bar' && node.id !== '1'), false);
    assert.equal([...fixture.chromeNodes.values()].some((node) => node.title === 'Bookmarks bar' && node.id !== '1'), false);
  });

  for (const boundary of ['before_local_projection', 'after_local_projection']) {
    test(`resumes ${boundary} after the current cursor has advanced beyond bootstrap`, async () => {
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
      assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
      fixture.store.close(); fixture.clock.now += 2_000;
      fixture.pullResponses.push(json(200, emptyPullPage('cursor-resumed')));
      fixture.ackResponses.push(json(200, ack('cursor-resumed')));
      await fixture.reopen().wake('startup');
      const exported = await fixture.store.exportScope(scope);
      assert.equal(exported.engine.recoveryFrozen, false);
      assert.equal(exported.engine.phase, 'sleeping');
      assert.equal(fixture.snapshotRequests.length, 1);
      const child = exported.mappings.find((row: { colpId: string }) => row.colpId === 'child-a');
      assert.ok(child?.nativeId && !child.nativeId.startsWith('recovery:'));
      assert.equal([...fixture.chromeNodes.values()].filter((node) => node.title === 'Child').length, 1);
      assert.equal(exported.cursor?.cursor, 'cursor-resumed');
    });
  }

  test('reprojects leftover virtual children when a completed bootstrap Ack unfreezes leftover freeze', async () => {
    const fixture = await setup({
      snapshotRequired: false, emptyCollection: true, useVerifiedProjector: true, seedMount: false,
    });
    const snapshotId = 'snapshot-leftover'; const cursor = 'bootstrap-cursor'; const sessionId = 'session-engine';
    await fixture.store.stageRecoveryPage(scope, {
      snapshotId, revision: 'revision-snapshot', syncCursor: cursor, identityDigest: 'sha256:leftover',
      rootNodeId: 'root-colp', page: 0, pageDigest: 'sha256:leftover-page', previousPageDigest: null,
      nextCursor: null, complete: true, sessionId, nodes: [{
        colpId: 'root-colp', parentId: null, position: 'p0', kind: 'Folder', payloadDigest: 'sha256:root-colp',
        mapping: { nativeId: 'recovery:root-colp', colpId: 'root-colp', rootNativeId: 'recovery:root', nodeKind: 'folder',
          projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
            content: { title: '', folderRole: 'root' } } },
      }, {
        colpId: 'mount-bar', parentId: 'root-colp', position: 'p1', kind: 'Folder', payloadDigest: 'sha256:mount-bar',
        mapping: { nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root', nodeKind: 'folder',
          parentColpId: 'root-colp', rootRole: 'bookmarks-bar',
          projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
            content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } } },
      }, {
        colpId: 'child-a', parentId: 'mount-bar', position: 'p2', kind: 'Bookmark', payloadDigest: 'sha256:child-a',
        mapping: { nativeId: 'recovery:child-a', colpId: 'child-a', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
          parentColpId: 'mount-bar', projection: { revision: 'r-child', digest: 'sha256:child',
            content: { title: 'Child', url: 'https://example.test/child' } } },
      }],
    });
    const body = JSON.stringify({ sessionId, cursor, warnings: [] });
    await fixture.store.commitRecovery(scope, snapshotId, {
      intentId: 'ack-leftover', sessionId, idempotencyKey: 'ack-leftover',
      endpointIdentity: 'syncAck', mediaType: 'application/json', body,
      bodyDigest: createHash('sha256').update(body).digest('hex'),
    });
    await fixture.store.completeAckIntent(scope, 'ack-leftover', ack(cursor));
    await fixture.store.putMapping(scope, {
      nativeId: '1', colpId: 'mount-bar', rootNativeId: '1', nodeKind: 'folder', parentColpId: 'root-colp',
      rootRole: 'bookmarks-bar', mountId: 'mount-bar',
      projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
        content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } },
    });
    await fixture.store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'mount-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await fixture.store.transitionEngine(scope, {
      phase: 'recovery', updatedAt: fixture.clock.now, recoveryFrozen: true,
      authorityRefreshRequired: false, notBefore: 0, sessionId,
    });
    assert.equal((await fixture.store.getMappingByColpId(scope, 'child-a'))?.nativeId.startsWith('recovery:'), true);
    await fixture.engine.wake('manual');
    const exported = await fixture.store.exportScope(scope);
    const child = exported.mappings.find((row: { colpId: string }) => row.colpId === 'child-a');
    const leftoverLive = exported.mappings.some((row: { nativeId: string; colpId: string }) =>
      row.nativeId.startsWith('recovery:') && row.colpId === 'child-a');
    assert.ok(fixture.projectCalls >= 1);
    assert.equal(fixture.snapshotRequests.length, 0);
    assert.equal(child?.nativeId.startsWith('recovery:'), false);
    assert.ok(child?.nativeId);
    assert.equal(leftoverLive && exported.engine.recoveryFrozen === false, false);
    assert.equal(fixture.chromeNodes.get(child!.nativeId)?.parentId, '1');
    assert.equal(fixture.chromeNodes.get(child!.nativeId)?.title, 'Child');
  });

  test('completed bootstrap unfreeze without leftover children does not require a projector', async () => {
    const fixture = await setup({ snapshotRequired: true });
    await seedLegacySpc2Bootstrap(fixture.store);
    await fixture.store.completeAckIntent(scope, 'legacy-spc2-intent', ack('bootstrap-cursor'));
    await fixture.store.transitionEngine(scope, {
      phase: 'recovery', updatedAt: fixture.clock.now, recoveryFrozen: true,
      authorityRefreshRequired: false, notBefore: 0, sessionId: 'session-engine',
    });
    await fixture.engine.wake('manual');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(fixture.projectCalls, 0);
    assert.equal(fixture.snapshotRequests.length, 0);
  });

  test('renews bootstrap authority through the cursor recovery capability after a pending Ack completes', async () => {
    const fixture = await setup({ snapshotRequired: true });
    await seedLegacySpc2Bootstrap(fixture.store);
    await fixture.store.transitionEngine(scope, {
      phase: 'sleeping', updatedAt: fixture.clock.now, recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 0, sessionId: 'session-engine',
    });
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    await fixture.engine.wake('manual');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.engine.sessionId, 'session-renewed');
    assert.equal(exported.cursor.cursor, 'cursor-recovered');
  });

  test('discards a stale bootstrap Ack capability and takes a fresh frozen Snapshot', async () => {
    const fixture = await setup({ snapshotRequired: true, useStandInProjector: true });
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-2')),
      json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('startup'); let exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.phase, 'recovery'); assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.ackIntents.length, 0); assert.equal(exported.cursor?.cursor, 'bootstrap-cursor');
    assert.equal((exported.cursor!.evidence as { readonly capability?: unknown }).capability,
      'src1.recovery-capability');
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-2')),
      json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.clock.now += 1_000;
    await fixture.engine.wake('online'); exported = await fixture.store.exportScope(scope);
    assert.equal(exported.ackIntents.at(-1)?.state, 'complete'); assert.equal(exported.engine.recoveryFrozen, false);
    assert.deepEqual(fixture.sessionForces, [false, true, true]);
    assert.equal(exported.engine.sessionId, 'session-renewed');
    assert.equal(exported.cursor.cursor, 'cursor-recovered');
  });

  test('renews recovery authority after bootstrap Ack before allowing normal traffic', async () => {
    const fixture = await setup({ snapshotRequired: true, useStandInProjector: true });
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-2')),
      json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    await fixture.engine.wake('startup'); const recovered = await fixture.store.exportScope(scope);
    assert.deepEqual(fixture.sessionForces, [false, true]);
    assert.equal(recovered.engine.recoveryFrozen, false); assert.equal(recovered.engine.sessionId, 'session-renewed');
    assert.equal(recovered.cursor.cursor, 'cursor-recovered');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-bootstrap')));
    fixture.ackResponses.push(json(200, ack('cursor-after-bootstrap')));
    fixture.clock.now = recovered.engine.notBefore;
    await fixture.engine.wake('manual');
    assert.equal(new URL(fixture.pullRequests[0]!).searchParams.get('sessionId'), 'session-renewed');
    assert.equal(new URL(fixture.pullRequests[0]!).searchParams.get('cursor'), 'cursor-recovered');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-second-pull')));
    fixture.ackResponses.push(json(200, ack('cursor-after-second-pull')));
    fixture.clock.now = (await fixture.store.getEngineState(scope))!.notBefore;
    await fixture.engine.wake('manual');
    assert.equal(new URL(fixture.pullRequests[1]!).searchParams.get('sessionId'), 'session-renewed');
    assert.equal(new URL(fixture.pullRequests[1]!).searchParams.get('cursor'), 'cursor-after-bootstrap');
    assert.equal((await fixture.store.exportScope(scope)).cursor.cursor, 'cursor-after-second-pull');
  });

  test('rejects a mixed Snapshot revision chain without changing live mapping or cursor authority', async () => {
    const fixture = await setup({ snapshotRequired: true });
    fixture.snapshotResponses.push(json(200, snapshot(1, true, 'page-2')),
      json(200, { ...snapshot(2, false, null), revision: 'revision-other' }));
    await fixture.engine.wake('startup'); const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.phase, 'recovery'); assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.cursor, null); assert.deepEqual(exported.mappings.map((item: any) => item.colpId), ['root-old']);
    assert.equal(exported.ackIntents.length, 0);
  });

  test('rejects duplicate Snapshot node identity across pages before cutover', async () => {
    const fixture = await setup({ snapshotRequired: true }); const repeated = snapshot(2, false, null);
    repeated.nodes[0] = { ...snapshot(1, true, 'page-2').nodes[0]! };
    repeated.parentRevisions = [{ parentId: 'root-server', childrenRevision: 'children-root' }];
    fixture.snapshotResponses.push(json(200, snapshot(1, true, 'page-2')), json(200, repeated));
    await fixture.engine.wake('startup'); const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.phase, 'recovery'); assert.deepEqual(exported.mappings.map((item: any) => item.colpId), ['root-old']);
    assert.equal(exported.ackIntents.length, 0);
  });

  test('keeps Ack pending when a schema-valid receipt names another replica', async () => {
    const fixture = await setup(); fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, { ...ack('cursor-1'), replicaId: 'replica-other' }));
    await fixture.engine.wake('alarm'); const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.ackIntents[0]!.state, 'pending'); assert.notEqual(exported.engine.lastAckedCursor, 'cursor-1');
  });

  test('repairs engine cursor authority when restart observes an already-complete deterministic Ack intent', async () => {
    const fixture = await setup(); fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));
    await fixture.engine.wake('alarm');
    await fixture.store.transitionEngine(scope, { phase: 'acking', updatedAt: fixture.clock.now,
      recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0, sessionId: 'session-engine',
      lastPublishedCursor: 'cursor-1' });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.store.close(); await fixture.reopen().wake('startup');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.ackIntents[0]!.state, 'complete');
    assert.equal(exported.engine.lastPublishedCursor, 'cursor-1');
    assert.equal(exported.engine.lastAckedCursor, 'cursor-1');
  });

  test('offline jitter cooldown is durable across alarm wakes with an empty live queue', async () => {
    const fixture = await setup(); fixture.pullResponses.push(networkFailure('offline'));
    await fixture.engine.wake('alarm'); const first = (await fixture.store.exportScope(scope)).engine;
    assert.equal(first.phase, 'offline'); assert.ok(first.notBefore > fixture.clock.now);
    assert.ok(first.notBefore - fixture.clock.now <= 30_000);
    fixture.store.close(); const reopened = await fixture.reopen();
    await reopened.wake('alarm');
    assert.equal(fixture.pullRequests.length, 1); assert.equal(fixture.scheduled.at(-1), first.notBefore - fixture.clock.now);
  });

  test('manual and confirmed-online wakes Pull inbound while offline with an empty live queue', async () => {
    for (const [reason, context] of [
      ['manual', {}], ['online', { connectivityRestored: true }], ['startup', {}],
    ] as const) {
      const fixture = await setup();
      fixture.pullResponses.push(networkFailure('offline'), json(200, emptyPullPage(`cursor-empty-${reason}`)));
      fixture.ackResponses.push(json(200, ack(`cursor-empty-${reason}`)));
      await fixture.engine.wake('alarm');
      const offline = (await fixture.store.getEngineState(scope))!;
      assert.equal(offline.phase, 'offline', reason);
      assert.equal(offline.lastError, 'network_unavailable', reason);
      assert.ok(offline.notBefore > fixture.clock.now, reason);

      await fixture.engine.wake(reason, context);
      assert.ok(fixture.pullRequests.length >= 2, reason);
      assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping', reason);
    }
  });

  test('confirmed online Pulls inbound while sleeping with an empty live queue before notBefore', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-sleep-empty')));
    fixture.ackResponses.push(json(200, ack('cursor-sleep-empty')));
    await fixture.engine.wake('alarm');
    const sleeping = (await fixture.store.getEngineState(scope))!;
    assert.equal(sleeping.phase, 'sleeping');
    assert.ok(sleeping.notBefore > fixture.clock.now);
    const pullsAfterIdle = fixture.pullRequests.length;
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-sleep-empty-2')));
    fixture.ackResponses.push(json(200, ack('cursor-sleep-empty-2')));
    await fixture.engine.wake('online', { connectivityRestored: true });
    assert.ok(fixture.pullRequests.length > pullsAfterIdle);
    assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping');
  });

  test('manual wake Pulls inbound while offline with constraint_error and an empty live queue', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-constraint')));
    fixture.ackResponses.push(json(200, ack('cursor-constraint')));
    await fixture.store.transitionEngine(scope, { phase: 'offline', updatedAt: fixture.clock.now,
      recoveryFrozen: false, authorityRefreshRequired: false, notBefore: fixture.clock.now + 60_000,
      lastError: 'constraint_error' });
    await fixture.engine.wake('manual');
    assert.ok(fixture.pullRequests.length >= 1);
    assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping');
  });

  test('a later explicit wake does not busy-loop Pull after a complete empty-queue sleep', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-idle')));
    fixture.ackResponses.push(json(200, ack('cursor-idle')));
    await fixture.engine.wake('alarm');
    const sleeping = (await fixture.store.getEngineState(scope))!;
    assert.equal(sleeping.phase, 'sleeping');
    assert.ok(sleeping.notBefore > fixture.clock.now);
    assert.equal(fixture.pullRequests.length, 1);

    await fixture.engine.wake('manual');
    await fixture.engine.wake('alarm');
    assert.equal(fixture.pullRequests.length, 1);
    assert.equal((await fixture.store.getEngineState(scope))!.notBefore, sleeping.notBefore);
  });

  test('manual and confirmed-online wakes resume outstanding Push through an offline network backoff', async () => {
    for (const [reason, context] of [
      ['manual', {}], ['online', { connectivityRestored: true }],
    ] as const) {
      const fixture = await setup();
      await fixture.enqueue(`op-offline-${reason}-1`);
      fixture.push.outcomes.push('unknown');
      fixture.pullResponses.push(networkFailure('offline'), json(200, emptyPullPage(`cursor-${reason}`)));
      fixture.ackResponses.push(json(200, ack(`cursor-${reason}`)));
      await fixture.engine.wake('alarm');
      const offline = (await fixture.store.getEngineState(scope))!;
      assert.equal(offline.phase, 'offline', reason);
      assert.equal(offline.lastError, 'network_unavailable', reason);
      assert.ok(offline.notBefore > fixture.clock.now, reason);

      fixture.push.outcomes.push('terminal');
      await fixture.engine.wake(reason, context);
      assert.ok(fixture.push.calls >= 2, reason);
      assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping', reason);
    }
  });

  test('local work bypasses a healthy sleeping Pull cooldown after manual, startup or confirmed-online wakes', async () => {
    for (const [reason, context] of [
      ['manual', {}], ['startup', {}], ['online', { connectivityRestored: true }],
    ] as const) {
      const fixture = await setup(); fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
      fixture.ackResponses.push(json(200, ack('cursor-1'))); await fixture.engine.wake('alarm');
      const sleeping = (await fixture.store.getEngineState(scope))!;
      assert.equal(sleeping.phase, 'sleeping', reason); assert.equal(sleeping.lastError, undefined, reason);
      assert.ok(sleeping.notBefore > fixture.clock.now, reason);

      await fixture.enqueue(`op-${reason}-1`); fixture.pullResponses.push(json(200, emptyPullPage('cursor-2')));
      fixture.ackResponses.push(json(200, ack('cursor-2'))); await fixture.engine.wake(reason, context);
      assert.ok(fixture.push.calls >= 1, reason); assert.equal(fixture.pullRequests.length, 2, reason);
    }
  });

  test('property-style crashes at each network boundary converge without Ack-before-cursor', async () => {
    for (const boundary of ['before_pull', 'after_pull', 'after_pull_apply', 'before_ack', 'after_ack'] as const) {
      const fixture = await setup(); fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
      fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
      fixture.ackResponses.push(json(200, ack('cursor-1')), json(200, ack('cursor-1'))); fixture.crashAt = boundary;
      await assert.rejects(() => fixture.engine.wake('alarm'), /worker_crash/); fixture.crashAt = undefined;
      fixture.store.close(); await fixture.reopen().wake('startup');
      const exported = await fixture.store.exportScope(scope);
      assert.ok(exported.ackIntents.length === 0 || exported.cursor?.cursor === exported.ackIntents[0]!.cursor);
      assert.equal(exported.engine.phase, 'sleeping'); assert.equal(exported.engine.lastAckedCursor, 'cursor-1');
    }
  });

  test('abandons a durable pull Ack denied for a dead Session and converges through refreshed Session authority', async () => {
    const fixture = await setup(); fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(networkFailure());
    await fixture.engine.wake('alarm'); const durableRetry = fixture.ackRequests[0]!;
    fixture.clock.now = (await fixture.store.getEngineState(scope))!.notBefore;
    fixture.sessionId = 'session-renewed';
    fixture.ackResponses.push(problem(404, 'resource_not_found', {}));
    fixture.store.close(); const engine = fixture.reopen(); await engine.wake('startup');
    // The exact durable request is retried once, then dropped; the wake stops
    // instead of Pulling under the dead Session and asks for fresh authority.
    assert.equal(fixture.ackRequests.length, 2);
    assert.deepEqual(fixture.ackRequests[1], durableRetry);
    assert.equal(fixture.pullRequests.length, 1);
    const frozen = await fixture.store.exportScope(scope);
    assert.equal(frozen.ackIntents.length, 0);
    assert.equal(frozen.engine.phase, 'recovery'); assert.equal(frozen.engine.recoveryFrozen, true);
    assert.equal(frozen.engine.authorityRefreshRequired, true);
    assert.equal(frozen.engine.lastError, 'pull_ack_discarded');

    fixture.forcedSessions.push({ sessionId: 'session-fresh', state: 'active',
      snapshotRequired: false, cursor: 'cursor-1-reissued' });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1-reissued')));
    fixture.clock.now += 30_000; await engine.wake('alarm');
    // The refreshed Session's cursor counts as acknowledged: no further Ack.
    assert.equal(fixture.ackRequests.length, 2);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor.cursor, 'cursor-1-reissued');
    assert.equal(exported.engine.phase, 'sleeping'); assert.equal(exported.engine.sessionId, 'session-fresh');
    assert.equal(exported.engine.lastAckedCursor, 'cursor-1-reissued');
    assert.equal(exported.engine.recoveryFrozen, false); assert.equal(fixture.snapshotRequests.length, 0);
  });

  test('escalates an expired pull Ack cursor into recovery instead of retrying the dead intent forever', async () => {
    const fixture = await setup(); fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(networkFailure());
    await fixture.engine.wake('alarm');
    fixture.clock.now = (await fixture.store.getEngineState(scope))!.notBefore;
    fixture.ackResponses.push(problem(410, 'sync_cursor_expired', {}));
    fixture.store.close(); await fixture.reopen().wake('startup');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.ackIntents.length, 0);
    assert.equal(fixture.ackRequests.length, 2);
    // A discarded Ack stops the wake; the next one renews Session authority before any Pull.
    assert.equal(fixture.pullRequests.length, 1);
    assert.equal(exported.engine.phase, 'recovery');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    assert.equal(exported.engine.lastError, 'pull_ack_discarded');
  });

  test('persists the real Problem code for a non-recovery Pull 410 without freezing recovery authority', async () => {
    const fixture = await setup(); fixture.pullResponses.push(problem(410, 'replica_retired', {}));
    await fixture.engine.wake('alarm');
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'offline');
    assert.equal(state.lastError, 'replica_retired');
    assert.equal(state.recoveryFrozen, false);
    assert.equal(state.authorityRefreshRequired, false);
    assert.equal(fixture.snapshotRequests.length, 0);
  });

  test('account switch and retired identities never share or revive lifecycle state', async () => {
    const fixture = await setup(); await fixture.store.retireScope(scope, { retiredAt: 10, reason: 'reinstall' });
    await fixture.engine.wake('startup'); assert.equal((await fixture.store.exportArchive(scope)).lifecycle, 'retired');
    const next = { ...scope, accountId: 'account-next', replicaId: 'replica-next', generation: 2 };
    await fixture.store.registerScope({ ...next, lifecycle: 'active', lease: { leaseId: 'lease-next', expiresAt: 99_999 },
      checkpoint: { serverRevision: 'revision-next', cursor: 'cursor-next' }, selectedRoots: [] });
    assert.equal((await fixture.store.exportScope(next)).ackIntents.length, 0);
  });
});
