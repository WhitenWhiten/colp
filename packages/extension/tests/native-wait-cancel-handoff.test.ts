/**
 * B-06: cancelling a native-unknown wait is the person's decision. The Session-renewal pre-check already ignored
 * a cancelled wait, but the atomic recheck inside the store did not, so after a cancel every renewal froze the
 * engine, rebased, and then threw `session_handoff_pending` (transient, so never counted) for good.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { holdsNativeResultUnknown } from '../src/native-wait-open.js';
import { readEngineSessionAuthority } from '../src/sync-session-handoff.js';
import type { StoredSession } from '../src/types.js';
import { setup, scope, json, emptyPullPage, ack } from './durable-sync-engine-harness.js';

async function fixture() {
  const f = await setup({ useRealPullApplier: true });
  f.pullResponses.push(json(200, emptyPullPage('cursor-confirmed'), { 'Known-Sync-Cursor-Reissued': 'true' }));
  f.ackResponses.push(json(200, ack('cursor-confirmed')));
  await f.engine.wake('manual');
  const session = { sessionId: 'session-new', acceptedProtocolVersion: '0.2', scope: 'collection', snapshotRequired: false,
    expiresAt: '2099-01-01T00:00:00Z',
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-reissued', serverRevision: 'revision-1' },
    replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
  } as StoredSession;
  const options = { store: f.store, scope, sessions: { async get() { return { credential: { accessToken: 'token' }, session }; } } };
  return { ...f, session, options };
}

/** A create whose result Chrome never confirmed, parked as a native wait; optionally cancelled by the person. */
async function parkedNativeWait(f: Awaited<ReturnType<typeof fixture>>, cancelled: boolean) {
  await f.store.createApplyIntent(scope, { intentId: 'intent:wait-1', correlationId: 'corr:wait-1', operationId: 'op-wait-1',
    expected: { kind: 'create', nativeId: 'pending:node-wait' }, expiresAt: Date.now() + 600_000, state: 'intent_prepared',
    generation: scope.generation, commandId: 'pull', colpId: 'node-wait', substep: 'create', liveWorkKind: 'create',
    nativeParentId: 'native-root', nativeResult: 'not_started', replayState: 'not_started' });
  await f.store.persistApplyIntentFacts(scope, 'intent:wait-1', { nativeResult: 'result_unknown',
    waitReason: 'native_result_unknown', replayState: 'awaiting_receipt',
    nativeResultConfirmation: { kind: 'unknown', code: 'wait-ref-1' } });
  if (cancelled) {
    await f.store.persistApplyIntentFacts(scope, 'intent:wait-1', { expectedWaitRef: 'wait-ref-1',
      expectedGeneration: scope.generation, expectedNativeResult: 'result_unknown',
      nativeWaitDecision: { action: 'cancel', waitRef: 'wait-ref-1' }, replayState: 'committed', waitReason: null });
  }
}

test('one predicate: an open wait holds; a cancelled one does not, whatever else the intent still records', () => {
  assert.equal(holdsNativeResultUnknown({ nativeResult: 'result_unknown' }), true);
  assert.equal(holdsNativeResultUnknown({ waitReason: 'native_result_unknown' }), true);
  assert.equal(holdsNativeResultUnknown({ nativeResult: 'result_unknown', waitReason: 'native_result_unknown',
    nativeWaitDecision: { action: 'cancel', waitRef: 'wait-ref-1' } }), false);
  assert.equal(holdsNativeResultUnknown({ nativeResult: 'applied_with_evidence' }), false);
});

test('an open native wait defers the Session handoff quietly, as before', async () => {
  const f = await fixture();
  try {
    await parkedNativeWait(f, false);
    await readEngineSessionAuthority(f.options, () => f.clock.now);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-confirmed');
    assert.notEqual((await f.store.getEngineState(scope))?.sessionId, 'session-new');
  } finally { f.store.close(); }
});

test('a cancelled native wait no longer blocks the Session handoff', async () => {
  const f = await fixture();
  try {
    await parkedNativeWait(f, true);
    await readEngineSessionAuthority(f.options, () => f.clock.now);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-reissued');
    const state = await f.store.getEngineState(scope);
    assert.equal(state?.sessionId, 'session-new');
    assert.equal(state?.recoveryFrozen, false);
  } finally { f.store.close(); }
});
