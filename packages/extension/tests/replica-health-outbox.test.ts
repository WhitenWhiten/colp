import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setup } from './replica-rebuild-harness.js';
import { runReplicaRebuildCommand } from '../src/replica-rebuild.js';
import { sendReplicaHealthReport, type ReplicaHealthReporterDeps } from '../src/sw/replica-health-report.js';

async function fixture() {
  const f = await setup({ degraded: true }); let token = 'first-token'; const bodies: any[] = []; const tokens: string[] = [];
  let failFinal = true;
  const deps = (): ReplicaHealthReporterDeps => ({ scope: f.scope, store: f.store, mode: async () => 'enabled',
    credential: async () => ({ accessToken: token, serverOrigin: f.scope.serverOrigin, subject: f.scope.accountId }),
    storage: f.journal, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', now: () => 2000,
    commands: { replica: () => runReplicaRebuildCommand(request => f.rebuilder.handle(request)), issue: async () => ({ outcome: 'failed' }) },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body); tokens.push((init!.headers as any).Authorization);
      if (body.code === 'replica_rebuilt' && failFinal) throw new Error('response lost');
      return Response.json({ accepted: true, commands: bodies.length === 1 ? [{ commandId: 'real-reset', action: 'rebuild' }] : [] });
    } });
  return { ...f, get registrations() { return f.registrations; }, reportDeps: deps, bodies, tokens, refresh() { token = 'refreshed-token'; failFinal = false; } };
}

test('failed final result survives actual rotation, reporter restart and new-replica reports; retry uses fresh credentials', async () => {
  const f = await fixture();
  try {
    await sendReplicaHealthReport(f.reportDeps());
    assert.equal(f.registrations, 1);
    const nextScope = await f.deps.currentScope();
    assert.notEqual(nextScope.replicaId, f.scope.replicaId);
    f.refresh();
    await sendReplicaHealthReport({ ...f.reportDeps(), scope: nextScope });
    const delivered = f.bodies.filter(body => body.code === 'replica_rebuilt');
    assert.equal(delivered.length, 2);
    assert.deepEqual(delivered[1], delivered[0], 'same revision/body replay after an uncertain response');
    assert.deepEqual(delivered[1].commandResults, [{ commandId: 'real-reset', outcome: 'done' }]);
    assert.equal(f.tokens[2], 'Bearer refreshed-token');
    assert.equal(f.bodies.at(-1).replicaId, nextScope.replicaId);
    assert.equal(f.registrations, 1);
    assert.match(JSON.stringify(await f.journal.get('known.sync.health.v1')), /real-reset/);
  } finally { f.store.close(); }
});

test('outbox never sends a former account or server result with a new authority', async () => {
  const f = await fixture();
  try {
    await sendReplicaHealthReport(f.reportDeps());
    const next = await f.deps.currentScope();
    const other = { ...next, accountId: 'other-account', serverOrigin: 'https://other.example', serverId: 'other-server' };
    await f.store.registerScope({ ...other, lifecycle: 'active', lease: { leaseId: 'other', expiresAt: 10000 },
      selectedRoots: [], checkpoint: null });
    const before = f.bodies.length;
    await sendReplicaHealthReport({ ...f.reportDeps(), scope: other,
      credential: async () => ({ accessToken: 'other-token', subject: other.accountId, serverOrigin: other.serverOrigin }) });
    assert.equal(f.bodies.length, before + 1);
    assert.equal(f.bodies.at(-1).replicaId, other.replicaId);
    assert.equal(f.bodies.at(-1).commandResults, undefined);
    assert.match(JSON.stringify(await f.journal.get('known.sync.health.v1')), /real-reset/);
    f.refresh();
    await sendReplicaHealthReport({ ...f.reportDeps(), scope: next });
    assert.equal(f.bodies.filter(body => body.code === 'replica_rebuilt').length, 2);
  } finally { f.store.close(); }
});

test('restart after rotation but before saving the runner return recovers done from the actual archive', async () => {
  const f = await fixture(); let crash = true;
  try {
    const storage = { get: f.journal.get.bind(f.journal), async set(values: Record<string, unknown>) {
      if (crash && JSON.stringify(values).includes('"outcome":"done"')) { crash = false; throw new Error('worker_interrupted'); }
      return f.journal.set(values);
    } };
    await assert.rejects(sendReplicaHealthReport({ ...f.reportDeps(), storage }), /worker_interrupted/);
    assert.equal(f.registrations, 1);
    const next = await f.deps.currentScope(); f.refresh();
    await sendReplicaHealthReport({ ...f.reportDeps(), scope: next });
    assert.equal(f.registrations, 1);
    assert.deepEqual(f.bodies.find(body => body.code === 'replica_rebuilt')?.commandResults,
      [{ commandId: 'real-reset', outcome: 'done' }]);
  } finally { f.store.close(); }
});
