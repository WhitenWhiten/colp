import { afterEach, expect, test, vi } from 'vitest';
import { SyncEvidenceMaintenanceJob } from '../../../src/infrastructure/sync/index.js';
import type { SyncEvidenceMaintenanceResult } from '../../../src/modules/sync/index.js';

const empty: SyncEvidenceMaintenanceResult = { attempted: 0, deleted: 0, redacted: 0, skipped: 0,
  errors: 0, oldestExpiredAgeMs: 0 };
const full = { ...empty, attempted: 500, deleted: 500 };
afterEach(() => vi.useRealTimers());

test('one wake drains several full batches and stops when actionable work is exhausted', async () => {
  let calls = 0;
  const results: SyncEvidenceMaintenanceResult[] = [];
  const job = new SyncEvidenceMaintenanceJob({ async runBatch() { return ++calls <= 5 ? full : empty; } },
    { intervalMs: 60_000, onResult: result => results.push(result) });
  await job.tick();
  expect(calls).toBe(6);
  expect(results.reduce((sum, result) => sum + result.deleted, 0)).toBe(2_500);
});

test('a busy cleanup yields after twenty batches and continues before the idle interval', async () => {
  vi.useFakeTimers();
  const runBatch = vi.fn(async () => full);
  const job = new SyncEvidenceMaintenanceJob({ runBatch }, { intervalMs: 60_000 });
  job.start(); job.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(runBatch).toHaveBeenCalledTimes(20);
  await vi.advanceTimersByTimeAsync(249);
  expect(runBatch).toHaveBeenCalledTimes(20);
  await vi.advanceTimersByTimeAsync(1);
  expect(runBatch).toHaveBeenCalledTimes(40);
  await job.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(runBatch).toHaveBeenCalledTimes(40);
  expect(vi.getTimerCount()).toBe(0);
});

test('an elapsed burst budget stops before another transaction begins', async () => {
  let clock = 0; let calls = 0;
  const job = new SyncEvidenceMaintenanceJob({ async runBatch() { calls++; clock += 400; return full; } },
    { intervalMs: 60_000, now: () => clock });
  await job.tick();
  expect(calls).toBe(3);
});

test('stop waits for the in-flight transaction and prevents a further batch or timer', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const runBatch = vi.fn(async () => { await blocked; return full; });
  const job = new SyncEvidenceMaintenanceJob({ runBatch }, { intervalMs: 60_000 });
  job.start(); await vi.advanceTimersByTimeAsync(0);
  let stopped = false;
  const stopping = Promise.resolve(job.stop()).then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  finish(); await stopping;
  expect(runBatch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('an error backs off to the idle interval and remains observable', async () => {
  vi.useFakeTimers();
  const failure = new Error('database_unavailable');
  const runBatch = vi.fn(async () => { throw failure; });
  const onError = vi.fn();
  const job = new SyncEvidenceMaintenanceJob({ runBatch }, { intervalMs: 60_000, onError });
  job.start(); await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith(failure);
  await vi.advanceTimersByTimeAsync(250);
  expect(runBatch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(59_750);
  expect(runBatch).toHaveBeenCalledTimes(2);
  await job.stop();
});
