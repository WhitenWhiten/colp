import { describe, expect, it, vi } from 'vitest';
import { createSyncAlarmScheduler } from '../src/sync-alarm.js';

function alarmHarness(initial?: number) {
  let time = 0, scheduledTime = initial;
  const alarms = {
    get: vi.fn(async () => scheduledTime === undefined ? undefined : { scheduledTime }),
    create: vi.fn((_name: string, info: { when: number }) => { scheduledTime = info.when; }),
  };
  return { alarms, schedule: createSyncAlarmScheduler(alarms, () => time),
    advance: (next: number) => { time = next; }, due: () => scheduledTime,
    fire: () => { scheduledTime = undefined; } };
}

describe('MV3 sync wake deadlines', () => {
  it('repeated early reconciliation wakes do not starve the existing Pull alarm', async () => {
    const h = alarmHarness();
    await h.schedule(30_000);
    for (const time of [10_000, 20_000, 29_999]) {
      h.advance(time);
      await h.schedule(30_000 - time);
    }
    expect(h.due()).toBe(30_000);
    expect(h.alarms.create).toHaveBeenCalledTimes(1);
    h.fire(); h.advance(30_000);
    await h.schedule(30_000);
    expect(h.due()).toBe(60_000);
  });

  it('concurrent longer and shorter delays retain the earlier valid platform deadline', async () => {
    const h = alarmHarness();
    await Promise.all([h.schedule(120_000), h.schedule(1_000), h.schedule(90_000)]);
    expect(h.due()).toBe(30_000);
  });

  it('a rejected alarm read does not prevent a later successful schedule', async () => {
    const h = alarmHarness();
    h.alarms.get.mockRejectedValueOnce(new Error('unavailable'));
    await expect(h.schedule(1_000)).rejects.toThrow('unavailable');
    await h.schedule(1_000);
    expect(h.due()).toBe(30_000);
  });
});
