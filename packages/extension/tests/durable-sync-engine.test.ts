import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { queueStatusProjection } from '../src/engine-public-stability.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { STOP_PROBE_DELAYS_MS } from '../src/sync-circuit-breaker.js';
import {
  abortFailure, ack, json, networkFailure, problem, emptyPullPage, recoverySnapshot,
  scope, seedLegacySpc2Bootstrap, setup, snapshot,
} from './durable-sync-engine-harness.js';

test.each(['mapping_identity_collision', 'create_ambiguous', 'create_evidence_missing'])(
  '%s stops all retries even if a previous recovery overwrote the engine error', async code => {
    const fixture = await setup();
    await freezeScopeRecovery(fixture.store, scope, code, () => fixture.clock.now);
    await fixture.store.transitionEngine(scope, { phase: 'recovery', recoveryFrozen: true,
      authorityRefreshRequired: true, lastError: 'recovery_authority_invalid', notBefore: 0,
      updatedAt: fixture.clock.now });
    for (const reason of ['alarm', 'manual', 'startup', 'online'] as const) {
      await fixture.engine.wake(reason, { connectivityRestored: reason === 'online' });
    }
    assert.deepEqual(fixture.sessionForces, []);
    assert.deepEqual(fixture.pullRequests, []);
    assert.deepEqual(fixture.snapshotRequests, []);
    assert.equal(fixture.push.calls, 0);
    assert.equal((await fixture.store.getScope(scope))?.metadata?.recoveryCode, code);
    fixture.store.close();
  });

test('ordinary Pull and Ack transitions retain the last Push receipt facts', async () => {
  const f = await setup();
  await f.store.transitionEngine(scope, { phase: 'idle', updatedAt: f.clock.now,
    recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0,
    lastPushServerCursor: 'push-cursor', lastPushOutcomeHint: 'repair' });
  f.pullResponses.push(json(200, emptyPullPage('cursor-1')));
  f.ackResponses.push(json(200, ack('cursor-1')));
  await f.engine.wake('manual');
  const state = await f.store.getEngineState(scope);
  assert.equal(state?.lastAckedCursor, 'cursor-1');
  assert.equal(state?.lastPushServerCursor, 'push-cursor');
  assert.equal(state?.lastPushOutcomeHint, 'repair');
});

// The engine's Push peer owns the claim→settle handoff: a drain that reports an
// outcome has already settled that exact queue row (outbound-push-worker.ts
// settleClaimedPush). The shared engine harness fake only replays an outcome
// string, so tests that must observe the durable row install the same
// claim→settle contract on top of it.
function installRejectedPushDrain(fixture: Awaited<ReturnType<typeof setup>>, recoveryCode: string) {
  const replay = fixture.push.drain.bind(fixture.push);
  fixture.push.drain = async () => {
    const result = await replay();
    if (result.outcome !== 'rejected') return result;
    const lease = await fixture.store.acquireLease(scope, 'engine-push-peer', fixture.clock.now, 60_000);
    const claimed = await fixture.store.claimNextQueue(scope, 'engine-push-peer', lease.fence, fixture.clock.now);
    if (!claimed) throw new Error('push_queue_empty');
    await fixture.store.settleClaimedPush(scope, claimed.sequence, 'engine-push-peer', lease.fence,
      { outcome: 'rejected', recovery: { code: recoveryCode } });
    return result;
  };
}

