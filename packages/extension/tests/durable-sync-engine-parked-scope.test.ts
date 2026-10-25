/**
 * S7 / B2 (SR-09 A-07 · SR-04/SR-13 A-10): the durable half of "a park is not a
 * freeze, and a terminal freeze still has a UI".
 *
 * A-07 (`confirm` policy): an `awaiting_confirmation` pull event parks inbound
 * Pull/Ack — the engine's pull loop returns before any network read — while Push
 * still runs first in the same wake (`durable-sync-engine.ts` push phase precedes
 * the Pull call) and nothing is frozen. The control cases prove the parked pull
 * page is what stopped the read: the same fixture without a wait pulls and acks,
 * and the same scope pulls again once the wait is settled the way
 * `confirmNativeWait` settles it.
 *
 * A-10: the terminal gate returns before every network phase, so the frozen
 * replica retries nothing. That is exactly why the read-only attention
 * projection and the popup/settings view must still classify it and render the
 * copy + diagnostics + rebuild exit.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { describeSyncAttention, syncAttentionInput } from '../src/sync-attention-ui.js';
import type { RemoteDeleteResponse } from '../src/types.js';
import { ack, json, problem, pullPage, scope, setup } from './durable-sync-engine-harness.js';

type Fixture = Awaited<ReturnType<typeof setup>>;

const SYNC_CENTER = 'https://known.example/sync';

/**
 * Writes the T-02/remote-delete shape as a durable fact: one event the applier
 * parked for the user (`awaiting_confirmation`) plus a live apply intent, so
 * `projectNativeWaits` and the engine's park predicate both see it.
 *
 * The page it arrives on is committed first on purpose: this file's subject is
 * the engine's park/Push contract, not the applier that raises the wait, and the
 * harness's named Ack-only stand-in applier would otherwise try to complete the
 * leftover page itself (its `resume()` is a cursor-only double). The parked
 * event state is the same durable fact the real paths write through
 * `persistApplyIntentFacts`.
 */
async function seedAwaitingConfirmation(fixture: Fixture): Promise<void> {
  await fixture.store.stagePullPage(scope, {
    pageId: 'page-parked', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
    collectionRevision: 'revision-1', pageDigest: 'sha256:page-parked',
    events: [{ eventId: 'event-parked', cursor: 'cursor-1', operationId: 'op-parked',
      effectId: 'effect-parked', effectDigest: 'sha256:effect-parked',
      operationDigest: 'sha256:operation-parked', kind: 'node_content_updated', payload: {},
      initialState: 'staged' }],
    effectPages: [],
  });
  await fixture.store.preparePullIntent(scope, 'event-parked', {
    intentId: 'intent:parked', correlationId: 'corr:parked', operationId: 'op-parked',
    eventId: 'event-parked', effectId: 'effect-parked', state: 'intent_prepared',
    expected: { kind: 'change', nativeId: 'native-root' }, expiresAt: Date.now() + 60_000,
    // Matches the root mapping's digest, so the page has no concurrent-mutation block.
    preStateDigest: 'sha256:root-old', apiPhase: 'intent_prepared',
    nativeEventEvidence: null, apiResultEvidence: null,
  });
  await fixture.store.persistApplyIntentFacts(scope, 'intent:parked', { eventState: 'authority_committed' });
  await fixture.store.completePullPage(scope, 'page-parked');
  await fixture.store.persistApplyIntentFacts(scope, 'intent:parked', {
    nativeResult: 'result_unknown', waitReason: 'native_result_unknown', replayState: 'awaiting_receipt',
    nativeResultConfirmation: { kind: 'unknown', code: 'nwr:intent:parked:1:1' },
    eventState: 'awaiting_confirmation',
  });
}

function remoteDeletePolicy(conflictHref: string,
  overrides: { readonly conflictPending?: boolean; readonly pendingCount?: number } = {}): RemoteDeleteResponse {
  return { ok: true, policy: 'confirm', casVersion: 1, pendingCount: overrides.pendingCount ?? 0, pending: [],
    conflictPending: overrides.conflictPending === true, conflictHref };
}

