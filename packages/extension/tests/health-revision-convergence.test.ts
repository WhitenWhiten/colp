import { expect, test } from 'vitest';
import { setup, scope, json } from './durable-sync-engine-harness.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createHealthDelivery } from '../src/sw/replica-health-delivery.js';

test('strict last-writer-wins converges after local journal rollback, a lost response and clock rollback', async () => {
  const f = await setup(); let now = 10000; let revision = 10000000; let lose = true;
  const bodies: any[] = []; let serverState: unknown;
  try {
    const storage = new MemoryStorageArea();
    const deps = { scope, store: f.store, storage, origin: 'chrome-extension://test', mode: async () => 'enabled' as const,
      now: () => now, credential: async () => ({ accessToken: 'test', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        const accepted = body.revision > revision;
        if (accepted) { revision = body.revision; serverState = body.state; }
        if (accepted && lose) { lose = false; throw new TypeError('lost response'); }
        return json(200, { replicaId: scope.replicaId, revision, accepted, commands: [] });
      } };
    await sendReplicaHealthReport(deps);
    await sendReplicaHealthReport(deps); expect(bodies).toHaveLength(1); // backoff, no request storm
    now += 60000; await sendReplicaHealthReport(deps);
    expect(bodies[1].revision).toBeGreaterThan(10000000);
    now = 1000; await sendReplicaHealthReport({ ...deps, force: true }); // clock moved backwards
    expect(bodies[2].revision).toBeGreaterThan(bodies[1].revision);
    expect(serverState).toBe('syncing');
    expect(await sendReplicaHealthReport(deps)).toBe('unchanged');
  } finally { f.store.close(); }
});
test('a stale final report receipts command results but must republish its final state above server revision', async () => {
  let now = 1000; let revision = 10000000; const bodies: any[] = []; const storage = new MemoryStorageArea();
  const options = { scope, storage, now: () => now, post: async (body: Record<string, unknown>) => {
    bodies.push(body); const accepted = Number(body.revision) > revision; if (accepted) revision = Number(body.revision);
    return json(200, { replicaId: scope.replicaId, revision, accepted, commands: [] }); } };
  const delivery = await createHealthDelivery(options);
  await delivery.storage.set({ 'known.sync.health.v1': { replicaId: scope.replicaId, revision: 1,
    commands: [{ commandId: 'done', outcome: 'done' }] } });
  await delivery.stageFinal({ replicaId: scope.replicaId, revision: 2, state: 'stopped', code: 'replica_rebuilt',
    issues: { total: 0, items: [] }, actions: [], commandResults: [{ commandId: 'done', outcome: 'done' }] });
  await createHealthDelivery(options); expect(bodies).toHaveLength(1);
  now += 60000; await createHealthDelivery(options);
  expect(bodies[1].revision).toBe(10000001); expect(bodies[1].commandResults).toEqual(bodies[0].commandResults);
  await createHealthDelivery(options); expect(bodies).toHaveLength(2);
});

test('automatic reports remain live when the clock rolls back after an accepted or failed report', async () => {
  const f = await setup(); let now = 100000; let fail = false; let revision = 0; const sent: number[] = [];
  try {
    const deps = { scope, store: f.store, storage: new MemoryStorageArea(), origin: 'chrome-extension://test',
      mode: async () => 'enabled' as const, now: () => now,
      credential: async () => ({ accessToken: 'test', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)); sent.push(body.revision);
        if (fail) throw new Error('lost');
        const accepted = body.revision > revision; if (accepted) revision = body.revision;
        return json(200, { replicaId: scope.replicaId, revision, accepted, commands: [] }); } };
    await sendReplicaHealthReport(deps); now = 10;
    expect(await sendReplicaHealthReport(deps)).toBe('sent');
    now = 200000; fail = true;
    await sendReplicaHealthReport({ ...deps, force: true }); now = 20; fail = false;
    expect(await sendReplicaHealthReport(deps)).toBe('sent');
    expect(sent).toEqual([100000, 100001, 200000, 200001]);
  } finally { f.store.close(); }
});
