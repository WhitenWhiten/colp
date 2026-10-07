import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createSerializedHostGate } from '../../../src/infrastructure/collections/serialized-host-gate.js';

test('aborting a queued host wait does not release the holder or skip the gap', async () => {
  let now = 0;
  const gate = createSerializedHostGate({
    gapMs: 100,
    invalidGapMessage: 'bad gap',
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  let releaseHolder!: () => void;
  const holderEntered = deferred();
  const holder = gate.run('bookmarks.test', async () => {
    holderEntered.resolve();
    await new Promise<void>((resolve) => { releaseHolder = resolve; });
  });
  await holderEntered.promise;
  const aborted = new AbortController();
  const events: string[] = [];
  const queued = gate.run('bookmarks.test', async () => { events.push('queued'); }, aborted.signal);
  const next = gate.run('bookmarks.test', async () => { events.push('next'); });
  aborted.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(queued, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.deepEqual(events, []);
  assert.equal(gate.pendingHostCount(), 1);
  releaseHolder();
  await holder;
  await next;
  assert.deepEqual(events, ['next']);
  assert.ok(now >= 100);
  assert.equal(gate.pendingHostCount(), 0);
});

test('aborting the tail waiter does not let a late arrival pass the holder', async () => {
  let now = 0;
  const gate = createSerializedHostGate({
    gapMs: 100,
    invalidGapMessage: 'bad gap',
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  let releaseHolder!: () => void;
  const holderEntered = deferred();
  let holderFinished = false;
  const holder = gate.run('bookmarks.test', async () => {
    holderEntered.resolve();
    await new Promise<void>((resolve) => { releaseHolder = resolve; });
    holderFinished = true;
  });
  await holderEntered.promise;
  const nowAtHold = now;
  const aborted = new AbortController();
  const events: string[] = [];
  const queued = gate.run('bookmarks.test', async () => { events.push('queued'); }, aborted.signal);
  aborted.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(queued, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.deepEqual(events, []);
  assert.equal(gate.pendingHostCount(), 1);
  let lateEntered = false;
  const late = gate.run('bookmarks.test', async () => {
    lateEntered = true;
    events.push(holderFinished ? 'late-after-holder' : 'late-during-holder');
  });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(lateEntered, false);
  assert.equal(now, nowAtHold);
  releaseHolder();
  await holder;
  await late;
  assert.deepEqual(events, ['late-after-holder']);
  assert.ok(now >= nowAtHold + 100);
  assert.equal(gate.pendingHostCount(), 0);
});

test('aborting one host does not unblock a different host', async () => {
  const gate = createSerializedHostGate({ gapMs: 0, invalidGapMessage: 'bad gap' });
  let release!: () => void;
  const entered = deferred();
  const holder = gate.run('held.test', async () => {
    entered.resolve();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await entered.promise;
  const other = gate.run('other.test', async () => 'done' as const);
  await other;
  assert.equal(gate.pendingHostCount(), 1);
  release();
  await holder;
  assert.equal(gate.pendingHostCount(), 0);
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
