import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setup, scope, json } from './durable-sync-engine-harness.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { MemoryStorageArea } from '../src/credential-store.js';

test('malformed HTTP 200 is not a receipt for command results', async () => {
  const f = await setup();
  try {
    await freezeScopeRecovery(f.store, scope, 'create_placement_unproven');
    const storage = new MemoryStorageArea(); const bodies: any[] = [];
    const deps = { scope, store: f.store, storage, force: true, origin: 'chrome-extension://known',
      mode: async () => 'enabled' as const, now: () => 10000,
      credential: async () => ({ accessToken: 'token', serverOrigin: scope.serverOrigin, subject: scope.accountId }),
      commands: { replica: async () => ({ outcome: 'done' as const, code: 'retry_completed' }), issue: async () => ({ outcome: 'failed' as const }) },
      fetch: async (_url: any, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 2) return new Response('<html>upstream unavailable</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        return json(200, { replicaId: scope.replicaId, revision: bodies.at(-1).revision, accepted: true,
          commands: bodies.length === 1 ? [{ commandId: 'retry-1', action: 'retry' }] : [] });
      } };
    assert.equal(await sendReplicaHealthReport(deps), 'ran');
    assert.equal(await sendReplicaHealthReport(deps), 'failed');
    assert.equal(bodies[1].commandResults[0].commandId, 'retry-1');
    await sendReplicaHealthReport(deps);
    assert.deepEqual(bodies[2].commandResults, bodies[1].commandResults, 'unacknowledged command result must remain pending');
  } finally { f.store.close(); }
});

import { setup as rebuildSetup } from './replica-rebuild-harness.js';
import { runReplicaRebuildCommand } from '../src/replica-rebuild.js';

test('malformed final Rebuild receipt must survive rotation and reporter restart', async () => {
  const f = await rebuildSetup({ degraded: true }); const bodies: any[] = []; let validFinal = false; let clock = 10000;
  try {
    const deps = { scope: f.scope, store: f.store, storage: f.journal, origin: 'chrome-extension://known', now: () => clock,
      mode: async () => 'enabled' as const,
      credential: async () => ({ accessToken: 'token', serverOrigin: f.scope.serverOrigin, subject: f.scope.accountId }),
      commands: { replica: () => runReplicaRebuildCommand(request => f.rebuilder.handle(request), f.scope), issue: async () => ({ outcome: 'failed' as const }) },
      fetch: async (_url: any, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        if (body.code === 'replica_rebuilt' && !validFinal) return new Response('<html>upstream unavailable</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
        return json(200, { replicaId: body.replicaId, revision: body.revision + (body.code === 'replica_rebuilt' ? 10 : 0), accepted: body.code !== 'replica_rebuilt',
          commands: bodies.length === 1 ? [{ commandId: 'real-reset', action: 'rebuild' }] : [] });
      } };
    await sendReplicaHealthReport(deps);
    assert.equal(f.registrations, 1);
    const next = await f.deps.currentScope(); assert.notEqual(next.replicaId, f.scope.replicaId);
    const before = bodies.filter(body => body.code === 'replica_rebuilt').length;
    assert.equal(before, 1);
    await sendReplicaHealthReport({ ...deps, scope: next });
    const after = bodies.filter(body => body.code === 'replica_rebuilt').length;
    assert.equal(after, 2, 'old replica final result must be retransmitted until a valid receipt is received');
    assert.deepEqual(bodies.filter(body => body.code === 'replica_rebuilt')[1], bodies.filter(body => body.code === 'replica_rebuilt')[0]);
    f.store.close(); clock += 9 * 24 * 60 * 60_000;
    validFinal = true;
    await sendReplicaHealthReport({ ...deps, scope: next });
    assert.equal(bodies.filter(body => body.code === 'replica_rebuilt').length, 3, 'unconfirmed final results do not expire');
    await sendReplicaHealthReport({ ...deps, scope: next });
    assert.equal(bodies.filter(body => body.code === 'replica_rebuilt').length, 3, 'valid receipt stops retransmission');
    assert.equal(f.registrations, 1, 'Rebuild did not execute twice');
  } finally { f.store.close(); }
});

const valid = (body: any, commands: unknown[] = []) => ({ replicaId: body.replicaId, revision: body.revision, accepted: true, commands });
const invalidReceipts: Record<string, (body: any) => Response> = {
  html: () => new Response('<html>unavailable</html>', { headers: { 'Content-Type': 'text/html' } }),
  json_syntax: () => json(200, '{'),
  empty: () => new Response(null, { headers: { 'Content-Type': 'application/json' } }),
  truncated: () => new Response('{"replicaId":', { headers: { 'Content-Type': 'application/json' } }),
  missing_replica: body => { const { replicaId: _id, ...rest } = valid(body); return json(200, rest); },
  missing_revision: body => { const { revision: _revision, ...rest } = valid(body); return json(200, rest); },
  missing_accepted: body => { const { accepted: _accepted, ...rest } = valid(body); return json(200, rest); },
  missing_commands: body => { const { commands: _commands, ...rest } = valid(body); return json(200, rest); },
  wrong_replica: body => json(200, { ...valid(body, [{ commandId: 'wrong-target', action: 'rebuild' }]), replicaId: 'other-replica' }),
  old_revision: body => json(200, { ...valid(body), revision: body.revision - 1 }),
  wrong_revision: body => json(200, { ...valid(body), revision: body.revision + 1 }),
  stale_old_revision: body => json(200, { ...valid(body), accepted: false, revision: body.revision - 1 }),
  illegal_accepted: body => json(200, { ...valid(body), accepted: 'true' }),
  illegal_revision: body => json(200, { ...valid(body), revision: 1.5 }),
  illegal_command: body => json(200, { ...valid(body), commands: [{ commandId: null, action: 'rebuild' }] }),
  false_retirement: body => json(200, valid(body, [{ commandId: 'reset', action: 'rebuild', replicaRetired: false }])),
  retirement_on_retry: body => json(200, valid(body, [{ commandId: 'reset', action: 'retry', replicaRetired: true }])),
  retirement_on_item: body => json(200, valid(body, [{ commandId: 'reset', action: 'rebuild', issueId: 'one', replicaRetired: true }])),
  duplicate_command: body => json(200, valid(body, [{ commandId: 'duplicate', action: 'retry' }, { commandId: 'duplicate', action: 'retry' }])),
  oversized: body => json(200, { ...valid(body), extra: 'x'.repeat(20000) }),
  stalled: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'Content-Type': 'application/json' } }),
};
for (const [name, invalid] of Object.entries(invalidReceipts)) test(`invalid ${name} receipt preserves ordinary pending results and cannot execute commands`, async () => {
  const f = await setup(); const storage = new MemoryStorageArea(); const bodies: any[] = []; let executions = 0;
  try {
    await freezeScopeRecovery(f.store, scope, 'create_placement_unproven');
    const deps = { scope, store: f.store, storage, force: true, origin: 'chrome-extension://known',
      requestTimeoutMilliseconds: 20, mode: async () => 'enabled' as const, now: () => 10000,
      credential: async () => ({ accessToken: 'token', subject: scope.accountId, serverOrigin: scope.serverOrigin }),
      commands: { replica: async () => { executions++; return { outcome: 'done' as const }; }, issue: async () => ({ outcome: 'failed' as const }) },
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        if (bodies.length === 2) return invalid(body);
        if (bodies.length === 3) return json(200, { ...valid(body), accepted: false, revision: body.revision + 10 });
        return json(200, valid(body, bodies.length === 1 ? [{ commandId: 'retry-once', action: 'retry' }] : []));
      } };
    assert.equal(await sendReplicaHealthReport(deps), 'ran');
    assert.equal(await sendReplicaHealthReport(deps), 'failed');
    f.store.close(); // both reporter and IDB reopen before retry
    assert.equal(await sendReplicaHealthReport(deps), 'sent', 'accepted=false still receipts settled command results');
    assert.deepEqual(bodies[2].commandResults, bodies[1].commandResults);
    await sendReplicaHealthReport(deps);
    assert.equal(bodies[3].commandResults, undefined);
    assert.equal(executions, 1);
  } finally { f.store.close(); }
});

