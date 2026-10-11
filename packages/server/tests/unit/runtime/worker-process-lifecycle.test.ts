import assert from 'node:assert/strict';
import { test } from 'vitest';
import { closeWorkerProcessResources } from '../../../src/bootstrap/worker.js';

test('worker process cleanup attempts the worker after a metrics failure', async () => {
  const calls: string[] = [];
  const close = (resource: string, fails = false) => async (): Promise<void> => {
    calls.push(resource);
    if (fails) throw new Error(`${resource} failed`);
  };

  let reported: unknown;
  try {
    await closeWorkerProcessResources({
      metricsServer: { close: close('metricsServer', true) },
      worker: { stop: close('worker', true) },
    });
  } catch (error: unknown) {
    reported = error;
  }

  assert.deepEqual(calls, ['metricsServer', 'worker']);
  assert.ok(reported instanceof AggregateError);
  assert.equal(reported.errors.length, 2);
  assert.match(reported.message, /metricsServer, worker/u);
});

test('worker process cleanup stops metrics and the worker once each', async () => {
  let metricsCloses = 0;
  let workerStops = 0;
  await closeWorkerProcessResources({
    metricsServer: { close: async () => { metricsCloses += 1; } },
    worker: { stop: async () => { workerStops += 1; } },
  });
  assert.equal(metricsCloses, 1);
  assert.equal(workerStops, 1);
});
