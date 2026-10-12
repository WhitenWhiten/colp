const SYNC_ALARM = 'known-sync-engine';
const MV3_MINIMUM_DELAY_MS = 30_000;

interface AlarmPort {
  get(name: string): Promise<{ readonly scheduledTime: number } | undefined>;
  create(name: string, info: { readonly when: number }): void;
}

/** Keep the earliest wake: another early/reconcile wake must not postpone Pull. */
export function createSyncAlarmScheduler(alarms: AlarmPort, now = Date.now) {
  let tail: Promise<void> = Promise.resolve();
  return (delayMilliseconds: number): Promise<void> => {
    const when = now() + Math.max(MV3_MINIMUM_DELAY_MS, delayMilliseconds);
    const scheduled = tail.then(async () => {
      const existing = await alarms.get(SYNC_ALARM);
      if (!existing || existing.scheduledTime > when) alarms.create(SYNC_ALARM, { when });
    });
    // Serialize competing schedulers; a failed API call must not poison later wakes.
    tail = scheduled.catch(() => undefined);
    return scheduled;
  };
}
