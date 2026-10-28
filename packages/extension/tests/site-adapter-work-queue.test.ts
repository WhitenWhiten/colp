import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { createSourceDatabase } from '../src/site-adapters/source-db.js';
import { createSourceWorkQueue, enqueueSourcePlan } from '../src/site-adapters/work-queue.js';
import { createSourceAlarmScheduler } from '../src/site-adapters/wake-scheduler.js';
async function fixture() {
  const db = createSourceDatabase(new IDBFactory());
  const add = (id: string, queued = true) => db.transaction(['savePlans', 'work'], 'readwrite', async tx => {
    tx.objectStore('savePlans').put({ state: 'approved', plan: { id, effects: [{ effectId: 'bookmark', dependsOn: [] }] } }, id);
    if (queued) await enqueueSourcePlan(tx, id);
  });
  return { db, add };
}
test('completed history is never read before new work, including a later lower-key insert', async () => {
  const f = await fixture();
  try {
    await f.db.transaction(['savePlans'], 'readwrite', async tx => {
      for (let i = 0; i < 5000; i++) tx.objectStore('savePlans').put({ state: 'approved', plan: { id: `old-${i}`, effects: [] } }, `old-${i}`);
    });
    const read = vi.spyOn(f.db, 'read'), execute = vi.fn(async () => ({ status: 'confirmed' })), schedule = vi.fn();
    const run = createSourceWorkQueue(f.db, { execute, schedule });
    await f.add('zzz'); await run(); await f.add('aaa'); await run();
    expect(execute.mock.calls).toHaveLength(2); expect(read.mock.calls.some(c => String(c[1]).startsWith('old-'))).toBe(false);
    expect(await f.db.read('savePlans', 'old-1')).toBeDefined(); expect(await f.db.read('work', 'aaa')).toBeUndefined();
  } finally { await f.db.close(); }
});
test('a failed task is isolated and a newly inserted task receives another wake', async () => {
  const f = await fixture(); let time = 100, inserted = false;
  try {
    await f.add('first'); await f.add('second');
    const execute = vi.fn(async (id: string) => {
      if (id === 'first') throw Error('offline');
      if (!inserted) { inserted = true; await f.add('aaa'); }
      return { status: 'confirmed' };
    });
    const schedule = vi.fn(), run = createSourceWorkQueue(f.db, { execute, schedule, now: () => time });
    await run(); expect(schedule).toHaveBeenLastCalledWith(150);
    expect(await f.db.read('work', 'first')).toMatchObject({ reason: 'offline', dueAt: 30100 });
    await run(); expect(execute).toHaveBeenCalledWith('aaa', 'bookmark');
    expect(execute.mock.calls.filter(([id]) => id === 'first')).toHaveLength(1);
    time = 30101; await run(); expect(execute.mock.calls.filter(([id]) => id === 'first')).toHaveLength(2);
  } finally { await f.db.close(); }
});
test('an interrupted claim becomes ready after its durable lease expires', async () => {
  const f = await fixture();
  try {
    await f.add('pending');
    await f.db.transaction(['work'], 'readwrite', async tx => { tx.objectStore('work').put({ id: 'pending', dueAt: 30000, attempts: 1 }, 'pending'); });
    let time = 1; const execute = vi.fn(async () => ({ status: 'confirmed' })), schedule = vi.fn();
    await createSourceWorkQueue(f.db, { execute, schedule, now: () => time })(); expect(execute).not.toHaveBeenCalled();
    time = 30001; await createSourceWorkQueue(f.db, { execute, schedule, now: () => time })(); expect(execute).toHaveBeenCalledOnce();
  } finally { await f.db.close(); }
});
test('later alarm producers cannot postpone an earlier pending wake', async () => {
  let at: number | undefined;
  const create = vi.fn(async (_: string, info: { when: number }) => { at = info.when; });
  const schedule = createSourceAlarmScheduler({ get: async () => at === undefined ? undefined : { scheduledTime: at }, create });
  await Promise.all([schedule(100), schedule(30000), schedule(50), schedule(60000)]);
  expect(at).toBe(50); expect(create).toHaveBeenCalledTimes(2);
});
