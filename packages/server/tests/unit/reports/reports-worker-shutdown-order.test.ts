import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

test('worker stops the reports scheduler before draining the outbox', () => {
  const workerSource = readFileSync(resolve(
    import.meta.dirname,
    '../../../src/bootstrap/worker.ts',
  ), 'utf8');
  const schedulerStop = workerSource.indexOf("'reportsScheduler', () => reportsScheduler.scheduler.stop()");
  const outboxStop = workerSource.indexOf("'outbox', () => outbox?.stop()");
  assert.ok(schedulerStop >= 0, 'reports scheduler stop must be wired');
  assert.ok(outboxStop >= 0, 'outbox stop must be wired');
  assert.ok(schedulerStop < outboxStop, 'scheduler must stop before outbox drain');
});
