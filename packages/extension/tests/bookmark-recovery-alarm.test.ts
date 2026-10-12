import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBookmarkRecoveryScheduler } from '../src/sw/bookmark-recovery-alarm.js';

test('recovery backoff survives worker replacement, caps delay, coalesces and resets after success', async () => {
  let now = 1000;
  let alarm: { scheduledTime: number } | undefined;
  const stored: Record<string, unknown> = {};
  const delays: number[] = [];
  const ports = { name: 'recovery', now: () => now,
    alarms: { get: async () => alarm,
      create: (_name: string, input: { when: number }) => {
        delays.push(input.when - now); alarm = { scheduledTime: input.when };
      } },
    storage: { get: async () => stored, set: async (value: Record<string, unknown>) => { Object.assign(stored, value); } },
  };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const worker = createBookmarkRecoveryScheduler(ports);
    await Promise.all([worker.schedule(), worker.schedule()]);
    await createBookmarkRecoveryScheduler(ports).schedule();
    now = alarm!.scheduledTime; alarm = undefined;
  }
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  const worker = createBookmarkRecoveryScheduler(ports);
  await worker.reset(); await worker.schedule();
  assert.equal(delays.at(-1), 30_000);
});
