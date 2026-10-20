import { verifySyncResilienceCase } from '../../conformance/src/sync-resilience.mjs';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setup, scope, json, nonemptyMountSnapshot, ack } from './durable-sync-engine-harness.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';

for (const field of ['title', 'description'] as const) for (const restart of [false, true]) {
  test(`Snapshot quarantines ${field}, retains graph, and projects independent nodes (restart=${restart})`, async () => {
    const f = await setup({ snapshotRequired: true, emptyCollection: true, confirmedMount: true });
    try {
      const snapshot: any = nonemptyMountSnapshot();
      const bad = snapshot.nodes.find((node: any) => node.id === 'child-a');
      bad.kind = 'folder'; delete bad.url; bad[field] = 'x'.repeat(300_000);
      snapshot.parentRevisions.push({ parentId: bad.id, childrenRevision: 'bad-children' });
      snapshot.nodes.push({ ...bad, id: 'blocked-child', parentId: bad.id, position: 'p1', kind: 'bookmark',
        title: 'Blocked descendant', description: '', url: 'https://blocked.test/' });
      snapshot.nodes.push({ ...snapshot.nodes[2], id: 'good', parentId: 'mount-bar', position: 'p3', kind: 'bookmark',
        title: 'Independent', description: '', url: 'https://independent.test/' });
      if (restart) f.crashAt = 'after_snapshot_page';
      f.snapshotResponses.push(json(200, snapshot)); f.ackResponses.push(json(200, ack('bootstrap-cursor')));
      if (restart) await assert.rejects(f.engine.wake('manual'), /worker_crash/u);
      else await f.engine.wake('manual');
      if (restart) { f.store.close(); f.clock.now += 30_000; await f.reopen().wake('startup'); }
      const state = await f.store.getEngineState(scope);
      assert.notEqual(state?.phase, 'error'); assert.equal(state?.recoveryFrozen, false);
      const issues = await f.store.listPullIssues(scope);
      assert.equal(issues[0]?.nodeId, 'child-a'); assert.equal(issues[0]?.code, 'record_too_large');
      const mapping = (await f.store.getMappingByColpId(scope, 'child-a'))!;
      assert.ok(mapping.quarantine); assert.match(mapping.nativeId, /^sidecar:quarantine:/u);
      assert.equal(mapping.projection.content, undefined, 'no invented content baseline');
      assert.ok(mapping.quarantine.payloadDigest);
      assert.deepEqual(verifySyncResilienceCase('SYNC-0042', { issues, mapping, graph: await f.store.listMappings(scope),
        nativeTitles: [...f.chromeNodes.values()].map(node => node.title), storedBytes: JSON.stringify(await f.store.exportScope(scope)).length,
        originalBytes: JSON.stringify(snapshot).length, state, ackWarnings: JSON.parse(f.ackRequests[0]!.body).warnings }), []);
      assert.ok(![...f.chromeNodes.values()].some(node => node.title === 'Blocked descendant'));
      assert.ok([...f.chromeNodes.values()].some(node => node.title === 'Independent'));
      assert.ok((await readOpenSyncIssues(f.store, scope)).roots.has('child-a'));
      assert.ok(JSON.stringify(await f.store.exportScope(scope)).length < 50_000, 'bounded evidence, not the unstoreable payload');
      assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-recovered');
      if (field === 'title' && !restart) {
        await freezeScopeRecovery(f.store, scope, 'sync_cursor_expired', () => f.clock.now);
        f.forcedSessions.push({ snapshotRequired: true, state: 'recovery_required', cursor: 'bootstrap-cursor' });
        snapshot.snapshotId = 'snapshot-again'; snapshot.recoveryCapability = 'src1.again';
        f.snapshotResponses.push(json(200, snapshot)); f.ackResponses.push(json(200, ack('bootstrap-cursor')));
        f.clock.now += 30_000; await f.reopen().wake('manual');
        assert.notEqual((await f.store.getEngineState(scope))?.phase, 'error');
        assert.equal((await f.store.listPullIssues(scope)).length, 1);
        assert.equal([...f.chromeNodes.values()].filter(node => node.title === 'Independent').length, 1);
      }
    } finally { f.store.close(); }
  });
}

test('oversized content cannot conceal a broken Snapshot graph', async () => {
  const f = await setup({ snapshotRequired: true, emptyCollection: true });
  try {
    const snapshot: any = nonemptyMountSnapshot();
    snapshot.nodes[2].title = 'x'.repeat(300_000); snapshot.nodes[2].parentId = 'missing-parent';
    f.snapshotResponses.push(json(200, snapshot), json(200, snapshot));
    const state = await f.engine.wake('manual');
    assert.equal(state?.recoveryFrozen, true);
    assert.equal((await f.store.listPullIssues(scope)).length, 0);
    assert.equal((await f.store.getCursor(scope))?.cursor, undefined);
  } finally { f.store.close(); }
});