describe('A-07 confirm park: inbound Pull/Ack stops, Push continues', () => {
  test('control: without a wait the same fixture reads and acks the Pull page', async () => {
    const fixture = await setup();
    await fixture.enqueue('op-control-1');
    fixture.pullResponses.push(json(200, pullPage('cursor-1')));
    fixture.ackResponses.push(json(200, ack('cursor-1')));
    await fixture.engine.wake('manual');
    // Push is the first phase of the wake, the Pull page is read and acked.
    assert.equal(fixture.order[0], 'push');
    assert.ok(fixture.order.includes('pull:cursor-0'), fixture.order.join(','));
    assert.ok(fixture.order.includes('ack:cursor-1'), fixture.order.join(','));
    assert.equal(fixture.ackRequests.length, 1);
    assert.equal((await fixture.store.getEngineState(scope))!.phase, 'sleeping');
  });

  test('an awaiting_confirmation event parks inbound Pull/Ack while push.drain still runs', async () => {
    const fixture = await setup();
    await fixture.enqueue('op-parked-1');
    await seedAwaitingConfirmation(fixture);
    assert.equal((await fixture.store.listPullEvents(scope, ['awaiting_confirmation'])).length, 1);
    fixture.clock.now = 5_000;

    await fixture.engine.wake('manual');

    // Push is the first phase of the wake and the fake drain leaves the row
    // pending, so it is attempted again after the parked Pull returns.
    assert.equal(fixture.order[0], 'push');
    assert.ok(fixture.push.calls >= 1, 'Push is not parked by an inbound confirmation wait');
    assert.deepEqual(fixture.pullRequests, [], 'the parked pull event must stop the inbound read');
    assert.deepEqual(fixture.ackRequests, [], 'no Ack may be published while the wait is open');

    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'sleeping');
    assert.equal(state.recoveryFrozen, false, 'a park is not a freeze');
    assert.equal(state.lastError, undefined);
    // The parked event is never acked: the cursor stays at the last committed page.
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor ?? exported.scope?.checkpoint?.cursor, 'cursor-1');
    assert.equal(exported.engine.lastAckedCursor, undefined);
  });

  test('the park owns the wake cycle: worst case one ~30s MV3 alarm per re-check', async () => {
    const fixture = await setup();
    await seedAwaitingConfirmation(fixture);
    fixture.clock.now = 5_000;

    await fixture.engine.wake('manual');

    // With no outbound row the wake has only the parked Pull: no read, no Ack,
    // and the park re-check is exactly one MV3 alarm floor away.
    assert.deepEqual(fixture.order, ['resume']);
    assert.deepEqual(fixture.pullRequests, []);
    assert.deepEqual(fixture.ackRequests, []);
    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'sleeping');
    assert.equal(state.notBefore, 5_000 + 30_000);
    assert.deepEqual(fixture.scheduled, [30_000]);
  });

  test('settling the wait the way confirmNativeWait cancel does lets the same scope pull again', async () => {
    const fixture = await setup();
    await fixture.enqueue('op-parked-2');
    await seedAwaitingConfirmation(fixture);
    await fixture.engine.wake('manual');
    assert.deepEqual(fixture.pullRequests, []);

    // `native-wait.ts` cancel/commit both settle the event; nothing else changes.
    await fixture.store.persistApplyIntentFacts(scope, 'intent:parked', { eventState: 'authority_committed' });
    assert.equal((await fixture.store.listPullEvents(scope, ['awaiting_confirmation'])).length, 0);
    fixture.pullResponses.push(json(200, pullPage('cursor-2')));
    fixture.ackResponses.push(json(200, ack('cursor-2')));
    fixture.clock.now = 40_000;
    const parked = fixture.order.length;
    await fixture.engine.wake('alarm');
    const resumed = fixture.order.slice(parked);
    // The engine resumes on the cursor the last committed page left behind.
    assert.ok(resumed.includes('pull:cursor-1'), resumed.join(','));
    assert.ok(resumed.includes('ack:cursor-2'), resumed.join(','));
    assert.equal(fixture.ackRequests.length, 1);
  });

  test('the parked scope projects as an inbound pause, never as a freeze', async () => {
    const fixture = await setup();
    await seedAwaitingConfirmation(fixture);
    const response = await handleSyncAttentionRequest({ scope: async () => scope, store: fixture.store });
    assert.equal(response.ok, true);
    if (response.ok !== true) throw new Error('expected an attention response');
    assert.equal(response.attention.waitCount, 1);
    assert.equal(response.attention.nativeWaitPending, true);
    assert.equal(response.attention.recoveryFrozen, false);
    assert.equal(response.attention.terminal, false);
    const view = describeSyncAttention(syncAttentionInput(response.attention,
      remoteDeletePolicy(SYNC_CENTER, { pendingCount: 1 })));
    assert.equal(view.pause.show, true);
    assert.equal(view.pause.nativeWait, true);
    assert.match(view.pause.copy, /Items awaiting a decision and their related changes are held/);
    assert.equal(view.terminal.show, false);
  });
});

