import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { describeSyncAttention, syncAttentionInput } from '../src/sync-attention-ui.js';
import { validSyncRetryRequest } from '../src/sw/messages.js';
import { collectSyncDiagnostics } from '../src/sync-diagnostics.js';
import { scope, setup } from './sync-recovery-hardening-fixture.js';

describe('every failed recovery has a visible status and diagnostic facts', () => {
  test.each(['bounded_string_invalid', 'secret_field_forbidden', 'record_too_large',
    'snapshot_native_projection_ambiguous', 'snapshot_projection_incomplete'])(
    'exposes %s while preserving its error code', code => {
      const input = syncAttentionInput({ recoveryFrozen: true, phase: 'error', queueProjection: 'idle',
        rejectedPending: false, conflictPending: false, nativeWaitPending: false, waitCount: 0,
        lastError: code, terminal: false, retryAutomatic: false }, undefined);
      const view = describeSyncAttention(input);
      assert.equal(view.recovery.show, true);
      assert.match(view.recovery.copy, /Retry sync/);
      assert.match(view.recovery.report, new RegExp(code));
      assert.match(view.recovery.report, /automaticRetry: false/);
    });

  test('distinguishes automatic recovery from a failure requiring manual retry', () => {
    const automatic = describeSyncAttention({ phase: 'recovery', recoveryFrozen: true, lastError: 'network_unavailable',
      retryAutomatic: true, retryAt: Date.now() + 60_000 });
    assert.match(automatic.recovery.copy, /retry automatically/);
    assert.match(automatic.recovery.copy, /Next attempt/);
    assert.equal(describeSyncAttention({ phase: 'sleeping', recoveryFrozen: false }).recovery.show, false);
    assert.equal(describeSyncAttention({ lastError: 'payload_too_large' }).recovery.show, false,
      'known terminal failures keep their existing specific exit');
  });

  test('retry accepts only a parameterless command from the existing sender boundary', () => {
    assert.equal(validSyncRetryRequest({ kind: 'known.sync.engine.retry' }), true);
    for (const value of [null, [], {}, { kind: 'known.sync.engine.status' },
      { kind: 'known.sync.engine.retry', scope }, { kind: 'known.sync.engine.retry', force: true }]) {
      assert.equal(validSyncRetryRequest(value), false);
    }
  });

  test('copied diagnostics include recovery facts and omit private ids and content', async () => {
    const store = await setup();
    await store.setFirstRun(scope, 'running');
    await store.transitionEngine(scope, { phase: 'error', updatedAt: Date.now(), recoveryFrozen: true,
      authorityRefreshRequired: false, notBefore: 0, lastError: 'bounded_string_invalid' });
    await store.putBootstrapRun(scope, { runId: 'private-run-id', confirmationId: 'private-confirmation',
      phase: 'syncing', bootstrapMode: 'merge', updatedAt: Date.now(), retryReason: 'queue_recovery_frozen' });
    await store.putMapping(scope, { nativeId: 'private-native-id', colpId: 'private-colp-id', rootNativeId: 'private-root',
      projection: { revision: 'r1', digest: 'digest', content: { title: 'PRIVATE-BOOKMARK', url: 'https://private.invalid' } } });
    const diagnostic = await collectSyncDiagnostics(store, scope);
    assert.equal(diagnostic.engine.errorCode, 'bounded_string_invalid');
    assert.equal(diagnostic.engine.retryAutomatic, false);
    assert.equal(diagnostic.engine.recoveryFrozen, true);
    assert.equal(diagnostic.firstRun.state, 'running');
    assert.equal(diagnostic.firstRun.retryReason, 'queue_recovery_frozen');
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE-BOOKMARK|private\.invalid|private-(native|colp|run|root)|serverOrigin|scopeKey|accessToken/);
    store.close();
  });
});
