import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { describeSyncAttention, syncAttentionInput } from '../src/sync-attention-view.js';
import { readHealthDeliveryFailure, HEALTH_DELIVERY_GRACE_MS, healthDeliveryFailure } from '../src/sw/health-delivery-status.js';
import {
  REPLICA_DISCONNECTED_CODE, sendReplicaDisconnectReport, sendReplicaHealthReport, type ReplicaHealthReporterDeps,
} from '../src/sw/replica-health-report.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { scope, setup } from './durable-sync-engine-harness.js';

/**
 * C-08: a report that cannot be sent is visible, with the reason and since when.
 * C-17d: a deliberate disconnect says so once, so the Sync center stops showing the last state.
 */
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

async function harness() {
  const fixture = await setup();
  const requests: Array<{ body: Record<string, unknown> }> = [];
  let respond: (body: any) => Response | Promise<Response> = body => new Response(JSON.stringify({ replicaId: body.replicaId,
    revision: body.revision, accepted: true, commands: [] }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const clock = { now: Date.parse('2026-10-24T12:00:00.000Z') };
  const storage = new MemoryStorageArea();
  const deps = (): ReplicaHealthReporterDeps => ({ scope, store: fixture.store, mode: async () => 'enabled',
    credential: async () => ({ accessToken: 'access-token', serverOrigin: scope.serverOrigin, subject: scope.accountId }),
    fetch: async (_input, init) => { const body = JSON.parse(String(init?.body)); requests.push({ body }); return respond(body); },
    storage, origin: ORIGIN, extensionVersion: '0.2.0', now: () => clock.now });
  return { fixture, requests, clock, deps, storage, setResponse: (value: typeof respond) => { respond = value; } };
}
const problem = (status: number) => () => new Response('{}', { status });

describe('a report that cannot be sent (C-08)', () => {
  test('records why it failed and since when, and keeps the first failure while it keeps failing', async () => {
    const h = await harness();
    try {
      h.setResponse(problem(503));
      assert.equal(await sendReplicaHealthReport(h.deps()), 'failed');
      const first = h.clock.now;
      assert.deepEqual(await readHealthDeliveryFailure(h.storage, scope, h.clock.now + HEALTH_DELIVERY_GRACE_MS - 1), undefined, 'not at once: the retry is a minute away');
      h.clock.now += 6 * 60_000;
      assert.equal(await sendReplicaHealthReport(h.deps()), 'failed');
      assert.deepEqual(await readHealthDeliveryFailure(h.storage, scope, h.clock.now),
        { code: 'health_http_503', since: first }, 'the first failure is kept, not the latest');
    } finally { h.fixture.store.close(); }
  });

  test('names the other ways a send goes wrong', async () => {
    const h = await harness();
    try {
      const reason = async (respond: () => Response | Promise<Response>) => {
        h.setResponse(respond); h.clock.now += 2 * 60_000;
        await sendReplicaHealthReport({ ...h.deps(), force: true });
        return (await readHealthDeliveryFailure(h.storage, scope, h.clock.now + 60 * 60_000))?.code;
      };
      assert.equal(await reason(() => { throw new TypeError('Failed to fetch'); }), 'health_unreachable');
      assert.equal(await reason(() => { throw new DOMException('timed out', 'TimeoutError'); }), 'health_timeout');
      assert.equal(await reason(() => { throw new Error('server_host_permission_required'); }), 'server_host_permission_required');
      assert.equal(await reason(() => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } })), 'health_receipt_invalid');
      assert.equal(await reason(problem(401)), 'health_http_401');
    } finally { h.fixture.store.close(); }
  });

  test('one good send clears it', async () => {
    const h = await harness();
    try {
      h.setResponse(problem(500));
      await sendReplicaHealthReport(h.deps());
      h.clock.now += 10 * 60_000;
      assert.ok(await readHealthDeliveryFailure(h.storage, scope, h.clock.now));
      h.setResponse(body => new Response(JSON.stringify({ replicaId: body.replicaId, revision: body.revision, accepted: true, commands: [] }),
        { headers: { 'Content-Type': 'application/json' } }));
      assert.equal(await sendReplicaHealthReport({ ...h.deps(), force: true }), 'sent');
      assert.equal(await readHealthDeliveryFailure(h.storage, scope, h.clock.now), undefined);
    } finally { h.fixture.store.close(); }
  });

  test('a record from before this change still counts by its last attempt, and garbage counts for nothing', () => {
    const now = 10 * 60_000;
    assert.deepEqual(healthDeliveryFailure({ failed: { digest: 'd', retryAt: 1, at: 1 } }, now), { code: 'health_unreachable', since: 1 });
    assert.equal(healthDeliveryFailure({ failed: { digest: 'd', retryAt: 1, at: now - 1_000 } }, now), undefined);
    assert.equal(healthDeliveryFailure({ failed: 'x' }, now), undefined);
    assert.equal(healthDeliveryFailure(undefined, now), undefined);
    assert.equal(healthDeliveryFailure({ failed: { since: 1, code: 'Bad Code' } }, now)?.code, 'health_unreachable');
  });

  test('the Status card says so beside whatever else it shows, and the read carries it', async () => {
    const h = await harness();
    try {
      h.setResponse(problem(502));
      await sendReplicaHealthReport(h.deps());
      h.clock.now += 20 * 60_000;
      const response = await handleSyncAttentionRequest({ scope: async () => scope, store: h.fixture.store,
        healthDelivery: s => readHealthDeliveryFailure(h.storage, s, h.clock.now) });
      assert.ok(response.ok);
      if (!response.ok) return;
      assert.equal(response.attention.healthDelivery?.code, 'health_http_502');
      const view = describeSyncAttention(syncAttentionInput(response.attention, undefined));
      assert.equal(view.notes.show, true);
      assert.match(view.notes.lines[0]!, /couldn’t send its status to the server since .+ \(health_http_502\)\. The Sync center on the web may show old information\./u);
      assert.match(view.recovery.report, /healthReports: failing since .+ \(health_http_502\)/u, 'Copy details carries it too');
      const calm = await handleSyncAttentionRequest({ scope: async () => scope, store: h.fixture.store });
      assert.ok(calm.ok && calm.attention.healthDelivery === undefined);
    } finally { h.fixture.store.close(); }
  });
});

