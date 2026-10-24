import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { SYNC_FAILURE_TABLE, classifySyncFailure, freezesPullApply, persistentLocalSyncFailure } from '../src/sync-failure-class.js';

/**
 * W2C-19 / W2A-05 / Priority 7: the table says what each code means once. A code the push lane, the queue and
 * the browser store can raise is registered with the behaviour its comment promises, and no entry contradicts
 * itself (an exit of "nothing helps" next to a flag that starts a recovery).
 */
describe('the failure table does not contradict itself', () => {
  test('no stop is also a freeze: a freeze starts a recovery that cannot cure what a stop reports', () => {
    for (const [code, value] of Object.entries(SYNC_FAILURE_TABLE) as Array<[string, { exit: string; freezesPull?: true }]>) {
      if (value.exit === 'stop') assert.equal(value.freezesPull, undefined, code);
    }
    assert.equal(persistentLocalSyncFailure('delete_journal_invalid'), true);
    assert.equal(freezesPullApply('delete_journal_invalid'), false);
  });

  test('the codes of the push lane, the queue and the browser store are registered with their promised behaviour', () => {
    const expected: Record<string, [string, string]> = {
      // Browser storage (W2A-05): a full disk or a failing backing store is waited out; a refused record or a newer database is not.
      quota_exceeded: ['transient', 'retry'], storage_unavailable: ['transient', 'retry'],
      indexeddb_failure: ['transient', 'retry'], transaction_aborted: ['transient', 'retry'],
      storage_record_rejected: ['replica', 'stop'], future_schema: ['replica', 'stop'], diagnostic_read_only: ['replica', 'stop'],
      // Push lane and queue: a sent change whose bytes cannot be rebuilt stops the lane (named), a drain wait ends by itself.
      push_attempt_operation_changed: ['replica', 'stop'], queue_not_drained: ['transient', 'retry'],
      scope_not_writable: ['transient', 'retry'],
      queue_row_unreadable: ['item', 'decide'], queue_head_unreadable: ['replica', 'stop'], sync_step_failed: ['transient', 'retry'],
    };
    for (const [code, [klass, exit]] of Object.entries(expected)) {
      const entry = (SYNC_FAILURE_TABLE as Record<string, { class: string; exit: string }>)[code];
      assert.ok(entry, `${code} is registered`);
      assert.deepEqual([entry.class, entry.exit], [klass, exit], code);
    }
    // An item code without an item is the replica's problem (the engine never sees it as a single change).
    assert.equal(classifySyncFailure('queue_row_unreadable')?.class, 'replica');
    assert.equal(classifySyncFailure('queue_row_unreadable', { opId: 'op-1' })?.class, 'item');
  });
});
