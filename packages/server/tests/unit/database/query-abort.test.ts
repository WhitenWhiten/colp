import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { withPostgresAbort } from '../../../src/infrastructure/database/query-abort.js';

describe('withPostgresAbort background settle (A5-4)', () => {
  test('returns the signal reason without awaiting the statement when cancel reports false', async () => {
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    let cancelCalls = 0;
    // A statement that never settles: awaiting it would hold the request
    // until statement_timeout, which is exactly the contract being removed.
    const statement = new Promise<string>(() => {});
    const work = withPostgresAbort(statement, controller.signal, async () => {
      cancelCalls += 1;
      return false; // pg_cancel_backend could not cancel the backend.
    });
    controller.abort(reason);
    await assert.rejects(work, /client disconnected/u);
    assert.equal(cancelCalls, 1);
  });

  test('observes a late rejection from the abandoned statement', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline exceeded');
    let rejectStatement!: (error: unknown) => void;
    const statement = new Promise<string>((_resolve, reject) => {
      rejectStatement = reject;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const work = withPostgresAbort(statement, controller.signal, async () => false);
      controller.abort(reason);
      await assert.rejects(work, /deadline exceeded/u);
      rejectStatement(new Error('canceling statement due to user request (57014)'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(unhandled, [], 'the abandoned statement rejection must stay observed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a statement that settles before abort keeps its result and never cancels', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const value = await withPostgresAbort(
      Promise.resolve({ rows: [] }),
      controller.signal,
      async () => { cancelled = true; },
    );
    assert.deepEqual(value, { rows: [] });
    assert.equal(cancelled, false);
  });

  test('a pre-aborted signal rejects with its reason without invoking cancel', async () => {
    const controller = new AbortController();
    const reason = new Error('already aborted');
    controller.abort(reason);
    let cancelled = false;
    await assert.rejects(
      withPostgresAbort(new Promise<string>(() => {}), controller.signal, async () => {
        cancelled = true;
      }),
      /already aborted/u,
    );
    assert.equal(cancelled, false);
  });

  test('without a signal the statement runs untouched', async () => {
    let cancelled = false;
    const value = await withPostgresAbort(Promise.resolve('ok'), undefined, async () => {
      cancelled = true;
    });
    assert.equal(value, 'ok');
    assert.equal(cancelled, false);
  });
});
