import assert from 'node:assert/strict';
import { test } from 'vitest';
import { STORES } from '../src/sync-state/schema.js';
import { createReplicaRebuilder } from '../src/replica-rebuild.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { setup } from './replica-rebuild-harness.js';

for (const fenced of [false, true]) test(`corrupt diagnostics retain an archive-backed recovery exit (server fence=${fenced})`, async () => {
  const f = await setup(); const bodies: Record<string, any>[] = [];
  try {
    const db = await f.store.open(); const key = (await f.store.getScope(f.scope))!.scopeKey;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORES.engine, STORES.queue], 'readwrite');
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      tx.objectStore(STORES.engine).put({ scopeKey: key, revision: -1, phase: 'corrupt' });
      tx.objectStore(STORES.queue).put({ scopeKey: key, sequence: 12, opId: 'damaged', status: 'unknown', payload: { title: 'Keep raw evidence' } });
    });
    const deps = { scope: f.scope, store: f.store, storage: f.journal, force: true, now: () => 10000,
      mode: async () => 'enabled' as const, origin: 'chrome-extension://test',
      credential: async () => ({ accessToken: 'test', subject: f.scope.accountId, serverOrigin: f.scope.serverOrigin }),
      commands: { replica: async () => ({ outcome: 'failed' as const, code: 'action_unavailable' }),
        serverRebuild: () => f.rebuilder.rebuildServerRetired(f.scope), issue: async () => ({ outcome: 'failed' as const }) },
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get('Known-Sync-Rebuild'), 'retire');
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        return Response.json({ replicaId: body.replicaId, revision: body.revision, accepted: true,
          commands: bodies.length === 1 ? [{ commandId: 'reset-corrupt', action: 'rebuild', ...(fenced ? { replicaRetired: true } : {}) }] : [] });
      } };
    await sendReplicaHealthReport(deps);
    assert.equal(bodies[0]!.code, 'sync_diagnostics_unavailable');
    assert.deepEqual(bodies[0]!.actions, ['rebuild']);
    if (fenced) {
      assert.equal(f.registrations, 1);
      const archive = await f.store.exportArchive(f.scope);
      assert.ok((archive.queue as { opId: string; payload: unknown }[]).some(row => row.opId === 'damaged'
        && JSON.stringify(row.payload).includes('Keep raw evidence')));
      assert.equal(bodies.at(-1)!.code, 'replica_rebuilt');
      assert.equal(bodies.at(-1)!.commandResults[0].outcome, 'done');
    } else {
      assert.equal(f.registrations, 0, 'legacy receipt cannot bypass the unsettled/invalid-state guard');
      assert.ok(await f.store.getScope(f.scope));
    }
  } finally { f.store.close(); }
});

test('a fenced reset interrupted after archiving resumes the same journal and identity', async () => {
  const f = await setup();
  try {
    f.setOffline(true);
    assert.equal((await f.rebuilder.rebuildServerRetired(f.scope)).outcome, 'failed');
    const binding = await f.credentials.loadBinding();
    f.store.close();
    f.setOffline(false);
    assert.equal(await createReplicaRebuilder(f.deps).resume(), true);
    assert.deepEqual(await f.credentials.loadBinding(), binding);
    assert.equal(f.registrations, 1);
    assert.equal((await f.store.exportArchive(f.scope)).reason, 'user_replica_rebuild');
  } finally { f.store.close(); }
});
