import assert from 'node:assert/strict';
import { test } from 'vitest';
import { pendingNativeOrPullFacts } from '../src/native-repair.js';
import { mayUnfreezeForCompletedBootstrapAck } from '../src/bootstrap-ack-unfreeze.js';
import { ordinaryPullEventAllowed, readPullApplyAuthority } from '../src/pull-authority-apply.js';
import { t02Scope as scope } from '../tests/srg-t02-native-harness.js';
import { setupRecoveryWait } from '../tests/bootstrap-recovery-harness.js';
import { vectors } from './model-vectors.js';

for (const branch of vectors.recoveryBranches) test(`Lean/engine bootstrap completion (interrupted=${branch.interrupted}, unknown=${branch.nativeUnknown})`, async () => {
  const { interrupted, nativeUnknown } = branch;
  const r = await setupRecoveryWait({ interruptAfterAck: interrupted, settleBeforeRecovery: !nativeUnknown });
  try {
    if (interrupted) {
      await assert.rejects(r.engine().wake('startup'), /worker_crash/u);
      await (await r.restart()).wake('startup');
      assert.equal(r.acks.length, 2);
      assert.equal(r.acks[1], r.acks[0], 'unknown Ack retries must retain exact request bytes');
    } else {
      const state = await r.engine().wake('startup');
      assert.equal(state?.lastError, undefined);
    }
    const f = r.fixture;
    const facts = await pendingNativeOrPullFacts(f.store, scope);
    assert.equal(facts.nativeResultUnknown, nativeUnknown);
    assert.equal(mayUnfreezeForCompletedBootstrapAck(facts), !nativeUnknown);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'active-cut');
    assert.equal(f.api.calls.filter(c => c.kind === 'create').length, 1);
    const state = (await f.store.getEngineState(scope))!;
    assert.equal(state.recoveryFrozen, nativeUnknown);
    assert.equal(state.authorityRefreshRequired, false);
    await r.capture('final');
    assert.deepEqual(r.checkpoints, branch.checkpoints);
    if (nativeUnknown) await r.confirmNative();
    r.clock.now = state.notBefore;
    await (await r.restart()).wake('startup');
    const settled = (await r.fixture.store.getEngineState(scope))!;
    assert.equal(settled.lastError, undefined);
    assert.equal(settled.recoveryFrozen, false, 'settled work must release the hold');
    assert.equal(settled.authorityRefreshRequired, false);
    assert.equal((await r.fixture.store.getCursor(scope))?.cursor, 'active-cut');
    assert.equal(f.api.calls.filter(c => c.kind === 'create').length, 1);
  } finally { r.fixture.store.close(); }
});

test('a frozen Snapshot resumes only its generation-bound invocation with confirmed native identity', async () => {
  const r = await setupRecoveryWait();
  try {
    await r.engine().wake('startup');
    const f = r.fixture;
    const pending = (await f.store.listPullEvents(scope, ['awaiting_confirmation']))[0]!;
    assert.equal(ordinaryPullEventAllowed(await readPullApplyAuthority(f.options), pending), false);
    await r.confirmNative();
    const event = (await f.store.getPullEvent(scope, String(pending.eventId)))!;
    const authority = await readPullApplyAuthority(f.options);
    assert.equal(authority.frozen, true);
    assert.equal(ordinaryPullEventAllowed(authority, event), true);
    for (const patch of [{ authorityRefreshRequired: true }, { snapshotId: 'another-snapshot' },
      { lifecycle: 'recovery_required' }, { lifecycle: undefined }, { generation: scope.generation + 1 }]) {
      assert.equal(ordinaryPullEventAllowed({ ...authority, ...patch }, event), false);
    }
    assert.equal(ordinaryPullEventAllowed(authority, { ...event, state: 'intent_prepared' }), false);
    assert.equal(ordinaryPullEventAllowed(authority, { ...event, deferredNativeIntentId: 'another-intent' }), false);
    const intent = authority.intents.get(String(event.intentId))!;
    assert.equal(ordinaryPullEventAllowed({ ...authority,
      intents: new Map([[intent.intentId, { ...intent, nativeResult: 'result_unknown' }]]),
    }, event), false);
    for (const c of vectors.nativeResumeCases) {
      const candidate = { ...intent, generation: c.generation ? scope.generation : scope.generation + 1,
        eventId: c.event ? String(event.eventId) : 'another-event',
        nativeResult: c.applied ? 'applied_with_evidence' as const : 'result_unknown' as const,
        nativeResultConfirmation: c.confirmation ? { kind: 'candidate_event' as const, nativeId: c.nativeId ? 'proven-native' : '' }
          : { kind: 'unknown' as const, code: 'nwr:model' } };
      const actual = ordinaryPullEventAllowed({ ...authority, lifecycle: c.active ? 'active' : 'recovery_required',
        authorityRefreshRequired: c.refresh, snapshotId: c.snapshot ? authority.snapshotId : 'another-snapshot',
        intents: new Map([[candidate.intentId, candidate]]),
      }, { ...event, state: c.started ? 'browser_call_started' : 'intent_prepared',
        deferredNativeIntentId: c.binding ? intent.intentId : 'another-intent' });
      assert.equal(actual, c.expected, JSON.stringify(c));
    }
  } finally { r.fixture.store.close(); }
});