describe('P3-33 durable extension sync lifecycle', () => {
  test('persists Pull completion before creating and sending an Ack intent', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1'))); fixture.ackResponses.push(json(200, ack('cursor-1')));
    await fixture.engine.wake('manual');
    assert.deepEqual(fixture.order, ['resume', 'pull:cursor-0', 'stage:cursor-1', 'resume', 'ack:cursor-1']);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor.cursor, 'cursor-1'); assert.equal(exported.ackIntents[0]!.state, 'complete');
    assert.equal(exported.engine.phase, 'sleeping'); assert.equal(exported.engine.lastAckedCursor, 'cursor-1');
  });

  test('rejects an Ack whose replica or cursor does not match the durable intent', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, { ...ack('cursor-1'), replicaId: 'other-replica' }));
    await fixture.engine.wake('manual');
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.lastError, 'ack_invalid');
  });

  test('treats an expired Session as session_invalid before Pull', async () => {
    const fixture = await setup();
    fixture.clock.now = Date.parse('2100-01-01T00:00:00Z');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    await fixture.engine.wake('manual');
    assert.equal((await fixture.store.getEngineState(scope))!.lastError, 'session_invalid');
  });

  test('settles only the rejected operation, keeps projecting it, and still pulls the accepted facts', async () => {
    // retryable:false is a verdict about one operation, not about the replica:
    // the worker settles that exact row as terminal 'rejected' and nothing else
    // in the local projection is disproven. Freezing the scope and returning
    // early (the former behavior) misreported a single bad op as a replica-wide
    // divergence and starved the cursor for the facts the server did accept, so
    // the wake records the user-visible fact and continues into Pull.
    const fixture = await setup();
    await fixture.enqueue('op-rejected-1');
    fixture.push.outcomes = ['rejected'];
    installRejectedPushDrain(fixture, 'invalid_document');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));

    await fixture.engine.wake('manual');

    // Push first, then the full Pull→Ack sequence in the same wake.
    assert.deepEqual(fixture.order, ['push', 'resume', 'pull:cursor-0', 'stage:cursor-1', 'resume', 'ack:cursor-1']);
    const state = (await fixture.store.getEngineState(scope))!;
    assert.notEqual(state.phase, 'recovery');
    assert.equal(state.phase, 'sleeping');
    assert.equal(state.recoveryFrozen, false);
    assert.equal(state.authorityRefreshRequired, false);
    // No 1s freeze-reschedule: the wake sleeps on the normal Pull cadence.
    assert.deepEqual(fixture.scheduled, [30_000]);
    // The rejection is durable per-row truth: terminal status plus the server's
    // code, which is what keeps the public projection on 'rejected'
    // (engine-public-stability needsAttention path).
    const rejectedRows = await fixture.store.listQueue(scope, 'rejected');
    const allRows = await fixture.store.listQueue(scope);
    assert.equal(rejectedRows.length, 1);
    assert.equal(rejectedRows[0]?.opId, 'op-rejected-1');
    assert.equal(rejectedRows[0]?.recovery?.code, 'invalid_document');
    assert.equal(allRows[0]?.status, 'rejected');
    assert.equal(queueStatusProjection(allRows), 'rejected');

    // A terminal rejected row is never re-claimed: the next alarm pulls without
    // pushing at all.
    const firstWake = fixture.order.length;
    fixture.clock.now = state.notBefore;
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-2')));
    fixture.ackResponses.push(json(200, ack('cursor-2')));
    await fixture.engine.wake('manual');
    assert.deepEqual(fixture.order.slice(firstWake),
      ['resume', 'pull:cursor-1', 'stage:cursor-2', 'resume', 'ack:cursor-2']);
    assert.equal(fixture.push.calls, 1);
    assert.equal((await fixture.store.listQueue(scope))[0]?.status, 'rejected');
  });

  test('continues pulling within one wake while the server reports more events', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(
      json(200, { ...emptyPullPage('cursor-1'), hasMore: true }),
      json(200, emptyPullPage('cursor-2')),
    );
    fixture.ackResponses.push(json(200, ack('cursor-1')), json(200, ack('cursor-2')));
    await fixture.engine.wake('manual');
    assert.deepEqual(fixture.order, ['resume', 'pull:cursor-0', 'stage:cursor-1', 'resume', 'ack:cursor-1',
      'resume', 'pull:cursor-1', 'stage:cursor-2', 'resume', 'ack:cursor-2']);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor.cursor, 'cursor-2');
    assert.equal(exported.engine.phase, 'sleeping');
  });

  test('passes the authenticated Session handoff marker to the Pull applier', async () => {
    const fixture = await setup(); fixture.pullResponses.push(json(200, emptyPullPage('cursor-reissued'), {
      'Known-Sync-Cursor-Reissued': 'true',
    })); fixture.ackResponses.push(json(200, ack('cursor-reissued')));
    await fixture.engine.wake('manual');
    assert.deepEqual(fixture.pullCursorAuthorities, [{ reissued: true }]);
    assert.equal((await fixture.store.exportScope(scope)).cursor.cursor, 'cursor-reissued');
  });

  test('retries Ack response loss with the identical durable body and idempotency identity after restart', async () => {
    const fixture = await setup(); fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(networkFailure(), json(200, ack('cursor-1')));
    await fixture.engine.wake('alarm'); const first = fixture.ackRequests[0]!;
    fixture.clock.now = (await fixture.store.getEngineState(scope))!.notBefore;
    fixture.store.close(); await fixture.reopen().wake('startup');
    assert.equal(fixture.ackRequests.length, 2); assert.deepEqual(fixture.ackRequests[1], first);
    assert.equal((await fixture.store.exportScope(scope)).ackIntents[0]!.state, 'complete');
  });

  test('online wake interrupts only a durable network backoff before its deadline', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(networkFailure(), json(200, emptyPullPage('cursor-online')));
    fixture.ackResponses.push(json(200, ack('cursor-online')));
    await fixture.engine.wake('startup');
    const offline = (await fixture.store.getEngineState(scope))!;
    assert.equal(offline.phase, 'offline'); assert.equal(offline.lastError, 'network_unavailable');
    assert.ok(offline.notBefore > fixture.clock.now);

    fixture.store.close();
    await fixture.reopen().wake('online', { connectivityRestored: true });
    const recovered = (await fixture.store.getEngineState(scope))!;
    assert.equal(fixture.pullRequests.length, 2);
    assert.equal(recovered.phase, 'sleeping'); assert.equal(recovered.lastError, undefined);
    assert.equal(recovered.lastAckedCursor, 'cursor-online');
  });

  test('cold start confirms restored connectivity through one normal authenticated Pull', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(networkFailure('offline'), json(200, emptyPullPage('cursor-restarted')));
    fixture.ackResponses.push(json(200, ack('cursor-restarted')));
    await fixture.engine.wake('alarm');
    const offline = (await fixture.store.getEngineState(scope))!;
    assert.equal(offline.phase, 'offline'); assert.equal(offline.lastError, 'network_unavailable');

    fixture.store.close(); await fixture.reopen().wake('startup');

    const recovered = (await fixture.store.getEngineState(scope))!;
    assert.equal(fixture.pullRequests.length, 2);
    assert.equal(recovered.phase, 'sleeping'); assert.equal(recovered.lastError, undefined);
    assert.equal(recovered.connectivityConfirmationRevision, undefined);
    assert.equal(recovered.lastAckedCursor, 'cursor-restarted');
  });

  test('offline backoff ramps on an independent failure counter and resets after success (SYNC-F001)', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(networkFailure('offline'), networkFailure('still offline'));
    await fixture.engine.wake('alarm');
    const first = (await fixture.store.getEngineState(scope))!;
    // The FIRST network failure backs off from a fresh counter
    // (1000*2^1*0.5 with harness random=0.5), NOT from the engine revision
    // (several healthy transitions would already saturate the ramp).
    assert.equal(first.phase, 'offline');
    assert.equal(first.networkBackoffCount, 1);
    assert.equal(first.notBefore - fixture.clock.now, 1_000);

    // The second consecutive failure doubles the delay (2^2) — under the
    // old revision-keyed backoff this wake had grown the revision to 3+ and
    // charged 4s+ instead.
    fixture.clock.now = first.notBefore;
    await fixture.engine.wake('alarm');
    const second = (await fixture.store.getEngineState(scope))!;
    assert.equal(second.phase, 'offline');
    assert.equal(second.networkBackoffCount, 2);
    assert.equal(second.notBefore - fixture.clock.now, 2_000);

    // A successful pull clears the streak, so the next failure starts at 1s.
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-online')));
    fixture.ackResponses.push(json(200, ack('cursor-online')));
    fixture.clock.now = second.notBefore;
    await fixture.engine.wake('alarm');
    const recovered = (await fixture.store.getEngineState(scope))!;
    assert.equal(recovered.phase, 'sleeping');
    assert.equal(recovered.networkBackoffCount, 0);

    fixture.pullResponses.push(networkFailure('offline again'));
    fixture.clock.now = recovered.notBefore;
    await fixture.engine.wake('alarm');
    const again = (await fixture.store.getEngineState(scope))!;
    assert.equal(again.phase, 'offline');
    assert.equal(again.networkBackoffCount, 1);
    assert.equal(again.notBefore - fixture.clock.now, 1_000);
  });

  test('cold-start confirmation failure preserves a fresh durable network backoff', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(networkFailure('offline'), networkFailure('still offline'));
    await fixture.engine.wake('alarm'); const first = (await fixture.store.getEngineState(scope))!;

    fixture.store.close(); await fixture.reopen().wake('startup');

    const retry = (await fixture.store.getEngineState(scope))!;
    assert.equal(fixture.pullRequests.length, 2);
    assert.equal(retry.phase, 'offline'); assert.equal(retry.lastError, 'network_unavailable');
    assert.ok(retry.notBefore > fixture.clock.now); assert.notEqual(retry.notBefore, first.notBefore);
    assert.equal(retry.connectivityConfirmationRevision, undefined);
  });

  test('restart confirmation abort is classified as network unavailable and backs off', async () => {
    const fixture = await setup(); fixture.pullResponses.push(networkFailure('offline'),
      abortFailure());
    await fixture.engine.wake('alarm'); fixture.store.close(); await fixture.reopen().wake('startup');
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(fixture.pullRequests.length, 2); assert.equal(state.phase, 'offline');
    assert.equal(state.lastError, 'network_unavailable'); assert.ok(state.notBefore > fixture.clock.now);
    assert.equal(state.connectivityConfirmationRevision, undefined);
  });

  test('F036 a local TypeError defect is not classified as network unavailability', async () => {
    // A programming defect (for example a pull row vanishing between listing
    // and retrieval) rejects as a TypeError with no transport signature. It
    // must not masquerade as `network_unavailable`: that code never holds the
    // inbound Pull lane, so the engine would keep retrying a local integrity
    // fault as if it were connectivity.
    const fixture = await setup();
    fixture.pullResponses.push({ then(_resolve: (value: Response) => void,
      reject: (reason: unknown) => void) {
      reject(new TypeError("Cannot read properties of undefined (reading 'state')"));
    } } as unknown as Promise<Response>);
    await fixture.engine.wake('alarm');
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'offline');
    assert.equal(state.lastError, 'type_error');
  });

  test('F036 a transport-shaped TypeError still counts as network unavailability', async () => {
    const fixture = await setup();
    fixture.pullResponses.push({ then(_resolve: (value: Response) => void,
      reject: (reason: unknown) => void) {
      reject(new TypeError('Failed to fetch'));
    } } as unknown as Promise<Response>, json(200, emptyPullPage('cursor-online')));
    fixture.ackResponses.push(json(200, ack('cursor-online')));
    await fixture.engine.wake('startup');
    const offline = (await fixture.store.getEngineState(scope))!;
    assert.equal(offline.phase, 'offline'); assert.equal(offline.lastError, 'network_unavailable');
  });

  test('restart reachability does not bypass 429, authentication or protocol handling', async () => {
    for (const [label, response, expectedPhase, expectedError] of [
      ['rate limit', new Response(JSON.stringify({ code: 'rate_limited' }), { status: 429,
        headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '17' } }), 'sleeping', 'rate_limited'],
      ['authentication', problem(401, 'credential_revoked', {}), 'offline', 'credential_revoked'],
      ['protocol', json(200, { malformed: true }), 'error', 'pull_invalid'],
    ] as const) {
      const fixture = await setup(); fixture.pullResponses.push(networkFailure('offline'), response);
      await fixture.engine.wake('alarm'); fixture.store.close(); await fixture.reopen().wake('startup');
      const state = (await fixture.store.getEngineState(scope))!;
      assert.equal(fixture.pullRequests.length, 2, label); assert.equal(state.phase, expectedPhase, label);
      assert.equal(state.lastError, expectedError, label);
      if (expectedPhase === 'error') {
        // A reported stop, probed again after the first slow-probe delay (A-F5) instead of never.
        assert.equal(state.notBefore, fixture.clock.now + STOP_PROBE_DELAYS_MS[0], 'corrupt protocol data is a reported stop');
      }
      else assert.ok(state.notBefore > fixture.clock.now, label);
      assert.equal(state.connectivityConfirmationRevision, undefined, label);
      if (label === 'rate limit') assert.ok(state.notBefore >= fixture.clock.now + 17_000);
    }
  });

  test('atomically admits one cold-start confirmation across engine instances, online and alarms', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(networkFailure('offline'), networkFailure('confirmation unavailable'));
    await fixture.engine.wake('alarm');
    const first = fixture.engine; const second = fixture.reopen(); const third = fixture.reopen();

    await Promise.all([first.wake('startup'), second.wake('startup'),
      third.wake('online', { connectivityRestored: true }), second.wake('alarm')]);

    assert.equal(fixture.pullRequests.length, 2);
    const retry = (await fixture.store.getEngineState(scope))!;
    assert.equal(retry.phase, 'offline'); assert.equal(retry.lastError, 'network_unavailable');
    assert.equal(retry.connectivityConfirmationRevision, undefined);
  });

  test('does not interrupt persisted network backoff without confirmed browser connectivity restoration', async () => {
    const fixture = await setup(); fixture.pullResponses.push(networkFailure('offline'));
    await fixture.engine.wake('startup');
    const offline = (await fixture.store.getEngineState(scope))!;
    fixture.store.close(); const reopened = await fixture.reopen();

    await reopened.wake('online');
    await reopened.wake('online', { connectivityRestored: false });
    await reopened.wake('alarm');

    assert.equal(fixture.pullRequests.length, 1);
    assert.equal((await fixture.store.getEngineState(scope))!.notBefore, offline.notBefore);
  });

  test('confirmed online never bypasses non-network or recovery authority cooldowns', async () => {
    for (const [label, phase, lastError, recoveryFrozen, authorityRefreshRequired] of [
      ['rate limit', 'sleeping', 'rate_limited', false, false],
      ['credential', 'offline', 'credential_revoked', false, false],
      ['Session', 'offline', 'session_invalid', false, false],
      ['Snapshot protocol', 'offline', 'snapshot_chain_invalid', false, false],
      ['Push protocol', 'offline', 'push_failed', false, false],
      ['Pull protocol', 'offline', 'pull_invalid', false, false],
      ['constraint', 'offline', 'constraint_error', false, false],
      ['recovery freeze', 'recovery', 'network_unavailable', true, false],
      ['authority refresh', 'recovery', 'network_unavailable', true, true],
    ] as const) {
      const fixture = await setup(); const notBefore = fixture.clock.now + 60_000;
      await fixture.store.transitionEngine(scope, { phase, updatedAt: fixture.clock.now,
        recoveryFrozen, authorityRefreshRequired, notBefore, lastError });

      await fixture.engine.wake('online', { connectivityRestored: true });

      const state = (await fixture.store.getEngineState(scope))!;
      assert.equal(state.notBefore, notBefore, label);
      assert.equal(state.lastError, lastError, label);
      assert.equal(fixture.sessionForces.length, 0, label);
      assert.equal(fixture.pullRequests.length, 0, label);
    }
  });

  test('cold start never bypasses rate-limit, auth, protocol, recovery or authority cooldowns', async () => {
    for (const [label, phase, lastError, recoveryFrozen, authorityRefreshRequired] of [
      ['rate limit', 'sleeping', 'rate_limited', false, false],
      ['credential', 'offline', 'credential_revoked', false, false],
      ['protocol', 'offline', 'pull_invalid', false, false],
      ['constraint', 'offline', 'constraint_error', false, false],
      ['recovery', 'recovery', 'network_unavailable', true, false],
      ['authority', 'recovery', 'network_unavailable', true, true],
    ] as const) {
      const fixture = await setup(); const notBefore = fixture.clock.now + 60_000;
      await fixture.store.transitionEngine(scope, { phase, updatedAt: fixture.clock.now,
        recoveryFrozen, authorityRefreshRequired, notBefore, lastError });
      await fixture.engine.wake('startup');
      const state = (await fixture.store.getEngineState(scope))!;
      assert.equal(state.notBefore, notBefore, label); assert.equal(state.lastError, lastError, label);
      assert.equal(fixture.pullRequests.length, 0, label); assert.equal(fixture.sessionForces.length, 0, label);
    }
  });

  test('classifies a contextual protocol failure without persisting its opaque identifier', async () => {
    const fixture = await setup();
    fixture.sessionFailures.push(new Error('mapping_missing:opaque-resource-id'));

    await fixture.engine.wake('manual');

    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'offline');
    assert.equal(state.lastError, 'mapping_missing');
  });

  test('IndexedDB AbortError is not classified as network_unavailable', async () => {
    const fixture = await setup();
    fixture.sessionFailures.push(new DOMException('The transaction was aborted.', 'AbortError'));
    await fixture.engine.wake('manual');
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'offline');
    assert.equal(state.lastError, 'transaction_aborted');
  });

  test('wake finishes a leftover staged Pull page before requesting the next page', async () => {
    const fixture = await setup();
    await fixture.store.stagePullPage(scope, {
      pageId: 'leftover-page', previousCursor: 'cursor-0', nextCursor: 'cursor-leftover',
      collectionRevision: 'revision-leftover', pageDigest: 'sha256:leftover', events: [], effectPages: [],
    });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after')));
    fixture.ackResponses.push(json(200, ack('cursor-after')));
    await fixture.engine.wake('manual');
    const resumeAt = fixture.order.indexOf('resume');
    const pullAt = fixture.order.findIndex((step) => step.startsWith('pull:'));
    assert.ok(resumeAt >= 0 && pullAt > resumeAt);
    assert.equal(fixture.order[pullAt], 'pull:cursor-leftover');
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-after');
  });

  test('classifies a browser DOMException by name without persisting its prose message', async () => {
    const fixture = await setup();
    fixture.sessionFailures.push(new DOMException('Browser-specific transaction prose', 'ConstraintError'));

    await fixture.engine.wake('manual');

    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'offline');
    assert.equal(state.lastError, 'constraint_error');
  });

  test('cold start immediately resumes an interrupted push despite an inherited cycle cooldown', async () => {
    const fixture = await setup(); await fixture.enqueue('interrupted-1'); await fixture.markAttempt(1);
    fixture.push.outcomes.push('unknown');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));
    await fixture.store.transitionEngine(scope, { phase: 'pushing', updatedAt: fixture.clock.now,
      recoveryFrozen: false, authorityRefreshRequired: false, notBefore: fixture.clock.now + 60_000 });

    fixture.store.close(); await fixture.reopen().wake('startup');

    assert.equal(fixture.push.calls, 1);
    assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping');
  });

  test('confirmed online immediately resumes an interrupted push when startup is not emitted', async () => {
    const fixture = await setup(); await fixture.enqueue('interrupted-online-1'); await fixture.markAttempt(1);
    fixture.push.outcomes.push('unknown');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));
    const offline = await fixture.store.transitionEngine(scope, { phase: 'offline', updatedAt: fixture.clock.now,
      recoveryFrozen: false, authorityRefreshRequired: false, notBefore: fixture.clock.now + 60_000,
      lastError: 'network_unavailable' });
    const claimed = await fixture.store.claimRestartConnectivity(scope, offline.revision, fixture.clock.now, 15_000);
    assert.equal(claimed.outcome, 'claimed');
    await fixture.store.transitionEngine(scope, { phase: 'pushing', updatedAt: fixture.clock.now,
      recoveryFrozen: false, authorityRefreshRequired: false, notBefore: claimed.state.notBefore,
      connectivityConfirmationRevision: claimed.state.connectivityConfirmationRevision });

    fixture.store.close(); await fixture.reopen().wake('online', { connectivityRestored: true });

    assert.equal(fixture.push.calls, 1);
    assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping');
  });

  test('does not re-probe a live restart claim until its deadline and rejects a stale revision', async () => {
    const fixture = await setup(); fixture.pullResponses.push(networkFailure('offline'));
    await fixture.engine.wake('alarm'); const offline = (await fixture.store.getEngineState(scope))!;
    const claimed = await fixture.store.claimRestartConnectivity(scope, offline.revision, fixture.clock.now, 15_000);
    assert.equal(claimed.outcome, 'claimed');
    const stale = await fixture.store.claimRestartConnectivity(scope, offline.revision, fixture.clock.now, 15_000);
    assert.equal(stale.outcome, 'stale');

    await Promise.all([fixture.engine.wake('startup'), fixture.reopen().wake('startup'), fixture.reopen().wake('alarm')]);
    assert.equal(fixture.pullRequests.length, 1);
    assert.equal((await fixture.store.getEngineState(scope))!.connectivityConfirmationRevision,
      claimed.state.connectivityConfirmationRevision);
  });

  test('does not reclaim an expired connectivity confirmation after recovery authority freezes', async () => {
    const fixture = await setup(); fixture.pullResponses.push(networkFailure('offline'));
    await fixture.engine.wake('alarm'); const offline = (await fixture.store.getEngineState(scope))!;
    const claimed = await fixture.store.claimRestartConnectivity(scope, offline.revision, fixture.clock.now, 15_000);
    assert.equal(claimed.outcome, 'claimed');
    await fixture.store.transitionEngine(scope, { phase: 'recovery', updatedAt: fixture.clock.now,
      recoveryFrozen: true, authorityRefreshRequired: true, notBefore: claimed.state.notBefore,
      connectivityConfirmationRevision: claimed.state.connectivityConfirmationRevision,
      lastError: 'network_unavailable' });
    fixture.clock.now = claimed.state.notBefore;

    const before = (await fixture.store.getEngineState(scope))!;
    const rejected = await fixture.store.claimRestartConnectivity(scope, before.revision, fixture.clock.now, 15_000);

    assert.equal(rejected.outcome, 'ineligible'); assert.deepEqual(rejected.state, before);
  });

  test('coalesces concurrent confirmed online wakes and durably backs off when the retry still fails', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(networkFailure('offline'), networkFailure('network still unavailable'),
      json(200, emptyPullPage('cursor-after-online-retry')));
    fixture.ackResponses.push(json(200, ack('cursor-after-online-retry')));
    await fixture.engine.wake('startup');

    await Promise.all([
      fixture.engine.wake('online', { connectivityRestored: true }),
      fixture.engine.wake('online', { connectivityRestored: true }),
      fixture.engine.wake('online', { connectivityRestored: true }),
    ]);
    const retryBackoff = (await fixture.store.getEngineState(scope))!;
    assert.equal(fixture.pullRequests.length, 2);
    assert.equal(retryBackoff.phase, 'offline');
    assert.equal(retryBackoff.lastError, 'network_unavailable');
    assert.ok(retryBackoff.notBefore > fixture.clock.now);

    await fixture.engine.wake('online');
    assert.equal(fixture.pullRequests.length, 2);
    fixture.clock.now = retryBackoff.notBefore;
    await fixture.engine.wake('alarm');
    assert.equal(fixture.pullRequests.length, 3);
    assert.equal((await fixture.store.getEngineState(scope))!.lastAckedCursor, 'cursor-after-online-retry');
  });

  test('atomically consumes one persisted network backoff across concurrent engine instances', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(networkFailure('offline'), networkFailure('still offline'));
    await fixture.engine.wake('startup');
    const first = fixture.engine; const second = fixture.reopen();

    await Promise.all([
      first.wake('online', { connectivityRestored: true }),
      second.wake('online', { connectivityRestored: true }),
    ]);

    assert.equal(fixture.pullRequests.length, 2);
    const retryBackoff = (await fixture.store.getEngineState(scope))!;
    assert.equal(retryBackoff.phase, 'offline');
    assert.equal(retryBackoff.lastError, 'network_unavailable');
    assert.ok(retryBackoff.notBefore > fixture.clock.now);
  });

  test('keeps the durable Ack session header when the current Session rotates after response loss', async () => {
    const fixture = await setup(); fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(networkFailure(), json(200, ack('cursor-1')));
    await fixture.engine.wake('alarm'); const first = fixture.ackRequests[0]!;
    fixture.clock.now = (await fixture.store.getEngineState(scope))!.notBefore;
    fixture.sessionId = 'session-renewed'; fixture.store.close(); await fixture.reopen().wake('startup');
    assert.deepEqual(fixture.ackRequests[1], first);
    assert.equal(fixture.ackRequests[1]!.headerSession, 'session-engine');
  });

  test('finishes the earliest exact Push retry before Pull and keeps dependent allocations closed', async () => {
    // Runbook order: exact Push retry → Pull → Ack. An indeterminate push
    // settlement (5xx → unknown) must not cancel Pull: the retry alarm fires
    // exactly when the retry is due, so skipping Pull on every failed retry
    // starved the cursor for as long as the server kept failing push — and
    // Pull facts are what resolves unknown/blocked rows in the first place.
    // F010 (T-06): the unsettled attempt holds only work that references the
    // unresolved operation, never every later allocation.
    const fixture = await setup(); fixture.push.outcomes.push('unknown');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));
    await fixture.enqueue('op-1'); await fixture.markAttempt(1);
    await fixture.enqueue('op-2');
    await assert.rejects(() => fixture.enqueue('op-3', { type: 'update_node_content', targetId: 'pending-op-1' }),
      /exact_retry_pending/);
    await fixture.engine.wake('online');
    assert.deepEqual(fixture.order, ['push', 'resume', 'pull:cursor-0', 'stage:cursor-1', 'resume', 'ack:cursor-1']);
    assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping');
  });

  test('yields the whole wake without pulling when another owner holds the drain', async () => {
    const fixture = await setup(); fixture.push.outcomes.push('contended');
    await fixture.enqueue('op-1'); await fixture.markAttempt(1);
    await fixture.engine.wake('online');
    assert.deepEqual(fixture.order, ['push']);
    assert.equal(fixture.pullRequests.length, 0);
  });

  test('binds and pushes a fresh durable operation before Pull', async () => {
    const fixture = await setup(); fixture.push.outcomes.push('terminal');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-1'))); fixture.ackResponses.push(json(200, ack('cursor-1')));
    await fixture.enqueue('op-1');
    await fixture.engine.wake('online');
    assert.deepEqual(fixture.order.slice(0, 3), ['push', 'resume', 'pull:cursor-0']);
  });

  test('freezes outbound queue while a complete Snapshot chain is staged and atomically cut over', async () => {
    const fixture = await setup({ snapshotRequired: true, useStandInProjector: true }); await fixture.enqueue('op-frozen');
    fixture.snapshotResponses.push(json(200, snapshot(1, true, 'page-2')), json(200, snapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ sessionId: 'session-active', state: 'active', snapshotRequired: false,
      cursor: 'bootstrap-cursor' });
    fixture.crashAt = 'after_snapshot_page'; await assert.rejects(() => fixture.engine.wake('startup'), /worker_crash/);
    assert.equal(fixture.push.calls, 0); assert.equal(fixture.projectCalls, 0);
    assert.equal((await fixture.store.listMappings(scope)).length, 1);
    fixture.crashAt = undefined; fixture.store.close(); await fixture.reopen().wake('startup');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.ackIntents[0]!.kind, 'bootstrap'); assert.equal(exported.ackIntents[0]!.state, 'complete');
    assert.equal(exported.engine.recoveryFrozen, false); assert.equal(fixture.push.calls, 0);
    assert.equal(fixture.snapshotOrigins[0], 'chrome-extension://known-extension');
    assert.deepEqual(fixture.snapshotRequests.map((request) => new URL(request.url).searchParams.get('sessionId')),
      ['session-engine', 'session-engine']);
    assert.deepEqual(fixture.snapshotRequests.map((request) => request.headerSession),
      ['session-engine', 'session-engine']);
    assert.equal(exported.cursor?.cursor, 'bootstrap-cursor');
    assert.deepEqual(exported.mappings.map((item: any) => item.colpId).sort(), ['node-a', 'root-server']);
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-bootstrap')));
    fixture.ackResponses.push(json(200, ack('cursor-after-bootstrap')));
    fixture.clock.now = (await fixture.store.getEngineState(scope))!.notBefore;
    await fixture.reopen().wake('manual');
    assert.equal(new URL(fixture.pullRequests[0]!).searchParams.get('cursor'), 'bootstrap-cursor');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, false);
    assert.deepEqual(fixture.sessionForces, [false, false, true, false]);
  });

  test('persists authority refresh on cursor expiry and does not Snapshot under the stale Session', async () => {
    const fixture = await setup(); fixture.pullResponses.push(problem(410, 'sync_cursor_expired', {
      snapshotUrl: 'https://known.example/v1/snapshot' }));
    await fixture.engine.wake('alarm'); const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.phase, 'recovery'); assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    assert.equal(fixture.scheduled.at(-1), 1_000);
    assert.equal(fixture.snapshotRequests.length, 0); assert.deepEqual(fixture.sessionForces, [false]);
    assert.equal(fixture.ackRequests.length, 0); assert.equal(fixture.push.calls, 0);
  });

  test('schedules and rebases onto a renewed Session when the prior Pull cursor has the old Session scope', async () => {
    const fixture = await setup(); fixture.pullResponses.push(problem(400, 'invalid_cursor_scope', {}));
    await fixture.engine.wake('alarm');
    assert.equal(fixture.scheduled.at(-1), 1_000);
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-renewed' });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-renewal')));
    fixture.ackResponses.push(json(200, ack('cursor-after-renewal')));
    await fixture.engine.wake('alarm'); const exported = await fixture.store.exportScope(scope);
    assert.deepEqual(fixture.sessionForces, [false, true]);
    assert.equal(new URL(fixture.pullRequests[1]!).searchParams.get('cursor'), 'cursor-renewed');
    assert.equal(exported.engine.authorityRefreshRequired, false);
    assert.equal(exported.engine.recoveryFrozen, false);
  });

  test('reclassifies generic stale_replica through a forced Session and resumes Pull when authority is active', async () => {
    const fixture = await setup(); fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm'); fixture.store.close();
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-renewed' });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-renewal')));
    fixture.ackResponses.push(json(200, ack('cursor-after-renewal')));
    await fixture.reopen().wake('startup'); const exported = await fixture.store.exportScope(scope);
    assert.deepEqual(fixture.sessionForces, [false, true]);
    assert.equal(fixture.snapshotRequests.length, 0);
    assert.equal(new URL(fixture.pullRequests[1]!).searchParams.get('cursor'), 'cursor-renewed');
    assert.equal(exported.engine.authorityRefreshRequired, false);
    assert.equal(exported.engine.recoveryFrozen, false);
  });

  test('keeps normal active authority stable while concurrent wakes observe Session Retry-After', async () => {
    const fixture = await setup();
    fixture.sessionFailures.push(Object.assign(new Error('rate_limited'), {
      code: 'rate_limited', retryAfterMilliseconds: 3_000,
    }));
    await Promise.all([fixture.engine.wake('manual'),
      fixture.engine.wake('online', { connectivityRestored: true }), fixture.engine.wake('alarm')]);
    let exported = await fixture.store.exportScope(scope);
    assert.deepEqual(fixture.sessionForces, [false]);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.engine.authorityRefreshRequired, false);
    assert.equal(exported.engine.lastError, 'rate_limited');
    assert.equal(exported.scope?.checkpoint?.cursor, 'cursor-0');
    assert.equal(exported.engine.notBefore, fixture.clock.now + 3_000);

    fixture.clock.now += 3_000;
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-active-converged')));
    fixture.ackResponses.push(json(200, ack('cursor-active-converged')));
    await fixture.engine.wake('alarm'); exported = await fixture.store.exportScope(scope);
    assert.deepEqual(fixture.sessionForces, [false, false]);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.engine.lastError, undefined);
    assert.equal(exported.engine.lastAckedCursor, 'cursor-active-converged');
    assert.equal(new URL(fixture.pullRequests[0]!).searchParams.get('cursor'), 'cursor-0');
  });

  test('coalesces concurrent recovery wakes across Session 429 Retry-After and converges without offline state', async () => {
    const fixture = await setup(); fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.sessionFailures.push(Object.assign(new Error('rate_limited'), {
      code: 'rate_limited', retryAfterMilliseconds: 4_000,
    }));
    await Promise.all([fixture.engine.wake('online', { connectivityRestored: true }),
      fixture.engine.wake('manual'), fixture.engine.wake('alarm')]);
    let exported = await fixture.store.exportScope(scope);
    assert.deepEqual(fixture.sessionForces, [false, true]);
    assert.equal(exported.engine.phase, 'recovery');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    assert.equal(exported.engine.lastError, 'rate_limited');
    assert.equal(exported.engine.notBefore, fixture.clock.now + 4_000);

    fixture.clock.now += 4_000;
    fixture.forcedSessions.push({ sessionId: 'session-active-after-limit', state: 'active',
      snapshotRequired: false, cursor: 'cursor-after-limit' });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-converged')));
    fixture.ackResponses.push(json(200, ack('cursor-converged')));
    await fixture.engine.wake('alarm'); exported = await fixture.store.exportScope(scope);
    assert.deepEqual(fixture.sessionForces, [false, true, true]);
    assert.equal(exported.engine.phase, 'sleeping');
    assert.equal(exported.engine.recoveryFrozen, false);
    assert.equal(exported.engine.authorityRefreshRequired, false);
    assert.equal(exported.engine.lastError, undefined);
    assert.equal(exported.engine.lastAckedCursor, 'cursor-converged');
    assert.equal(new URL(fixture.pullRequests.at(-1)!).searchParams.get('cursor'), 'cursor-after-limit');
  });

  test('reclassifies cursor expiry into explicit recovery authority before requesting a recovery Snapshot', async () => {
    const fixture = await setup({ useStandInProjector: true }); fixture.pullResponses.push(problem(410, 'sync_cursor_expired', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: true, cursor: 'cursor-stale' });
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-2')),
      json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' });
    await fixture.engine.wake('online'); const exported = await fixture.store.exportScope(scope);
    assert.deepEqual(fixture.sessionForces, [false, true, true]);
    assert.equal(fixture.snapshotRequests.length, 2);
    const firstSnapshot = new URL(fixture.snapshotRequests[0]!.url);
    assert.deepEqual([...firstSnapshot.searchParams.keys()], ['sessionId', 'limit']);
    assert.equal(firstSnapshot.searchParams.get('sessionId'), 'session-renewed');
    assert.equal(firstSnapshot.searchParams.get('limit'), '100');
    const secondSnapshot = new URL(fixture.snapshotRequests[1]!.url);
    assert.deepEqual([...secondSnapshot.searchParams.keys()], ['sessionId', 'limit', 'pageCursor']);
    assert.equal(secondSnapshot.searchParams.get('pageCursor'), 'page-2');
    assert.equal(exported.engine.authorityRefreshRequired, false);
    assert.equal(exported.cursor.cursor, 'cursor-recovered');
    const ackDocument = JSON.parse(fixture.ackRequests[0]!.body) as { readonly cursor?: unknown;
      readonly recoveryCapability?: unknown; readonly sessionId?: unknown };
    assert.equal(ackDocument.cursor, 'bootstrap-cursor');
    assert.equal(ackDocument.recoveryCapability, 'src1.recovery-capability');
    assert.equal(ackDocument.sessionId, 'session-renewed');
  });

  test('drops a staged page cursor when recovery authority rotates to a new Session after restart', async () => {
    const fixture = await setup(); fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ sessionId: 'session-recovery-1', state: 'active', snapshotRequired: true,
      cursor: 'cursor-stale-1' });
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-old-session')));
    fixture.crashAt = 'after_snapshot_page';
    await assert.rejects(() => fixture.engine.wake('online'), /worker_crash/);
    await fixture.store.transitionEngine(scope, { phase: 'recovery', updatedAt: fixture.clock.now,
      recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0, sessionId: 'session-recovery-1' });
    fixture.store.close();
    fixture.forcedSessions.push({ sessionId: 'session-recovery-2', state: 'active', snapshotRequired: true,
      cursor: 'cursor-stale-2' });
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-new-session')),
      json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ sessionId: 'session-active-2', state: 'active', snapshotRequired: false,
      cursor: 'cursor-recovered' });
    await fixture.reopen().wake('online');
    const retriedFirstPage = new URL(fixture.snapshotRequests[1]!.url);
    assert.equal(retriedFirstPage.searchParams.get('sessionId'), 'session-recovery-2');
    assert.equal(retriedFirstPage.searchParams.has('pageCursor'), false);
    assert.equal(new URL(fixture.snapshotRequests[2]!.url).searchParams.get('pageCursor'), 'page-new-session');
  });

  test('rejects a normal spc2 Snapshot before browser projection or bootstrap intent publication', async () => {
    const fixture = await setup(); fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: true, cursor: 'cursor-stale' });
    fixture.snapshotResponses.push(json(200, snapshot(1, false, null)));
    await fixture.engine.wake('online'); const exported = await fixture.store.exportScope(scope);
    assert.equal(fixture.projectCalls, 0); assert.equal(exported.cursor, null);
    assert.equal(exported.ackIntents.length, 0); assert.equal(exported.recoveryNodes.length, 0);
    assert.equal(exported.engine.recoveryFrozen, true);
  });

  test('pins the refreshed recovery Session across a bounded Snapshot Problem and retries from page one', async () => {
    const fixture = await setup({ useStandInProjector: true }); fixture.pullResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    fixture.forcedSessions.push({ sessionId: 'session-recovery-pinned', state: 'active',
      snapshotRequired: true, cursor: 'cursor-stale' });
    // `invalid_json` stands for any Problem with no policy of its own (B-08 registered `invalid_query` as a stop).
    fixture.snapshotResponses.push(problem(400, 'invalid_json', { sessionId: 'must-not-be-retained' }));
    await fixture.engine.wake('online'); const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.engine.phase, 'recovery');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, false);
    assert.equal(exported.engine.sessionId, 'session-recovery-pinned');
    assert.equal(exported.engine.lastError, 'snapshot_400_invalid_json');
    assert.doesNotMatch(JSON.stringify(exported.engine), /must-not-be-retained/u);
    fixture.snapshotResponses.push(json(200, recoverySnapshot(1, true, 'page-retry')),
      json(200, recoverySnapshot(2, false, null)));
    fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
    fixture.forcedSessions.push({ sessionId: 'session-active-after-recovery', state: 'active',
      snapshotRequired: false, cursor: 'cursor-recovered' });
    fixture.clock.now = exported.engine.notBefore;
    await fixture.engine.wake('online');
    assert.deepEqual(fixture.sessionForces, [false, true, false, true]);
    const retried = new URL(fixture.snapshotRequests[1]!.url);
    assert.equal(retried.searchParams.get('sessionId'), 'session-recovery-pinned');
    assert.equal(retried.searchParams.has('pageCursor'), false);
  });

  test('keeps authority refresh durable across restart after a stale bootstrap Ack and never retries that intent', async () => {
    const fixture = await setup();
    await seedLegacySpc2Bootstrap(fixture.store);
    fixture.ackResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('startup'); let exported = await fixture.store.exportScope(scope);
    assert.equal(exported.ackIntents.length, 0);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    const rejectedRequest = fixture.ackRequests[0]; fixture.store.close();
    fixture.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-renewed' });
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-renewal')));
    fixture.ackResponses.push(json(200, ack('cursor-after-renewal')));
    fixture.clock.now += 1_000;
    await fixture.reopen().wake('startup'); exported = await fixture.store.exportScope(scope);
    assert.equal(fixture.ackRequests.filter((request) => request === rejectedRequest).length, 1);
    assert.equal(fixture.projectCalls, 0); assert.equal(fixture.snapshotRequests.length, 0);
    assert.equal(exported.engine.authorityRefreshRequired, false);
  });

  test('SYNC-F003: an oversized recommendedPullAfterSeconds is clamped to the backend max', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, {
      ...emptyPullPage('cursor-1'), recommendedPullAfterSeconds: 1_000_000,
    }));
    fixture.ackResponses.push(json(200, ack('cursor-1')));
    await fixture.engine.wake('alarm');
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'sleeping');
    // Without the clamp the server response would park the replica for
    // ~11.5 days; the clamp caps the advisory cadence at the backend max.
    assert.equal(state.notBefore - fixture.clock.now, 86_400_000);
  });

  test('SYNC-F015 page-1 acked then page-2 network failure resumes at the acked cursor', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, { ...emptyPullPage('cursor-1'), hasMore: true }));
    fixture.ackResponses.push(json(200, ack('cursor-1')));
    fixture.pullResponses.push(networkFailure('page-2 down'));
    await fixture.engine.wake('alarm');
    const offline = (await fixture.store.getEngineState(scope))!;
    assert.equal(offline.phase, 'offline');
    // Page one Acked (cursor-1) before page two failed — the durable cursor
    // must NOT be lost or rewound on the retry.
    assert.deepEqual(fixture.order,
      ['resume', 'pull:cursor-0', 'stage:cursor-1', 'resume', 'ack:cursor-1',
        'resume', 'pull:cursor-1']);

    fixture.pullResponses.push(json(200, emptyPullPage('cursor-2')));
    fixture.ackResponses.push(json(200, ack('cursor-2')));
    fixture.clock.now = offline.notBefore;
    await fixture.reopen().wake('startup');
    assert.deepEqual(fixture.order.slice(-5),
      ['resume', 'pull:cursor-1', 'stage:cursor-2', 'resume', 'ack:cursor-2']);
    assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping');
  });

  test('SYNC-F005 a late MV3 alarm wake converges without spinning', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-online')),
      json(200, emptyPullPage('cursor-next')));
    fixture.ackResponses.push(json(200, ack('cursor-online')), json(200, ack('cursor-next')));
    await fixture.engine.wake('alarm');
    // Chromium clamps sub-minute alarms to ~30s: the wake the engine asked
    // for at ~1s fires only at +30s. Both the freshly-scheduled idle sleep
    // AND the late alarm would then fire; the engine must converge on the
    // normal idle sleep and not spin an extra empty pull per alarm.
    fixture.clock.now += 30_000;
    await fixture.engine.wake('alarm');
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'sleeping');
    // One pull per wake; the late wake did not duplicate work.
    assert.equal(fixture.pullRequests.filter((u) => new URL(u).searchParams.get('cursor') === 'cursor-next').length, 0,
      'the late wake must not re-pull already-settled content');
    assert.deepEqual(fixture.order, [
      'resume', 'pull:cursor-0', 'stage:cursor-online', 'resume', 'ack:cursor-online',
      'resume', 'pull:cursor-online', 'stage:cursor-next', 'resume', 'ack:cursor-next',
    ]);
  });

  test('a discarded pull Ack enters recovery with authority refresh and stops paging mid-wake (SYNC-F002)', async () => {
    const fixture = await setup();
    // A multi-page pull: page one advances the cursor and says more remains.
    fixture.pullResponses.push(json(200, { ...emptyPullPage('cursor-1'), hasMore: true }));
    // The pull Ack for that page is invalidated server-side.
    fixture.ackResponses.push(problem(410, 'stale_replica', {}));
    await fixture.engine.wake('alarm');
    const exported = await fixture.store.exportScope(scope);
    // Exactly one pull + one Ack happened; the discarded Ack must NOT let the
    // wake continue pulling page two against the invalidated cursor.
    assert.deepEqual(fixture.order,
      ['resume', 'pull:cursor-0', 'stage:cursor-1', 'resume', 'ack:cursor-1']);
    assert.equal(fixture.pullRequests.length, 1);
    // The invalidated intent was discarded and the engine handed authority
    // to recovery, exactly like the top-level pendingAck 'discarded' path.
    assert.equal(exported.ackIntents.length, 0);
    assert.equal(exported.engine.phase, 'recovery');
    assert.equal(exported.engine.recoveryFrozen, true);
    assert.equal(exported.engine.authorityRefreshRequired, true);
    assert.equal(exported.engine.lastError, 'pull_ack_discarded');
    assert.deepEqual(fixture.scheduled, [1_000]);
  });

});
