import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import {
  classifyPushProblem, createOutboundPushWorker, type PushSessionController,
} from '../src/outbound-push-worker.js';
import {
  installOutboundPushIndexedDb, problem, scope, setup,
} from './outbound-push-worker-harness.js';

installOutboundPushIndexedDb();

/**
 * F004: transport/authority refusals (`authentication_required`, `stale_replica`,
 * `replica_retired`, any 401/403/410) are not operation-level verdicts. The row
 * must stay replayable and the drain must demand session/scope authority
 * recovery instead of writing `rejected`.
 */
function refreshingSessions(forced: boolean[]): PushSessionController {
  return { async get(forceRefresh = false) {
    forced.push(forceRefresh);
    return { credential: { accessToken: forceRefresh ? 'fresh-access' : 'old-access' }, session: {
      sessionId: forceRefresh ? 'session-fresh' : 'session-old', expiresAt: '2099-01-01T00:00:00Z',
      scope: 'collection' as const, credentialAuthorityDigest: 'a'.repeat(64), snapshotRequired: false,
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
      replicaLease: { leaseId: 'lease-server', generation: '1', state: 'active' as const,
        expiresAt: '2099-01-01T00:00:00Z' } } };
  } };
}

describe('T-02 F004 push refusal routing', () => {
  test('classifier: authority refusals never fall into the operation-level rejected branch', () => {
    assert.equal(classifyPushProblem({ code: 'authentication_required', retryable: false, status: 401 }), 'authority');
    assert.equal(classifyPushProblem({ code: 'stale_replica', retryable: false, status: 410 }), 'authority');
    assert.equal(classifyPushProblem({ code: 'replica_retired', retryable: false, status: 410 }), 'authority');
    assert.equal(classifyPushProblem({ code: 'authentication_required', retryable: true, status: 401 }), 'authority');
    // An unnamed 401/403/410 is a transport/authority problem even without a
    // protocol `retryable` flag.
    assert.equal(classifyPushProblem({ code: 'gateway_denial', status: 401 }), 'authority');
    assert.equal(classifyPushProblem({ code: 'edge_denial', status: 403 }), 'authority');
    // Operation-level semantic refusals keep their permanent verdict, including
    // the 403-shaped ones (`node_read_only`) because the explicit flag precedes
    // the status class.
    assert.equal(classifyPushProblem({ code: 'invalid_document', retryable: false, status: 422 }), 'rejected');
    assert.equal(classifyPushProblem({ code: 'unsupported_operation', retryable: false }), 'rejected');
    assert.equal(classifyPushProblem({ code: 'node_read_only', retryable: false, status: 403 }), 'rejected');
    assert.equal(classifyPushProblem({ code: 'folder_not_empty', retryable: false }), 'rejected');
    // T-01 branch-order contract must survive the split.
    assert.equal(classifyPushProblem({ code: 'sequence_reuse', retryable: false }), 'reuse');
    assert.equal(classifyPushProblem({ code: 'service_unavailable', retryable: false }), 'rejected');
    assert.equal(classifyPushProblem({ code: 'node_read_only' }), 'unrecognized');
  });

  test('a second 401 after a successful refresh demands authority recovery instead of rejecting', async () => {
    const fixture = await setup(); const forced: boolean[] = []; const authorizations: string[] = [];
    const sessions = refreshingSessions(forced);
    const worker = createOutboundPushWorker({ ...fixture.options, sessions,
      fetch: async (_url, init) => {
        authorizations.push(new Headers(init?.headers).get('Authorization')!);
        return problem(401, 'authentication_required', { retryable: false });
      } });
    const outcome = await worker.drain();
    assert.equal(outcome.outcome, 'unknown');
    assert.notEqual(outcome.outcome, 'rejected');
    assert.ok((outcome.attention ?? 0) >= 1, 'an authority refusal is reported as attention');
    // The first 401 refreshes the credential; the second is routed by the
    // problem classifier instead of being lost in the refresh loop.
    assert.deepEqual(forced, [false, true]);
    assert.deepEqual(authorizations, ['Bearer old-access', 'Bearer fresh-access']);
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'unknown');
    assert.equal(queued.recovery?.code, 'push_authentication_rejected');
    const engine = await fixture.store.getEngineState(scope);
    assert.equal(engine?.recoveryFrozen, true);
    assert.equal(engine?.authorityRefreshRequired, true);
  });

  test.each([
    [410, 'stale_replica'], [410, 'replica_retired'],
  ] as const)('%s/%s keeps the row replayable and freezes the scope for authority recovery', async (status, code) => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(status, code, { retryable: false }) });
    const outcome = await worker.drain();
    assert.equal(outcome.outcome, 'unknown');
    assert.ok((outcome.attention ?? 0) >= 1);
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'unknown');
    assert.equal(queued.recovery?.code, code);
    const engine = await fixture.store.getEngineState(scope);
    assert.equal(engine?.recoveryFrozen, true);
    assert.equal(engine?.authorityRefreshRequired, true);
    const recorded = await fixture.store.getScope(scope);
    assert.equal(recorded?.lifecycle, 'recovery_required');
  });

  test('an unrecognized 401 escalates to authority recovery after a bounded number of replays', async () => {
    const fixture = await setup(); const forced: boolean[] = [];
    const worker = createOutboundPushWorker({ ...fixture.options, sessions: refreshingSessions(forced),
      fetch: async () => problem(401, 'gateway_denial') });
    for (let replay = 0; replay < 3; replay += 1) {
      const outcome = await worker.drain();
      assert.equal(outcome.outcome, 'unknown');
      const queued = (await fixture.store.listQueue(scope))[0]!;
      assert.equal(queued.status, 'unknown');
      assert.equal(queued.recovery?.code, 'push_denial_unrecognized');
      assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true,
        'the bounded replays must not freeze before the bound');
      fixture.clock.now = queued.retry.notBefore;
    }
    const escalated = await worker.drain();
    assert.equal(escalated.outcome, 'unknown');
    assert.notEqual(escalated.outcome, 'rejected');
    assert.ok((escalated.attention ?? 0) >= 1);
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'unknown');
    assert.equal(queued.recovery?.code, 'push_denial_escalated');
    const engine = await fixture.store.getEngineState(scope);
    assert.equal(engine?.recoveryFrozen, true);
    assert.equal(engine?.authorityRefreshRequired, true);
    assert.ok(forced.includes(true), 'the escalation forces a credential refresh');
  });

  test('a 410 with an unparseable problem body escalates instead of replaying identical bytes', async () => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => new Response('not-a-problem', { status: 410,
        headers: { 'Content-Type': 'application/problem+json' } }) });
    let last = await worker.drain();
    for (let replay = 0; replay < 3; replay += 1) {
      const queued = (await fixture.store.listQueue(scope))[0]!;
      fixture.clock.now = queued.retry.notBefore;
      last = await worker.drain();
    }
    assert.equal(last.outcome, 'unknown');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'unknown');
    assert.notEqual(queued.recovery?.code, 'rejected');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
  });

  // Acceptance fix (T-02 acc): a bodyless 401/403/410 never enters the Problem
  // branch, so it used to fall through to `push_response_unrecognized` and
  // replay identical bytes at capped backoff forever. The bounded escalation
  // must cover the authority status class itself, not only a malformed body.
  test.each([
    [401, 'push_denial_unrecognized'], [403, 'push_authority_response_invalid'],
    [410, 'push_authority_response_invalid'],
  ] as const)(
    'a bodyless %s authority response escalates instead of replaying identical bytes', async (status, replayCode) => {
      const fixture = await setup();
      const worker = createOutboundPushWorker({ ...fixture.options,
        fetch: async () => new Response('', { status }) });
      for (let replay = 0; replay < 3; replay += 1) {
        const outcome = await worker.drain();
        assert.equal(outcome.outcome, 'unknown');
        const queued = (await fixture.store.listQueue(scope))[0]!;
        assert.equal(queued.status, 'unknown');
        assert.equal(queued.recovery?.code, replayCode);
        assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true,
          'the bounded replays must not freeze before the bound');
        fixture.clock.now = queued.retry.notBefore;
      }
      const escalated = await worker.drain();
      assert.equal(escalated.outcome, 'unknown');
      assert.ok((escalated.attention ?? 0) >= 1);
      const queued = (await fixture.store.listQueue(scope))[0]!;
      assert.equal(queued.status, 'unknown');
      assert.equal(queued.recovery?.code, 'push_denial_escalated');
      assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
    });

  test.each([
    [403, 'node_read_only'], [409, 'folder_not_empty'], [422, 'unsupported_operation'],
    [422, 'invalid_document'],
  ] as const)('operation-level semantic refusal %s/%s still settles as rejected', async (status, code) => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(status, code, { retryable: false }) });
    assert.equal((await worker.drain()).outcome, 'rejected');
    const queued = (await fixture.store.listQueue(scope))[0]!;
    assert.equal(queued.status, 'rejected');
    assert.equal(queued.recovery?.code, code);
    assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
  });

  test('the authority handling does not change a retryable transport problem', async () => {
    const fixture = await setup();
    const worker = createOutboundPushWorker({ ...fixture.options,
      fetch: async () => problem(503, 'service_unavailable') });
    assert.equal((await worker.drain()).outcome, 'unknown');
    assert.equal((await fixture.store.listQueue(scope))[0]?.recovery?.code, 'service_unavailable');
    assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
  });
});