for (const name of ['truncated', 'missing_replica', 'missing_revision', 'wrong_replica', 'wrong_revision', 'illegal_command']) {
  test(`invalid ${name} final receipt survives real Rebuild and worker restart`, async () => {
    const f = await rebuildSetup({ degraded: true }); const bodies: any[] = []; let repaired = false;
    try {
      const deps = { scope: f.scope, store: f.store, storage: f.journal, force: true, now: () => 10000,
        mode: async () => 'enabled' as const, origin: 'chrome-extension://test',
        credential: async () => ({ accessToken: 'token', subject: f.scope.accountId, serverOrigin: f.scope.serverOrigin }),
        commands: { replica: () => runReplicaRebuildCommand(request => f.rebuilder.handle(request), f.scope), issue: async () => ({ outcome: 'failed' as const }) },
        fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)); bodies.push(body);
          if (body.code === 'replica_rebuilt' && !repaired) return invalidReceipts[name]!(body);
          return json(200, valid(body, bodies.length === 1 ? [{ commandId: 'rebuild-once', action: 'rebuild' }] : []));
        } };
      await sendReplicaHealthReport(deps); assert.equal(f.registrations, 1);
      const next = await f.deps.currentScope(); f.store.close();
      await sendReplicaHealthReport({ ...deps, scope: next });
      let finals = bodies.filter(body => body.code === 'replica_rebuilt');
      assert.equal(finals.length, 2); assert.deepEqual(finals[0], finals[1]);
      repaired = true; await sendReplicaHealthReport({ ...deps, scope: next });
      await sendReplicaHealthReport({ ...deps, scope: next });
      finals = bodies.filter(body => body.code === 'replica_rebuilt');
      assert.equal(finals.length, 3); assert.equal(f.registrations, 1);
    } finally { f.store.close(); }
  });
}
