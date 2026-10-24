import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setup } from './replica-rebuild-harness.js';
import { runReplicaRebuildCommand } from '../src/replica-rebuild.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { describeSyncAttention, syncAttentionInput } from '../src/sync-attention-ui.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';

test('an unfrozen Pull issue is visible and repairable through local Status with actual archive and replica rotation', async () => {
  const f = await setup({ degraded: true });
  try {
    const attention = await handleSyncAttentionRequest({ scope: async () => f.scope, store: f.store });
    assert.equal(attention.ok, true); if (!attention.ok) return;
    assert.equal(attention.attention.recoveryFrozen, false);
    assert.equal(attention.attention.issueCount, 1);
    assert.equal(attention.attention.rebuildAvailable, true);
    const view = describeSyncAttention(syncAttentionInput(attention.attention, undefined));
    assert.equal(view.recovery.show, true); assert.match(view.recovery.copy, /1 item needs attention\./);
    assert.equal(view.issues.rows.length, 1, 'the item is a row of its own, not a paragraph');
    assert.deepEqual(await f.rebuilder.handle(f.request), { ok: true, result: 'setup_required' });
    assert.notEqual((await f.credentials.loadBinding())?.replicaId, f.scope.replicaId);
    assert.ok((await f.store.exportArchive(f.scope)).diagnostics);
    assert.equal(await f.store.getScope(f.scope), null);
    const current = await f.deps.currentScope();
    assert.deepEqual(await f.store.listPullIssues(current), []);
  } finally { f.store.close(); }
});

test('a health-delivered web Rebuild uses the real rebuilder and reports the actual replica switch', async () => {
  const f = await setup({ degraded: true }); const reports: any[] = [];
  try {
    await sendReplicaHealthReport({ scope: f.scope, store: f.store, mode: async () => 'enabled',
      credential: async () => ({ accessToken: 'token', serverOrigin: f.scope.serverOrigin, subject: f.scope.accountId }),
      storage: f.journal, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', now: () => 2000,
      commands: { replica: () => runReplicaRebuildCommand(request => f.rebuilder.handle(request)),
        issue: async () => ({ outcome: 'failed' }) },
      fetch: async (_url, init) => {
        const report = JSON.parse(String(init?.body));
        reports.push(report);
        return Response.json({ replicaId: report.replicaId, revision: report.revision,
          accepted: true, commands: reports.length === 1 ? [{ commandId: 'web-reset', action: 'rebuild' }] : [] });
      } });
    assert.ok(reports[0].actions.includes('rebuild'));
    assert.equal(reports[0].state, 'degraded');
    assert.equal(reports.at(-1).code, 'replica_rebuilt');
    assert.deepEqual(reports.at(-1).commandResults, [{ commandId: 'web-reset', outcome: 'done' }]);
    assert.equal(f.registrations, 1);
    assert.notEqual((await f.credentials.loadBinding())?.replicaId, f.scope.replicaId);
    assert.equal((await f.store.exportArchive(f.scope)).reason, 'user_replica_rebuild');
  } finally { f.store.close(); }
});

test('Rebuild confirmation rechecks that repair is still available', async () => {
  const f = await setup({ degraded: true });
  try {
    // A different actor completed repair while the confirmation was open.
    await f.rebuilder.handle(f.request);
    const result = await f.rebuilder.handle(f.request);
    assert.deepEqual(result, { ok: false, code: 'rebuild_not_required' });
    assert.equal(f.registrations, 1);
  } finally { f.store.close(); }
});
