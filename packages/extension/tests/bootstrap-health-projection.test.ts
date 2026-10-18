import { parseReplicaHealthReport } from '../../server/src/modules/sync/replica-health.js';
import { expect, test } from 'vitest';
import { conflicted, scope } from './bootstrap-merge-attention-harness.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { terminalFreezeReport } from '../src/sync-attention-ui.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { exceedsSyncIssueCeiling } from '../src/sync-issue-ceiling.js';

test('merge facts share stable display IDs across Status, diagnostics and health without blocking nodes', async () => {
  const f = await conflicted(); const bodies: any[] = [];
  try {
    const open = await readOpenSyncIssues(f.store, scope);
    expect(open.total).toBe(4); expect(open.operationalTotal).toBe(0); expect(open.roots.size).toBe(0);
    expect(await exceedsSyncIssueCeiling(f.store, scope)).toBe(false);
    const response = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    expect(response).toMatchObject({ ok: true, attention: { issueCount: 4, rebuildAvailable: false } });
    if (!response.ok) throw new Error('status_unavailable');
    expect(terminalFreezeReport(response.attention)).toContain('local_merge_difference');
    expect(terminalFreezeReport(response.attention)).toContain(f.view.run.runId);
    const deps = { scope, store: f.store, storage: new MemoryStorageArea(), force: true,
      mode: async () => 'enabled' as const, now: () => 10000, origin: 'chrome-extension://test',
      credential: async () => ({ accessToken: 'test', serverOrigin: scope.serverOrigin, subject: scope.accountId }),
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); bodies.push(body);
        expect(parseReplicaHealthReport(body).issues.total).toBe(body.issues.total);
        return Response.json({ replicaId: scope.replicaId, revision: body.revision, accepted: true, commands: [] }); } };
    await sendReplicaHealthReport(deps);
    expect(bodies[0]).toMatchObject({ state: 'degraded', actions: [], issues: { total: 4 } });
    expect(bodies[0].issues.items.map((row: any) => row.issueId)).toEqual(response.attention.issues?.map(row => row.issueId));
    expect(JSON.stringify(bodies[0])).not.toContain('local-0'); expect(JSON.stringify(bodies[0])).not.toContain('https://example.test/');
    // A second range report for the same pair is one current issue, not another four.
    await f.store.putBootstrapRun(scope, { ...f.view.run, runId: 'second-range', confirmationId: 'second-range',
      attention: { ...f.view.run.attention!, reportId: 'second-range' }, updatedAt: f.view.run.updatedAt + 1 });
    expect((await readOpenSyncIssues(f.store, scope)).total).toBe(4);
    for (const run of await f.store.listBootstrapRuns(scope)) await f.coordinator.advance(run.runId,
      { ...f.input, localFacts: f.input.localFacts.map((row, i) => ({ ...row, title: `Remote ${i}` })) });
    f.store.close(); await sendReplicaHealthReport(deps);
    expect(bodies.at(-1)).toMatchObject({ state: 'syncing', issues: { total: 0, items: [] } });
  } finally { f.store.close(); }
});
