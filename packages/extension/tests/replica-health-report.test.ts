import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import type { QueueOperation } from '../src/sync-state-store.js';
import type { PublicSyncAttention } from '../src/types.js';
import {
  projectReplicaHealth, REPLICA_HEALTH_HEARTBEAT_MS, REPLICA_HEALTH_PATH, replicaIssuesFromQueue,
  sendReplicaHealthReport, type ReplicaHealthReporterDeps,
} from '../src/sw/replica-health-report.js';
import { scope, setup } from './durable-sync-engine-harness.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SERVER = 'https://colp.example';
const calm: PublicSyncAttention = { recoveryFrozen: false, retryAutomatic: true, queueProjection: 'idle',
  conflictPending: false, rejectedPending: false, nativeWaitPending: false, waitCount: 0, terminal: false };

function row(overrides: Partial<QueueOperation>): QueueOperation {
  return { scopeKey: 'scope', sequence: 1, opId: 'op-1', batchId: 'op-1', idempotencyKey: 'op-1', digest: 'd',
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: 'r',
    status: 'rejected', retry: { attempt: 1, notBefore: 0 }, recovery: { code: 'invalid_node_constraints' },
    payload: { type: 'create_node', targetId: 'local-abc', occurredAt: '2026-10-17T10:00:00.000Z',
      payload: { node: { kind: 'bookmark', title: 'Recipes', url: 'https://example.test' } } }, ...overrides } as QueueOperation;
}

describe('replica health projection', () => {
  test('item problems degrade the browser; only the engine stopping stops it', () => {
    const issues = replicaIssuesFromQueue([
      row({}),
      row({ sequence: 2, opId: 'op-2', status: 'blocked', recovery: { code: 'conflict_pending' },
        payload: { type: 'update_node_content', targetId: 'node-7', occurredAt: '2026-10-17T11:00:00.000Z',
          payload: { base: { title: 'Old' }, value: { title: 'New title' } } } }),
      row({ sequence: 3, opId: 'op-3', status: 'pending' }),
    ]);
    assert.deepEqual(issues.map((issue) => [issue.code, issue.direction, issue.nodeId, issue.opId, issue.title]), [
      // A create the server never accepted has no server node id to name.
      ['invalid_node_constraints', 'push', undefined, 'op-1', 'Recipes'],
      ['conflict_pending', 'push', 'node-7', 'op-2', 'New title'],
    ]);
    assert.match(issues[0]!.issueId, /^[0-9a-f]{32}$/u);
    assert.deepEqual(projectReplicaHealth({ attention: calm, issues: [] }), { state: 'syncing', issues: { total: 0, items: [] } });
    assert.equal(projectReplicaHealth({ attention: calm, issues }).state, 'degraded');
    assert.deepEqual(projectReplicaHealth({ attention: { ...calm, terminal: true, retryAutomatic: false,
      terminalCode: 'create_placement_unproven' }, issues }), { state: 'stopped', code: 'create_placement_unproven',
      issues: { total: 2, items: issues } });
    assert.deepEqual(projectReplicaHealth({ attention: { ...calm, retryAutomatic: false, phase: 'error',
      lastError: 'record_too_large' }, issues: [] }).code, 'record_too_large');
    // Paused: nothing syncs, so no bookmark is named.
    assert.deepEqual(projectReplicaHealth({ mode: 'paused', attention: calm, issues }),
      { state: 'paused', issues: { total: 2, items: [] } });
    assert.equal(projectReplicaHealth({ mode: 'target-unavailable', attention: calm, issues: [] }).code, 'target_unavailable');
  });
});

