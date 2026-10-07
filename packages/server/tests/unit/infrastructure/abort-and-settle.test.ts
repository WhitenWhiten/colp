import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import { withAbort } from '../../../src/infrastructure/async/abort-and-settle.js';

test('an already aborted signal joins the running query before allowing rollback', async () => {
  const controller = new AbortController();
  const reason = new DOMException('client disconnected', 'AbortError');
  controller.abort(reason);
  let rejectQuery!: (error: Error) => void;
  const query = new Promise<never>((_resolve, reject) => { rejectQuery = reject; });
  let cancelled = false; let settled = false;
  const result = withAbort(query, controller.signal, async () => { cancelled = true; });
  const checked = assert.rejects(result, (error: unknown) => error === reason)
    .then(() => { settled = true; });
  await setImmediate();
  assert.equal(cancelled, true);
  assert.equal(settled, false, 'the transaction must remain open while the query runs');
  rejectQuery(new Error('cancelled query'));
  await checked;
});

test('an already aborted signal cannot return a completed query result', async () => {
  const controller = new AbortController();
  const reason = new Error('disconnected'); controller.abort(reason);
  let cancelled = false;
  await assert.rejects(withAbort(Promise.resolve('late data'), controller.signal,
    async () => { cancelled = true; }), (error: unknown) => error === reason);
  assert.equal(cancelled, true);
});

test('abort during a read preserves its reason through cancellation and query failures', async () => {
  const controller = new AbortController(); const reason = new Error('disconnected');
  let rejectQuery!: (error: Error) => void;
  const query = new Promise<never>((_resolve, reject) => { rejectQuery = reject; });
  const result = withAbort(query, controller.signal, () => {
    rejectQuery(new Error('query rejected'));
    throw new Error('cancel transport failed');
  });
  const checked = assert.rejects(result, (error: unknown) => error === reason);
  controller.abort(reason);
  await checked;
});

test('completed reads propagate values and query errors without cancellation', async () => {
  const controller = new AbortController(); let cancellations = 0;
  const cancel = async () => { cancellations += 1; };
  assert.equal(await withAbort(Promise.resolve(42), controller.signal, cancel), 42);
  const error = new Error('query failure');
  await assert.rejects(withAbort(Promise.reject(error), controller.signal, cancel),
    (actual: unknown) => actual === error);
  assert.equal(await withAbort(Promise.resolve(7), undefined, cancel), 7);
  assert.equal(cancellations, 0);
});
