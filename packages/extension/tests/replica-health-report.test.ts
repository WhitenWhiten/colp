import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import type { JsonObject, QueueOperation } from '../src/sync-state-store.js';
import type { PublicSyncAttention } from '../src/types.js';
import {
  projectReplicaHealth, REPLICA_HEALTH_ATTENTION_HEARTBEAT_MS, REPLICA_HEALTH_PATH, replicaIssuesFromQueue,
  sendReplicaHealthReport, type ReplicaCommandRunner, type ReplicaHealthReporterDeps,
} from '../src/sw/replica-health-report.js';
import { scope, setup } from './durable-sync-engine-harness.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SERVER = scope.serverOrigin;
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
    assert.deepEqual(projectReplicaHealth({ attention: calm, issues: [] }),
      { state: 'syncing', issues: { total: 0, items: [] }, actions: [] });
    assert.equal(projectReplicaHealth({ attention: calm, issues }).state, 'degraded');
    assert.deepEqual(projectReplicaHealth({ attention: { ...calm, terminal: true, retryAutomatic: false,
      terminalCode: 'create_placement_unproven' }, issues }), { state: 'stopped', code: 'create_placement_unproven',
      issues: { total: 2, items: issues }, actions: ['retry', 'rebuild'] });
    assert.deepEqual(projectReplicaHealth({ attention: { ...calm, retryAutomatic: false, phase: 'error',
      lastError: 'record_too_large' }, issues: [] }).code, 'record_too_large');
    // Paused: nothing syncs, so no bookmark is named.
    assert.deepEqual(projectReplicaHealth({ mode: 'paused', attention: calm, issues }),
      { state: 'paused', issues: { total: 2, items: [] }, actions: [] });
    assert.equal(projectReplicaHealth({ mode: 'target-unavailable', attention: calm, issues: [] }).code, 'target_unavailable');
  });

  test('a stop offers only what can end it, and only a change held for a decision offers its own retry', () => {
    const stopped = (code: string, recoveryFrozen: boolean) => projectReplicaHealth({ attention: { ...calm,
      recoveryFrozen, terminal: true, retryAutomatic: false, terminalCode: code as never }, issues: [] }).actions;
    // A retry is a manual wake; Rebuild needs the same frozen engine as the extension's Reset button.
    assert.deepEqual(stopped('recovery_identity_unproven', true), ['retry', 'rebuild']);
    assert.deepEqual(stopped('pull_apply_target_missing', true), ['rebuild']);
    assert.deepEqual(stopped('record_too_large', false), []);
    assert.deepEqual(projectReplicaHealth({ mode: 'target-unavailable', attention: calm, issues: [] }).actions, []);
    const held = (code: string) => row({ status: 'set_aside', recovery: { code } });
    assert.deepEqual(replicaIssuesFromQueue([held('create_placement_unproven'), held('recovery_identity_unproven'),
      held('conflict_hold'), held('dependency_hold'), row({})]).map((issue) => [issue.code, issue.actions]), [
      ['create_placement_unproven', ['retry']], ['recovery_identity_unproven', ['retry']],
      // Waiting changes follow what they wait for; a refused change would be refused again.
      ['conflict_hold', []], ['dependency_hold', []], ['invalid_node_constraints', []]]);
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
      credential: async () => ({ accessToken: 'access-token', serverOrigin: SERVER, subject: scope.accountId }),
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
      actions: ['retry', 'rebuild'], extensionVersion: '0.2.0' });

    // Nothing changed: no second report until the heartbeat is due, with the same `since`.
    h.clock.now += 60_000;
    assert.equal(await sendReplicaHealthReport(h.deps()), 'unchanged');
    h.clock.now += REPLICA_HEALTH_ATTENTION_HEARTBEAT_MS;
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

  test('carries out what the Sync center asks once, checked against what it offers now, and reports the results', async () => {
    const h = await harness();
    await enqueue(h.fixture.store, 'op-save', { type: 'create_node', targetId: 'pending-op-save',
      occurredAt: '2026-10-17T10:00:00.000Z', payload: { node: { kind: 'bookmark', title: 'Recipes' } } });
    await h.fixture.store.setAsideQueue(scope, [1], 'create_placement_unproven');
    await freezeScopeRecovery(h.fixture.store, scope, 'recovery_identity_unproven', () => h.fixture.clock.now);
    const ran: string[] = [];
    const runner: ReplicaCommandRunner = {
      async replica(action) { ran.push(action); return { outcome: 'done' }; },
      async issue(action, issue) { ran.push(`${action}:${issue.opId}`); return { outcome: 'failed', code: 'still_unproven' }; },
    };
    const deps = (force = false): ReplicaHealthReporterDeps => ({ ...h.deps(), commands: runner, force });
    let delivered: unknown[] = [];
    h.setResponse(() => new Response(JSON.stringify({ replicaId: scope.replicaId, revision: 1, accepted: true,
      commands: delivered }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    assert.equal(await sendReplicaHealthReport(deps()), 'sent');
    const offered = h.bodies()[0]!;
    assert.deepEqual(offered.actions, ['retry', 'rebuild']);
    const issue = (offered.issues as { items: Array<{ issueId: string; actions: string[] }> }).items[0]!;
    assert.deepEqual(issue.actions, ['retry']);

    // The owner asked for a retry of the browser, a retry of the held save, and two things it does not offer.
    delivered = [{ commandId: 'cmd_1', action: 'retry' }, { commandId: 'cmd_2', action: 'retry', issueId: issue.issueId },
      { commandId: 'cmd_3', action: 'resume' }, { commandId: 'cmd_4', action: 'retry', issueId: 'issue-gone' }];
    assert.equal(await sendReplicaHealthReport(deps(true)), 'ran');
    assert.deepEqual(ran, ['retry', 'retry:op-save']);
    // Redelivered before the server saw the results: nothing runs twice, and the results go out again.
    assert.equal(await sendReplicaHealthReport(deps(true)), 'ran');
    assert.deepEqual(ran, ['retry', 'retry:op-save']);
    const results = [{ commandId: 'cmd_1', outcome: 'done' }, { commandId: 'cmd_2', outcome: 'failed', code: 'still_unproven' },
      { commandId: 'cmd_3', outcome: 'failed', code: 'action_unavailable' },
      { commandId: 'cmd_4', outcome: 'failed', code: 'issue_gone' }];
    assert.deepEqual(h.bodies()[2]!.commandResults, results);
    // Unsent results make a report due even when nothing else changed.
    delivered = [];
    assert.equal(await sendReplicaHealthReport(deps()), 'sent');
    assert.deepEqual(h.bodies()[3]!.commandResults, results);
    h.clock.now += 1_000;
    assert.equal(await sendReplicaHealthReport(deps()), 'unchanged');
    assert.equal(await sendReplicaHealthReport(deps(true)), 'sent');
    assert.equal(h.bodies()[4]!.commandResults, undefined);

    // A command seen but never finished (the worker stopped mid-way) is reported failed, never run again.
    const record = (await h.storage.get('known.sync.health.v1'))['known.sync.health.v1'] as Record<string, unknown>;
    await h.storage.set({ 'known.sync.health.v1': { ...record,
      records: Object.fromEntries(Object.entries(record.records as Record<string, any>).map(([key, entry]) => [key, { ...entry,
        value: { ...entry.value, commands: [...entry.value.commands, { commandId: 'cmd_5' }] } }])) } });
    delivered = [{ commandId: 'cmd_5', action: 'retry' }];
    assert.equal(await sendReplicaHealthReport(deps(true)), 'ran');
    assert.deepEqual(ran, ['retry', 'retry:op-save']);
    delivered = [];
    await sendReplicaHealthReport(deps(true));
    assert.deepEqual(h.bodies()[6]!.commandResults, [{ commandId: 'cmd_5', outcome: 'failed', code: 'command_interrupted' }]);
    // Without a runner, commands wait for a report that can carry them out.
    delivered = [{ commandId: 'cmd_6', action: 'retry' }];
    assert.equal(await sendReplicaHealthReport({ ...h.deps(), force: true }), 'sent');
    assert.deepEqual(ran, ['retry', 'retry:op-save']);
    h.fixture.store.close();
  });

  test('encodes a final Rebuild wire marker from a replacement runner result (transport unit)', async () => {
    const h = await harness();
    await freezeScopeRecovery(h.fixture.store, scope, 'pull_apply_target_missing', () => h.fixture.clock.now);
    const runner: ReplicaCommandRunner = {
      async replica(action) { return action === 'rebuild' ? { outcome: 'done', replaced: true } : { outcome: 'failed' }; },
      async issue() { throw new Error('unexpected'); },
    };
    let delivered: unknown[] = [{ commandId: 'cmd_rebuild', action: 'rebuild' }, { commandId: 'cmd_after', action: 'retry' }];
    h.setResponse(() => new Response(JSON.stringify({ accepted: true, commands: delivered }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    assert.equal(await sendReplicaHealthReport({ ...h.deps(), commands: runner }), 'sent');
    assert.deepEqual(h.bodies()[0]!.actions, ['rebuild']);
    const farewell = h.bodies()[1]!;
    assert.deepEqual([farewell.replicaId, farewell.state, farewell.code, farewell.actions, farewell.commandResults],
      [scope.replicaId, 'stopped', 'replica_rebuilt', [], [{ commandId: 'cmd_rebuild', outcome: 'done' }]]);
    assert.ok(Number(farewell.revision) > Number(h.bodies()[0]!.revision));
    // Nothing else runs on a replica that is gone.
    assert.equal(h.requests.length, 2);
    delivered = [];
    h.fixture.store.close();
  });
});

async function enqueue(store: Awaited<ReturnType<typeof setup>>['store'], opId: string, payload: JsonObject) {
  await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`,
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`,
    status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: { ...payload, opId, replicaId: scope.replicaId,
      collectionId: scope.collectionId, sequence: 0, dependencies: [] } },
  { validateOperation: () => true, digestOperation: (value) => `sha256:${String(value.opId)}-${String(value.sequence)}` });
}
