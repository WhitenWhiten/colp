import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ack, emptyPullPage, json, nonemptyMountSnapshot, scope, setup } from './durable-sync-engine-harness.js';

test('an existing frozen complete snapshot resumes after upgrade, acknowledges and creates a long-URL bookmark once', async () => {
  const fixture = await setup({ snapshotRequired: true, emptyCollection: true, useVerifiedProjector: true, confirmedMount: true });
  const page = nonemptyMountSnapshot(true);
  const longUrl = 'https://example.test/' + 'x'.repeat(1971);
  page.nodes[2] = { ...page.nodes[2]!, kind: 'bookmark', title: 'Long URL', url: longUrl };
  fixture.snapshotResponses.push(json(200, page));
  fixture.crashAt = 'after_snapshot_page';
  await assert.rejects(fixture.engine.wake('manual'), /worker_crash/);
  await fixture.store.transitionEngine(scope, { phase: 'recovery', recoveryFrozen: true,
    authorityRefreshRequired: false, updatedAt: fixture.clock.now, notBefore: 0, lastError: 'bounded_string_invalid' });
  fixture.store.close();
  fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
  fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
  await fixture.reopen().wake('startup');
  assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, false);
  assert.equal((await fixture.store.listAckIntents(scope)).at(-1)?.state, 'complete');
  assert.equal(fixture.snapshotRequests.length, 1, 'resumes the already downloaded snapshot');
  assert.equal([...fixture.chromeNodes.values()].filter(node => node.url === longUrl).length, 1);
  fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-restart')));
  fixture.ackResponses.push(json(200, ack('cursor-after-restart')));
  await fixture.reopen().wake('manual');
  assert.equal([...fixture.chromeNodes.values()].filter(node => node.url === longUrl).length, 1);
  fixture.store.close();
});

test('resuming the same interrupted Snapshot never promotes an unconfirmed pending mount', async () => {
  const fixture = await setup({ snapshotRequired: true, emptyCollection: true, confirmedMount: false });
  try {
    fixture.snapshotResponses.push(json(200, nonemptyMountSnapshot(true)));
    fixture.crashAt = 'after_snapshot_page';
    await assert.rejects(fixture.engine.wake('manual'), /worker_crash/);
    await fixture.store.transitionEngine(scope, { phase: 'recovery', recoveryFrozen: true,
      authorityRefreshRequired: false, updatedAt: fixture.clock.now, notBefore: 0, lastError: 'bounded_string_invalid' });
    fixture.store.close();
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.reopen().wake('startup');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, false);
    assert.equal((await fixture.store.listAckIntents(scope)).at(-1)?.state, 'complete');
    assert.equal(fixture.snapshotRequests.length, 1, 'reuses the complete staged Snapshot');
    assert.equal((await fixture.store.listMountBindings(scope))[0]?.status, 'pending');
    assert.equal((await fixture.store.getMappingByColpId(scope, 'child-a'))?.nativeId, 'recovery:child-a');
    assert.deepEqual([...fixture.chromeNodes.values()], [{ id: '1', title: 'Bookmarks bar' }]);
    assert.deepEqual((await fixture.store.exportScope(scope)).queue, []);
    assert.deepEqual((await fixture.store.exportScope(scope)).receipts, []);
  } finally { fixture.store.close(); }
});