describe('replica health report', () => {
  async function harness() {
    const fixture = await setup();
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let respond = () => new Response(JSON.stringify({ replicaId: scope.replicaId, revision: 1, accepted: true }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    const clock = { now: Date.parse('2026-10-17T12:00:00.000Z') };
    let mode: 'enabled' | 'paused' | 'disconnected' = 'enabled';
    const storage = new MemoryStorageArea();
    const deps = (): ReplicaHealthReporterDeps => ({ scope, store: fixture.store, mode: async () => mode,
      credential: async () => ({ accessToken: 'access-token', serverOrigin: SERVER }),
      fetch: async (input, init) => { requests.push({ url: String(input), init: init ?? {} }); return respond(); },
      storage, origin: ORIGIN, extensionVersion: '0.2.0', now: () => clock.now });
    const bodies = () => requests.map((request) => JSON.parse(String(request.init.body)) as Record<string, unknown>);
    return { fixture, requests, bodies, clock, deps, storage,
      setMode: (value: typeof mode) => { mode = value; },
      setResponse: (value: () => Response) => { respond = value; } };
  }

  test('a frozen engine makes no sync request; its only request is the report naming why it stopped', async () => {
    const h = await harness();
    await freezeScopeRecovery(h.fixture.store, scope, 'create_placement_unproven', () => h.fixture.clock.now);
    await h.fixture.engine.wake('alarm');
    assert.deepEqual(h.fixture.pullRequests, []);
    assert.deepEqual(h.fixture.sessionForces, []);
    assert.deepEqual(h.fixture.snapshotRequests, []);
    assert.equal(h.fixture.push.calls, 0);

    assert.equal(await sendReplicaHealthReport(h.deps()), 'sent');
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0]!.url, `${SERVER}${REPLICA_HEALTH_PATH}`);
    assert.equal(h.requests[0]!.init.method, 'POST');
    assert.equal((h.requests[0]!.init.headers as Record<string, string>).Authorization, 'Bearer access-token');
    assert.deepEqual(h.bodies()[0], { replicaId: scope.replicaId, revision: h.clock.now, state: 'stopped',
      code: 'create_placement_unproven', since: '2026-10-17T12:00:00.000Z', issues: { total: 0, items: [] },
      extensionVersion: '0.2.0' });

    // Nothing changed: no second report until the heartbeat is due, with the same `since`.
    h.clock.now += 60_000;
    assert.equal(await sendReplicaHealthReport(h.deps()), 'unchanged');
    h.clock.now += REPLICA_HEALTH_HEARTBEAT_MS;
    assert.equal(await sendReplicaHealthReport(h.deps()), 'sent');
    assert.equal(h.bodies()[1]!.since, '2026-10-17T12:00:00.000Z');
    assert.ok(Number(h.bodies()[1]!.revision) > Number(h.bodies()[0]!.revision));
    h.fixture.store.close();
  });

  test('a change is sent at once; a pause names no bookmarks; a disconnect says nothing', async () => {
    const h = await harness();
    assert.equal(await sendReplicaHealthReport(h.deps()), 'sent');
    assert.equal(h.bodies()[0]!.state, 'syncing');
    h.setMode('paused');
    h.clock.now += 1_000;
    assert.equal(await sendReplicaHealthReport(h.deps()), 'sent');
    assert.deepEqual([h.bodies()[1]!.state, h.bodies()[1]!.since], ['paused', new Date(h.clock.now).toISOString()]);
    h.setMode('disconnected');
    assert.equal(await sendReplicaHealthReport(h.deps()), 'disconnected');
    assert.equal(h.requests.length, 2);
    h.fixture.store.close();
  });

  test('backs off from a server without the route, and from a failed send', async () => {
    const h = await harness();
    h.setResponse(() => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/problem+json' } }));
    assert.equal(await sendReplicaHealthReport(h.deps()), 'unsupported');
    h.clock.now += 60 * 60_000;
    assert.equal(await sendReplicaHealthReport(h.deps()), 'unsupported');
    assert.equal(h.requests.length, 1);
    // The route's own 404 (the server does not know this replica) is a failure, retried later.
    h.clock.now += 6 * 60 * 60_000;
    h.setResponse(() => new Response('{"error":{"code":"resource_not_found"}}',
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    assert.equal(await sendReplicaHealthReport(h.deps()), 'failed');
    h.clock.now += 30_000;
    assert.equal(await sendReplicaHealthReport(h.deps()), 'unchanged');
    h.clock.now += 30_000;
    assert.equal(await sendReplicaHealthReport(h.deps()), 'failed');
    assert.equal(h.requests.length, 3);
    // An explicit request sends regardless.
    assert.equal(await sendReplicaHealthReport({ ...h.deps(), force: true }), 'failed');
    assert.equal(h.requests.length, 4);
    h.fixture.store.close();
  });
});
