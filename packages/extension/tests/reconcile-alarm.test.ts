import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ensurePeriodicAlarm, type ReconcileAlarmChrome } from '../src/sw/reconcile-alarm.js';

const NAME = 'known-bookmark-reconcile';
const PERIOD = 180;

function stub(existing: { readonly name: string } | undefined, options: {
  getThrows?: boolean;
} = {}): { chrome: ReconcileAlarmChrome; created: Array<{ name: string; periodInMinutes: number }> } {
  const created: Array<{ name: string; periodInMinutes: number }> = [];
  return {
    created,
    chrome: {
      alarms: {
        get: async (name: string) => {
          if (options.getThrows) throw new Error('alarms.get unavailable');
          return existing?.name === name ? existing : undefined;
        },
        create: (name: string, info: { periodInMinutes: number }) => {
          created.push({ name, periodInMinutes: info.periodInMinutes });
        },
      },
    },
  };
}

test('an already-registered alarm is left exactly as the platform scheduled it', async () => {
  // `create` cancels and replaces a same-named alarm, restarting its period. A
  // cold start that re-registered would push the 180-minute reconciliation
  // forward on every wake, so it could never come due.
  const { chrome, created } = stub({ name: NAME });
  assert.equal(await ensurePeriodicAlarm(chrome, NAME, PERIOD), false);
  assert.deepEqual(created, [], 'an existing registration must not be replaced');
});

test('a missing alarm is registered as a repeating period', async () => {
  const { chrome, created } = stub(undefined);
  assert.equal(await ensurePeriodicAlarm(chrome, NAME, PERIOD), true);
  assert.deepEqual(created, [{ name: NAME, periodInMinutes: PERIOD }]);
});

test('a rejecting registry still leaves the alarm registered', async () => {
  // Older runtimes without `alarms.get`: creating is worse than nothing only if
  // it fails, and the opportunistic recovery paths remain as a backstop.
  const { chrome, created } = stub(undefined, { getThrows: true });
  assert.equal(await ensurePeriodicAlarm(chrome, NAME, PERIOD), true);
  assert.deepEqual(created, [{ name: NAME, periodInMinutes: PERIOD }]);
});

test('an unavailable alarms API is reported, not thrown', async () => {
  const chrome: ReconcileAlarmChrome = {
    alarms: {
      get: async () => undefined,
      create: () => { throw new Error('alarms unavailable'); },
    },
  };
  assert.equal(await ensurePeriodicAlarm(chrome, NAME, PERIOD), false);
});
