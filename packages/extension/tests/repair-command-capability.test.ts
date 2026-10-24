import { expect, test } from 'vitest';
import { setup } from './replica-rebuild-harness.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { createReplicaRebuilder, runReplicaRebuildCommand } from '../src/replica-rebuild.js';

// K3: an upload whose outcome is unsettled no longer hides the Reset; the Reset retires the old replica on
// the server first (here: a fence that succeeds), then archives the uncertain upload without replaying it.
for (const state of ['unsent', 'unknown', 'legacy_unknown'] as const) test(`reporter executes only a repair supported by the real rebuilder (state=${state})`, async () => {
  const unsettled = state !== 'unsent';
  const f = await setup({ degraded: true }); let now = 10000; const bodies: any[] = [];
  const rebuilder = createReplicaRebuilder({ ...f.deps, fence: async () => 'fenced' });
  try {
    if (unsettled) {
      const lease = await f.store.acquireLease(f.scope, 'repair', now, 60000);
      const row = (await f.store.claimNextQueue(f.scope, 'repair', lease.fence, now))!;
      if (state !== 'legacy_unknown') await f.store.bindPushAttempt(f.scope, row.sequence, 'repair', lease.fence, { sessionId: 's', batchId: row.batchId,
        idempotencyKey: row.idempotencyKey, endpointIdentity: 'syncPush', mediaType: 'application/json',
        body: JSON.stringify({ sessionId: 's', batchId: row.batchId, atomic: false, operations: [row.payload] }), bodyDigest: 'sha256:attempt' });
      await f.store.settleClaimedPush(f.scope, row.sequence, 'repair', lease.fence, { outcome: 'unknown',
        retry: { attempt: 8, notBefore: 0 }, recovery: { code: 'push_response_unrecognized' } });
      expect(await rebuilder.handle({ kind: 'known.scope.rebuild.preview' })).toMatchObject({ ok: true, preview: { mode: 'server_fenced' } });
    }
    let requested = false;
    const storage = new MemoryStorageArea();
    const deps = { scope: f.scope, store: f.store, storage, mode: async () => 'enabled' as const, now: () => now,
      origin: 'chrome-extension://test', credential: async () => ({ accessToken: 'test', subject: f.scope.accountId, serverOrigin: f.scope.serverOrigin }),
      commands: { replica: () => runReplicaRebuildCommand(request => rebuilder.handle(request), f.scope),
        issue: async () => ({ outcome: 'failed' as const, code: 'action_unavailable' }) },
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); bodies.push(body);
        return Response.json({ replicaId: f.scope.replicaId, revision: body.revision, accepted: true,
          commands: requested ? [] : [{ commandId: 'repair-command', action: 'rebuild' }] }); } };
    await sendReplicaHealthReport(deps); requested = true; now++;
    expect(bodies[0].actions.includes('rebuild')).toBe(true);
    const archive = await f.store.exportArchive(f.scope);
    expect(archive.reason).toBe('user_replica_rebuild');
    expect(f.registrations).toBe(1);
    expect(bodies.at(-1).code).toBe('replica_rebuilt');
    // The uncertain upload is archived with its bound attempt, never replayed.
    if (unsettled) expect((archive.queue as { status: string }[]).some(saved => saved.status === 'unknown')).toBe(true);
  } finally { f.store.close(); }
});
