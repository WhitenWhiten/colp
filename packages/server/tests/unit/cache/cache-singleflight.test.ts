/**
 * T04 unit tests (plan §6.4 T04 / §7.2 / §7.3): the in-process CacheSingleflight.
 *
 * The tests exercise the production CacheSingleflight class directly (no copy
 * of the algorithm). Barriers and explicit gates are used to fix interleavings;
 * no bare Promise.all is ever used to infer a race. They cover same-key merging,
 * different-key and different-domain isolation, post-completion cleanup, and
 * abort behavior on both the waiter and the leader.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { CacheAbortError, CacheSingleflight } from '../../../src/infrastructure/cache/index.js';

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('CacheSingleflight', () => {
  test('concurrent calls for the same key share one in-flight promise', async () => {
    const singleflight = new CacheSingleflight();
    let calls = 0;
    let markEntered!: () => void;
    let releaseGate!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const fn = async (): Promise<string> => {
      calls += 1;
      markEntered();
      await gate;
      return `result-${calls}`;
    };

    const first = singleflight.run('domain:key', signal(), fn);
    await entered; // leader is now inside the shared flight
    const second = singleflight.run('domain:key', signal(), async () => {
      throw new Error('a merged waiter must never run the fn');
    });
    await flush();
    assert.equal(singleflight.pendingCount, 1);

    releaseGate();
    assert.equal(await first, 'result-1');
    assert.equal(await second, 'result-1');
    assert.equal(calls, 1);
    assert.equal(singleflight.pendingCount, 0);
  });

  test('different keys never merge', async () => {
    const singleflight = new CacheSingleflight();
    let calls = 0;
    const fn = async (): Promise<number> => { calls += 1; return calls; };
    const [a, b] = await Promise.all([
      singleflight.run('key-a', signal(), fn),
      singleflight.run('key-b', signal(), fn),
    ]);
    assert.equal(calls, 2);
    assert.equal(a, 1);
    assert.equal(b, 2);
    assert.equal(singleflight.pendingCount, 0);
  });

  test('different domains (composite keys) never merge', async () => {
    const singleflight = new CacheSingleflight();
    let calls = 0;
    const fn = async (): Promise<number> => { calls += 1; return calls; };
    const [a, b] = await Promise.all([
      singleflight.run('domain-a:key', signal(), fn),
      singleflight.run('domain-b:key', signal(), fn),
    ]);
    assert.equal(calls, 2);
    assert.notEqual(a, b);
    assert.equal(singleflight.pendingCount, 0);
  });

  test('entries are removed after completion so the next call starts a fresh flight', async () => {
    const singleflight = new CacheSingleflight();
    let calls = 0;
    const fn = async (): Promise<number> => { calls += 1; return calls; };
    assert.equal(await singleflight.run('key', signal(), fn), 1);
    assert.equal(singleflight.pendingCount, 0);
    assert.equal(await singleflight.run('key', signal(), fn), 2);
    assert.equal(calls, 2);
    assert.equal(singleflight.pendingCount, 0);
  });

  test('a pre-aborted signal rejects without creating a flight or calling the fn', async () => {
    const singleflight = new CacheSingleflight();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(
      singleflight.run('key', controller.signal, async () => { calls += 1; return 'x'; }),
      CacheAbortError,
    );
    assert.equal(calls, 0);
    assert.equal(singleflight.pendingCount, 0);
  });

  test('aborting a waiter rejects only that waiter and never hangs the shared flight', async () => {
    const singleflight = new CacheSingleflight();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const leader = singleflight.run('key', signal(), async () => { await gate; return 'done'; });
    await flush();

    const waiterController = new AbortController();
    const waiter = singleflight.run('key', waiterController.signal, async () => {
      throw new Error('a merged waiter must never run the fn');
    });
    await flush();
    waiterController.abort();

    await assert.rejects(waiter, CacheAbortError);
    assert.equal(singleflight.pendingCount, 1, 'the shared flight must keep running');
    releaseGate();
    assert.equal(await leader, 'done');
    assert.equal(singleflight.pendingCount, 0);
  });

  test('aborting the leader never aborts the shared flight while a waiter still waits', async () => {
    const singleflight = new CacheSingleflight();
    const controller = new AbortController();
    let flightAborted = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const leader = singleflight.run('key', controller.signal, async (flightSignal) => {
      flightSignal.addEventListener('abort', () => { flightAborted = true; }, { once: true });
      await gate;
      return 'done';
    });
    await flush();
    const waiter = singleflight.run('key', signal(), async () => 'never');
    await flush();

    controller.abort();
    await assert.rejects(leader, CacheAbortError);
    assert.equal(flightAborted, false, 'a live waiter must keep the shared origin running');
    assert.equal(singleflight.pendingCount, 1, 'the shared flight must survive the leader abort');

    releaseGate();
    assert.equal(await waiter, 'done', 'the waiter must receive the shared origin result');
    assert.equal(singleflight.pendingCount, 0);
  });

  test('when the last caller leaves, the shared flight aborts and the origin observes it', async () => {
    const singleflight = new CacheSingleflight();
    const leaderController = new AbortController();
    let flightAborted = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const leader = singleflight.run('key', leaderController.signal, async (flightSignal) => {
      flightSignal.addEventListener('abort', () => { flightAborted = true; }, { once: true });
      await gate;
      return 'never';
    });
    await flush();
    const waiterController = new AbortController();
    const waiter = singleflight.run('key', waiterController.signal, async () => 'never');
    await flush();

    leaderController.abort();
    await assert.rejects(leader, CacheAbortError);
    assert.equal(flightAborted, false, 'the remaining waiter still needs the origin result');

    waiterController.abort();
    await assert.rejects(waiter, CacheAbortError);
    releaseGate();
    await flush();
    assert.equal(flightAborted, true, 'the last caller leaving must abort the shared origin');
    assert.equal(singleflight.pendingCount, 0);
  });

  test('a new run after every caller left starts a fresh flight instead of joining the dying one', async () => {
    const singleflight = new CacheSingleflight();
    const firstController = new AbortController();
    let firstAborted = false;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const first = singleflight.run('key', firstController.signal, async (flightSignal) => {
      calls += 1;
      flightSignal.addEventListener('abort', () => { firstAborted = true; }, { once: true });
      await firstGate;
      return 'first';
    });
    await flush();
    firstController.abort();
    await assert.rejects(first, CacheAbortError);

    // The old flight is still settling (an abort-aware origin needs a moment):
    // a new caller must not join the dying flight, it gets a fresh origin run.
    const second = singleflight.run('key', signal(), async () => { calls += 1; return 'second'; });
    await flush();
    assert.equal(calls, 2, 'the abandoned flight must never be reused');
    assert.equal(firstAborted, true, 'the abandoned flight observes the abort');
    assert.equal(await second, 'second');
    releaseFirst();
    await flush();
    assert.equal(singleflight.pendingCount, 0);
  });

  test('the flight fn observes the abort and settles while the leader join rejects', async () => {
    const singleflight = new CacheSingleflight();
    const controller = new AbortController();
    let sawAborted = false;
    let flightResult: string | undefined;
    const run = singleflight.run('key', controller.signal, async (flightSignal) => {
      await new Promise<void>((resolve) => {
        flightSignal.addEventListener('abort', () => { sawAborted = true; resolve(); }, { once: true });
      });
      flightResult = 'ok';
      return 'ok';
    });

    controller.abort();
    // The cancelled leader's own join rejects (it no longer wants the result),
    // while the flight fn still observes the abort and settles cleanly.
    await assert.rejects(run, CacheAbortError);
    await flush();
    assert.equal(sawAborted, true);
    assert.equal(flightResult, 'ok');
    assert.equal(singleflight.pendingCount, 0);
  });
});