describe('A-10 terminal freeze: no scheduling, but a rendered exit', () => {
  test('payload_too_large stops every later Pull and still reports the rebuild exit', async () => {
    const fixture = await setup();
    fixture.pullResponses.push(problem(413, 'payload_too_large', {}));
    await fixture.engine.wake('alarm');
    // The terminal wake scheduled nothing at all: there is no retry to wait for.
    assert.deepEqual(fixture.scheduled, []);
    assert.equal((await fixture.store.getEngineState(scope))!.lastError, 'payload_too_large');

    fixture.pullResponses.push(json(200, pullPage('cursor-after-413')));
    fixture.ackResponses.push(json(200, ack('cursor-after-413')));
    fixture.clock.now += 60_000;
    await fixture.engine.wake('alarm');
    assert.equal(fixture.pullRequests.length, 1, 'a terminal freeze must not re-pull');
    assert.deepEqual(fixture.scheduled, [], 'a terminal freeze must not schedule a retry');

    const response = await handleSyncAttentionRequest({ scope: async () => scope, store: fixture.store });
    assert.equal(response.ok, true);
    if (response.ok !== true) throw new Error('expected an attention response');
    assert.equal(response.attention.terminal, true);
    assert.equal(response.attention.terminalCode, 'payload_too_large');
    assert.equal(response.attention.recoveryCode, 'payload_too_large');
    assert.equal(response.attention.lastError, 'payload_too_large');
    assert.equal(response.attention.recoveryFrozen, true);

    const view = describeSyncAttention(syncAttentionInput(response.attention, remoteDeletePolicy(SYNC_CENTER)));
    assert.equal(view.terminal.show, true);
    assert.equal(view.terminal.code, 'payload_too_large');
    assert.match(view.terminal.copy, /Sync on this device has stopped/);
    // The card says what to do about it and keeps the code in brackets for whoever investigates (C-13).
    assert.match(view.terminal.copy, /whoever runs your Know-N server/);
    assert.match(view.terminal.copy, /\(payload_too_large\)$/);
    assert.match(view.terminal.report, /recoveryCode: payload_too_large/);
    assert.match(view.terminal.report, /lastError: payload_too_large/);
    assert.equal(view.terminal.copyDiagnosticsLabel, 'Copy diagnostics');
    // The rebuild exit only renders with a backend-provided Sync Center href.
    assert.equal(view.terminal.syncCenter.show, true);
    assert.equal(view.terminal.syncCenter.href, SYNC_CENTER);
    assert.match(view.terminal.report, /recoveryCode: payload_too_large/);
    assert.match(view.terminal.report, /lastError: payload_too_large/);
    assert.equal(view.pause.show, false, 'a terminal freeze is not an inbound-pause-only state');
  });

  test('an unproven identity freezes terminal, re-checks on the ~30s cycle, and never pulls', async () => {
    const fixture = await setup();
    await freezeScopeRecovery(fixture.store, scope, 'recovery_identity_unproven', () => fixture.clock.now);
    const frozen = (await fixture.store.exportScope(scope)).engine;
    assert.equal(frozen.recoveryFrozen, true);
    assert.equal(frozen.lastError, 'recovery_identity_unproven');

    fixture.pullResponses.push(json(200, pullPage('cursor-after-identity')));
    await fixture.engine.wake('alarm');
    assert.deepEqual(fixture.pullRequests, [], 'an unproven identity must never resume Pull');
    // Identity waits keep exactly one bounded re-check alarm; no retry cadence.
    assert.deepEqual(fixture.scheduled, [30_000]);
    assert.deepEqual(fixture.order, []);

    const response = await handleSyncAttentionRequest({ scope: async () => scope, store: fixture.store });
    assert.equal(response.ok, true);
    if (response.ok !== true) throw new Error('expected an attention response');
    assert.equal(response.attention.terminal, true);
    assert.equal(response.attention.terminalCode, 'recovery_identity_unproven');
    assert.equal(response.attention.recoveryCode, 'recovery_identity_unproven');
    const view = describeSyncAttention(syncAttentionInput(response.attention, remoteDeletePolicy(SYNC_CENTER)));
    assert.equal(view.terminal.show, true);
    assert.match(view.terminal.copy, /Sync on this device has stopped/);
    assert.match(view.terminal.copy, /\(recovery_identity_unproven\)$/);
    assert.match(view.terminal.report, /recovery_identity_unproven/);
    assert.equal(view.terminal.syncCenter.show, true);
  });
});
