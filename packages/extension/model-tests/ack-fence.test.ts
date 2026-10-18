import assert from 'node:assert/strict';
import { test } from 'vitest';
import { pendingNativeOrPullFacts } from '../src/native-repair.js';
import { t02Scope as scope } from '../tests/srg-t02-native-harness.js';
import { setupRecoveryWait } from './recovery-fixture.js';
import { vectors } from './model-vectors.js';

for (const trace of vectors.ackFenceTraces) test(`Lean/bootstrap Ack transaction: ${trace.name}`, async () => {
  const r = await setupRecoveryWait(true);
  try {
    await assert.rejects(r.engine().wake('startup'), /worker_crash/u);
    const intent = (await r.fixture.store.getPendingAckIntent(scope))!;
    assert.equal(intent.kind, 'bootstrap');
    const baseRevision = (await r.fixture.store.getEngineState(scope))!.revision;
    const observe = async () => {
      const f = r.fixture;
      const engine = (await f.store.getEngineState(scope))!;
      const stored = (await f.store.listAckIntents(scope)).find(row => row.intentId === intent.intentId);
      return { revision: engine.revision - baseRevision, intent: stored?.state ?? 'absent',
        cursor: (await f.store.getCursor(scope))?.cursor === 'active-cut' ? 2 : 1,
        frozen: engine.recoveryFrozen, refresh: engine.authorityRefreshRequired,
        nativeUnknown: (await pendingNativeOrPullFacts(f.store, scope)).nativeResultUnknown };
    };
    assert.deepEqual(await observe(), trace.initial);
    for (const [i, c] of trace.checkpoints.entries()) {
      const f = r.fixture;
      const before = await f.store.getPendingAckIntent(scope);
      const beforeCursor = await f.store.getCursor(scope);
      const a = c.action;
      let outcome = 'ok';
      try {
        if (a.kind === 'revisionRace') {
          const prior = (await f.store.getEngineState(scope))!;
          await f.store.transitionEngine(scope, { ...prior, expectedRevision: prior.revision });
        } else if (a.kind === 'reject') await f.store.rejectBootstrapAckAndRequireAuthorityRefresh(scope, intent.intentId, {
          sessionId: 'session-recovery', updatedAt: 1000, notBefore: 0, errorCode: 'sync_cursor_expired',
          expectedRevision: baseRevision + a.expected,
        });
        else if (a.kind === 'lateReceipt') await f.store.completeAckIntent(scope, intent.intentId, {
          replicaId: scope.replicaId, ackedCursor: intent.cursor, ackedAt: '2026-10-18T00:00:00Z',
        });
        else if (a.kind === 'activate') await f.store.rebaseRecoveryCursor(scope, 'src1.model-capability', {
          cursor: 'active-cut', serverRevision: 'snapshot-revision',
        });
        else await r.restart();
      } catch (error) {
        assert.ok(error && typeof error === 'object' && 'code' in error);
        outcome = String(error.code);
      }
      assert.equal(outcome, c.outcome, `${trace.name}, step ${i}`);
      assert.deepEqual(await observe(), c.expected, `${trace.name}, step ${i}`);
      if (outcome !== 'ok') {
        assert.deepEqual(await r.fixture.store.getPendingAckIntent(scope), before, 'a failed transaction must not delete the Ack');
        assert.deepEqual(await r.fixture.store.getCursor(scope), beforeCursor);
      }
    }
  } finally { r.fixture.store.close(); }
});
