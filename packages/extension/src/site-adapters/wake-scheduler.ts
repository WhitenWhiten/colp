import { createLane } from '../automation/lane.js';
import { SITE_RECOVERY_ALARM } from './source-runtime.js';
export function createSourceAlarmScheduler(alarms: {
  get?(name: string): Promise<{ scheduledTime: number } | undefined>;
  create(name: string, info: { when: number }): unknown;
}) {
  const lane = createLane();
  return (when: number, name = SITE_RECOVERY_ALARM) => lane(async () => {
    const current = await alarms.get?.(name);
    if (!current || current.scheduledTime > when) await alarms.create(name, { when });
  });
}
let schedule: ReturnType<typeof createSourceAlarmScheduler> | undefined;
export function scheduleSourceAlarm(when: number, name?: string) {
  schedule ??= createSourceAlarmScheduler(chrome.alarms);
  void schedule(when, name).catch(() => undefined);
}
