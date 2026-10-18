import { verifySyncResilienceCase } from '../../conformance/src/sync-resilience.mjs';
import { MemoryStorageArea } from '../src/credential-store.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { terminalFreezeReasonCopy } from '../src/sync-attention-ui.js';
import { enforceSyncIssueCeiling } from '../src/sync-issue-ceiling.js';
import { setup as pullSetup, scope as pullScope, installKns05IndexedDb } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setup, scope } from './durable-sync-engine-harness.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';

installKns05IndexedDb();

for (const direction of ['local', 'push', 'mixed'] as const) test(`global ceiling catches ${direction} issues on restart without another Pull issue`, async () => {
  const f = await setup({ useRealPullApplier: true });
  try {
    for (let i = 0; i < 201; i++) {
      if (direction === 'local' || direction === 'mixed' && i % 2 === 0) {
        await f.store.recordLocalIssue(scope, { nativeId: `native-${i}`, code: 'recovery_identity_unproven', now: i });
      } else {
        const row = await f.enqueue(`issue-${i}`);
        await f.store.setAsideQueue(scope, [row.sequence], 'create_placement_unproven');
      }
    }
    if (direction !== 'push') for (let i = 0; i < 5; i++) await f.store.recordLocalIssue(scope, { nativeId: 'native-0', code: 'recovery_identity_unproven', now: 300 + i });
    assert.equal((await readOpenSyncIssues(f.store, scope)).total, 201);
    f.store.close(); await f.reopen().wake('startup');
    const state = await f.store.getEngineState(scope);
    assert.equal(state?.lastError, 'sync_issue_ceiling'); assert.equal(state?.phase, 'error');
    assert.equal(f.pullRequests.length, 0); assert.equal(f.push.calls, 0);
    const status = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    assert.ok(status.ok && status.attention.issueCount === 201 && status.attention.rebuildAvailable);
    assert.match(terminalFreezeReasonCopy('sync_issue_ceiling'), /too many/u);
    if (direction === 'local') {
      let health: any;
      await sendReplicaHealthReport({ scope, store: f.store, mode: async () => 'enabled',
        credential: async () => ({ accessToken: 'fixture', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
        storage: new MemoryStorageArea(), origin: 'chrome-extension://fixture', now: () => 2000,
        fetch: async (_url, init) => { health = JSON.parse(String(init?.body)); return Response.json({ accepted: true, commands: [] }); } });
      assert.equal(health.state, 'stopped'); assert.equal(health.code, 'sync_issue_ceiling');
      assert.equal(health.issues.total, 201); assert.deepEqual(health.actions, ['rebuild']);
      assert.deepEqual(verifySyncResilienceCase('SYNC-0043', { total: (await readOpenSyncIssues(f.store, scope)).total,
        issues: await f.store.listLocalIssues(scope), state, pullRequests: f.pullRequests, health }), []);
    }
    assert.equal((await readOpenSyncIssues(f.store, scope)).total, 201);
  } finally { f.store.close(); }
});

test('the threshold is strictly more than 200 distinct open facts', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 200; i++) await f.store.recordLocalIssue(scope, { nativeId: `n-${i}`, code: 'recovery_identity_unproven', now: i });
    assert.equal(await enforceSyncIssueCeiling(f.store, scope), false);
    await f.store.recordLocalIssue(scope, { nativeId: 'n-0', code: 'recovery_identity_unproven', now: 300 });
    assert.equal(await enforceSyncIssueCeiling(f.store, scope), false);
    await f.store.recordLocalIssue(scope, { nativeId: 'new-subject', code: 'recovery_identity_unproven', now: 301 });
    assert.equal(await enforceSyncIssueCeiling(f.store, scope), true);
    assert.equal((await f.store.listLocalIssues(scope)).length, 201);
  } finally { f.store.close(); }
});

test('pure Pull records the crossing item before stopping', async () => {
  const f = await pullSetup(undefined, false, { maxRecordBytes: 4000 });
  try {
    for (let start = 1; start <= 201; start += 50) {
      const events = Array.from({ length: Math.min(50, 202 - start) }, (_, i) => pullFixtures.createEvent({
        kind: 'Bookmark', sequence: start + i, collectionId: pullScope.collectionId, parentId: 'root-colp', title: 'x'.repeat(5000) }));
      await f.applier.stage(f.page(events, `cursor-batch-${start}`)); await f.applier.resume();
    }
    assert.equal((await f.store.listPullIssues(pullScope)).length, 201);
    assert.equal((await f.store.getEngineState(pullScope))?.lastError, 'sync_issue_ceiling');
    assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
  } finally { f.store.close(); }
});

test('ceiling resumes an already-started native call without admitting the next mutation', async () => {
  const f = await setup({ useRealPullApplier: true });
  try {
    f.chromeNodes.set('native-root', { id: 'native-root', title: 'Root' });
    const { json, pullEventsPage } = await import('./durable-sync-engine-harness.js');
    const first = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 20, collectionId: scope.collectionId, parentId: 'root-old', title: 'Started' });
    const next = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 21, collectionId: scope.collectionId, parentId: 'root-old', title: 'Must wait' });
    f.crashAt = 'after_browser_call'; f.pullResponses.push(json(200, pullEventsPage([first, next], 'cursor-native')));
    await assert.rejects(f.engine.wake('manual'), /worker_crash/u);
    for (let i = 0; i < 201; i++) await f.store.recordLocalIssue(scope, { nativeId: `n-${i}`, code: 'recovery_identity_unproven', now: i });
    f.store.close(); await f.reopen().wake('startup');
    const events = await f.store.listPullEvents(scope);
    assert.equal(events.find(row => row.operationId === 'op-20')?.state, 'authority_committed');
    assert.equal(events.find(row => row.operationId === 'op-21')?.state, 'staged');
    assert.equal([...f.chromeNodes.values()].filter(node => node.title === 'Started').length, 1);
    assert.equal([...f.chromeNodes.values()].filter(node => node.title === 'Must wait').length, 0);
    assert.equal((await f.store.getEngineState(scope))?.lastError, 'sync_issue_ceiling');
  } finally { f.store.close(); }
});
