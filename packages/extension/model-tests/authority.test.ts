import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { ackEnvelope } from '../src/sync-engine-wire.js';
import { cursorIsConfirmed } from '../src/sync-state/cursor-confirmation.js';
import { pendingNativeOrPullFacts } from '../src/native-repair.js';
import { mayUnfreezeForCompletedBootstrapAck } from '../src/bootstrap-ack-unfreeze.js';
import { classifySessionAuthority } from '../src/session-client.js';
import { setupT02, reopenT02, t02Scope as scope } from '../tests/srg-t02-native-harness.js';
import { vectors } from './model-vectors.js';

const cursor = (n: number) => `authority-cursor-${n}`;
const number = (s: string | undefined) => Number(s?.replace('authority-cursor-', ''));

for (const trace of vectors.authorityTraces) test(`Lean/authority transactions: ${trace.name}`, async () => {
  let f = await setupT02();
  try {
    await f.store.stagePullPage(scope, { pageId: 'confirmed-boundary', previousCursor: 'cursor-old', nextCursor: cursor(1),
      collectionRevision: 'revision-1', pageDigest: 'sha256:page', events: [], effectPages: [] });
    await f.store.completePullPage(scope, 'confirmed-boundary');
    const initialAck = await f.store.beginAckIntent(scope, ackEnvelope('pull', 'session-0', cursor(1)));
    await f.store.completeAckIntent(scope, initialAck.intentId, { ackedCursor: cursor(1) });
    await f.store.transitionEngine(scope, { phase: 'sleeping', sessionId: 'session-0', recoveryFrozen: false,
      authorityRefreshRequired: false, updatedAt: 1000, notBefore: 0, lastPublishedCursor: cursor(1), lastAckedCursor: cursor(1) });
    const observe = async () => {
      const engine = (await f.store.getEngineState(scope))!;
      const durable = (await f.store.getCursor(scope))!;
      const facts = await pendingNativeOrPullFacts(f.store, scope);
      return { revision: engine.revision, cursor: number(durable.cursor), session: Number(engine.sessionId?.replace('session-', '')),
        frozen: engine.recoveryFrozen, refresh: engine.authorityRefreshRequired, pendingAck: !!await f.store.getPendingAckIntent(scope),
        incompletePull: facts.pendingIncompletePull, nativeUnknown: facts.nativeResultUnknown,
        confirmed: cursorIsConfirmed(durable, engine.lastAckedCursor, await f.store.listAckIntents(scope)) };
    };
    assert.deepEqual(await observe(), trace.initial);
    for (const [i, c] of trace.checkpoints.entries()) {
      const a = c.action;
      const before = await f.store.getPendingAckIntent(scope);
      let outcome = 'ok';
      try {
        const prior = (await f.store.getEngineState(scope))!;
        if (a.kind === 'freeze') await f.store.transitionEngine(scope, { ...prior, phase: 'session',
          recoveryFrozen: true, authorityRefreshRequired: true, expectedRevision: a.expected });
        else if (a.kind === 'rebase') await f.store.rebaseActiveSessionAuthority(scope, {
          cursor: cursor(a.next), serverRevision: `revision-${a.next}`, expectedEngineRevision: a.expected,
          requireConfirmedCursor: cursor(a.captured),
        });
        else if (a.kind === 'finish') {
          const durable = (await f.store.getCursor(scope))!;
          await f.store.transitionEngine(scope, { ...prior, phase: 'session', sessionId: `session-${a.session}`,
            recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0,
            lastPublishedCursor: durable.cursor, lastAckedCursor: durable.cursor, expectedRevision: a.expected });
        } else if (a.kind === 'revisionRace') await f.store.transitionEngine(scope, { ...prior, expectedRevision: prior.revision });
        else if (a.kind === 'pendingAck') await f.store.beginAckIntent(scope, ackEnvelope('pull', 'different-attempt-session', cursor(1)));
        else if (a.kind === 'stagePull') await f.store.stagePullPage(scope, { pageId: 'racing-page', previousCursor: cursor(1),
          nextCursor: 'racing-cursor', collectionRevision: 'racing-revision', pageDigest: 'sha256:racing', events: [], effectPages: [] });
        else f = await reopenT02(f);
      } catch (error) {
        assert.ok(error && typeof error === 'object' && 'code' in error);
        outcome = String(error.code);
      }
      assert.equal(outcome, c.outcome, `${trace.name}, step ${i}`);
      assert.deepEqual(await observe(), c.expected, `${trace.name}, step ${i}: ${JSON.stringify(a)}`);
      if (before) assert.deepEqual(await f.store.getPendingAckIntent(scope), before, 'handoff must preserve the exact original pending Ack');
    }
  } finally { f.store.close(); }
});

test('Lean/bootstrap unfreeze guard agrees with all boolean inputs', () => {
  for (const c of vectors.unfreezeCases) assert.equal(mayUnfreezeForCompletedBootstrapAck(c), c.expected);
});

test('Lean/session classification distinguishes snapshotRequired from lease lifecycle', () => {
  for (const c of vectors.sessionCases) {
    let result: string;
    try { result = classifySessionAuthority({ replicaLease: { state: c.lease }, snapshotRequired: c.snapshot },
      { authorityRefreshRequired: c.refresh, bootstrapped: c.bootstrapped }); }
    catch (error) { assert.ok(error instanceof Error); result = error.message; }
    assert.equal(result, c.expected, JSON.stringify(c));
  }
});
