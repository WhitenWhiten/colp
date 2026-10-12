import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { ack, emptyPullPage, json, problem, scope, setup } from './durable-sync-engine-harness.js';

test('DS-09 active authority refresh unfreezes after the leftover Pull is applied and acknowledged', async () => {
  const f = await setup();
  await f.store.stagePullPage(scope, { pageId: 'leftover', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
    collectionRevision: 'revision-1', pageDigest: 'sha256:leftover', events: [] });
  await f.store.transitionEngine(scope, { phase: 'recovery', updatedAt: f.clock.now,
    recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0 });
  f.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-0' });
  f.pullResponses.push(json(200, emptyPullPage('cursor-2')));
  f.ackResponses.push(json(200, ack('cursor-2')));
  await f.reopen().wake('startup');
  const facts = await f.store.exportScope(scope);
  assert.equal(facts.cursor?.cursor, 'cursor-2');
  assert.equal(facts.engine.lastAckedCursor, 'cursor-2');
  assert.equal(facts.engine.authorityRefreshRequired, false);
  assert.equal(facts.engine.recoveryFrozen, false);
  assert.equal(facts.ackIntents.some((intent) => intent.kind === 'bootstrap'), false);
});

test('DS-09 successful Pull cannot release a native call whose result is unknown', async () => {
  const f = await setup();
  await f.store.createApplyIntent(scope, { intentId: 'unknown-native', correlationId: 'unknown-native',
    operationId: 'remote-create', expected: { kind: 'create', nativeId: 'pending:remote-create' }, expiresAt: 99_999 });
  await f.store.persistApplyIntentFacts(scope, 'unknown-native', {
    nativeResult: 'result_unknown', waitReason: 'native_result_unknown', replayState: 'awaiting_receipt',
  });
  await f.store.transitionEngine(scope, { phase: 'recovery', updatedAt: f.clock.now,
    recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0 });
  f.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-0' });
  f.pullResponses.push(json(200, emptyPullPage('cursor-1')));
  f.ackResponses.push(json(200, ack('cursor-1')));
  await f.engine.wake('startup');
  assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-1');
  assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, true);
  assert.equal((await f.store.getApplyIntent(scope, 'unknown-native'))?.nativeResult, 'result_unknown');
});

test('DS-09 a published Pull without its successful Ack remains frozen', async () => {
  const f = await setup();
  await f.store.transitionEngine(scope, { phase: 'sleeping', updatedAt: f.clock.now,
    recoveryFrozen: true, authorityRefreshRequired: false, notBefore: 0 });
  f.pullResponses.push(json(200, emptyPullPage('cursor-1')));
  f.ackResponses.push(problem(503, 'service_unavailable', {}));
  await f.reopen().wake('startup');
  assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-1');
  assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, true);
  assert.equal((await f.store.getPendingAckIntent(scope))?.cursor, 'cursor-1');
});