describe('a deliberate disconnect (C-17d)', () => {
  test('tells the Sync center once, as paused with a code of its own', async () => {
    const h = await harness();
    try {
      assert.equal(await sendReplicaDisconnectReport({ ...h.deps(), mode: async () => 'disconnected' }), 'sent');
      assert.equal(h.requests.length, 1);
      const body = h.requests[0]!.body;
      assert.deepEqual([body.state, body.code, body.actions, body.issues], ['paused', REPLICA_DISCONNECTED_CODE, [], { total: 0, items: [] }]);
      assert.equal(body.replicaId, scope.replicaId);
      h.clock.now += 60 * 60_000;
      assert.equal(await sendReplicaDisconnectReport({ ...h.deps(), mode: async () => 'disconnected' }), 'unchanged');
      assert.equal(h.requests.length, 1, 'said once; a disconnected browser stays quiet');
      assert.equal(await sendReplicaHealthReport({ ...h.deps(), mode: async () => 'disconnected' }), 'disconnected');
      assert.equal(h.requests.length, 1);
    } finally { h.fixture.store.close(); }
  });

  test('a server that does not answer is retried later, by the journal, not by the user', async () => {
    const h = await harness();
    try {
      h.setResponse(() => { throw new TypeError('Failed to fetch'); });
      assert.equal(await sendReplicaDisconnectReport({ ...h.deps(), mode: async () => 'disconnected' }), 'sent');
      assert.equal(h.requests.length, 1);
      h.setResponse(body => new Response(JSON.stringify({ replicaId: body.replicaId, revision: body.revision, accepted: true, commands: [] }),
        { headers: { 'Content-Type': 'application/json' } }));
      h.clock.now += 5 * 60_000;
      // The next time anything reports for this account and profile, the unconfirmed final goes out first.
      assert.equal(await sendReplicaDisconnectReport({ ...h.deps(), mode: async () => 'disconnected' }), 'unchanged');
      assert.equal(h.requests.length, 2);
      assert.deepEqual([h.requests[1]!.body.state, h.requests[1]!.body.code], ['paused', REPLICA_DISCONNECTED_CODE]);
      h.clock.now += 5 * 60_000;
      await sendReplicaDisconnectReport({ ...h.deps(), mode: async () => 'disconnected' });
      assert.equal(h.requests.length, 2, 'confirmed: no more');
    } finally { h.fixture.store.close(); }
  });
});
