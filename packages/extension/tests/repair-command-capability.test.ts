import { expect, test } from 'vitest';
import { setup } from './replica-rebuild-harness.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { runReplicaRebuildCommand } from '../src/replica-rebuild.js';

for (const state of ['unsent', 'unknown', 'legacy_unknown'] as const) test(`reporter executes only a repair supported by the real rebuilder (state=${state})`, async () => {
  const unsettled = state !== 'unsent';
  const f = await setup({ degraded: true }); let now = 10000; const bodies: any[] = [];
  try {
    if (unsettled) {
      const lease = await f.store.acquireLease(f.scope, 'repair', now, 60000);
      const row = (await f.store.claimNextQueue(f.scope, 'repair', lease.fence, now))!;
      if (state !== 'legacy_unknown') await f.store.bindPushAttempt(f.scope, row.sequence, 'repair', lease.fence, { sessionId: 's', batchId: row.batchId,
        idempotencyKey: row.idempotencyKey, endpointIdentity: 'syncPush', mediaType: 'application/json',
        body: JSON.stringify({ sessionId: 's', batchId: row.batchId, atomic: false, operations: [row.payload] }), bodyDigest: 'sha256:attempt' });
      await f.store.settleClaimedPush(f.scope, row.sequence, 'repair', lease.fence, { outcome: 'unknown',
        retry: { attempt: 8, notBefore: 0 }, recovery: { code: 'push_response_unrecognized' } });
      expect(await f.rebuilder.handle({ kind: 'known.scope.rebuild.preview' })).toEqual({ ok: false, code: 'upload_outcome_unsettled' });
    }
    let requested = false;
    const storage = new MemoryStorageArea();
    const deps = { scope: f.scope, store: f.store, storage, mode: async () => 'enabled' as const, now: () => now,
      origin: 'chrome-extension://test', credential: async () => ({ accessToken: 'test', subject: f.scope.accountId, serverOrigin: f.scope.serverOrigin }),
      commands: { replica: () => runReplicaRebuildCommand(request => f.rebuilder.handle(request), f.scope),
        issue: async () => ({ outcome: 'failed' as const, code: 'action_unavailable' }) },
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); bodies.push(body);
        return Response.json({ replicaId: f.scope.replicaId, revision: body.revision, accepted: true,
          commands: requested ? [] : [{ commandId: 'repair-command', action: 'rebuild' }] }); } };
    await sendReplicaHealthReport(deps); requested = true; now++;
    expect(bodies[0].actions.includes('rebuild')).toBe(!unsettled);
    if (unsettled) {
      await sendReplicaHealthReport({ ...deps, force: true });
      expect(bodies.at(-1).commandResults).toContainEqual({ commandId: 'repair-command', outcome: 'failed', code: 'action_unavailable' });
      expect((await f.store.getScope(f.scope))?.lifecycle).toBe('active');
    } else {
      expect((await f.store.exportArchive(f.scope)).reason).toBe('user_replica_rebuild');
      expect(f.registrations).toBe(1);
      expect(bodies.at(-1).code).toBe('replica_rebuilt');
    }
  } finally { f.store.close(); }
});
