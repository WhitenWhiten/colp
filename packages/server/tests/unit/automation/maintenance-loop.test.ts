import { afterEach, expect, test, vi } from 'vitest';
import { createAutomationMaintenanceLoop } from '../../../src/infrastructure/automation/maintenance-loop.js';

afterEach(() => vi.useRealTimers());

test('slow Owner cannot block another Owner or housekeeping; stop drains without starting more work', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const queued = [{ownerId:'slow',targetId:'a'}, {ownerId:'slow',targetId:'b'}, {ownerId:'fast',targetId:'c'}];
  const sent: string[] = [];
  const maintain = vi.fn(async () => {}), onError = vi.fn();
  const loop = createAutomationMaintenanceLoop({concurrency:2,intervalMs:10,maintain,onError,delivery:{
    nextRecipient: async excluded => queued.find(r => !excluded.includes(r.ownerId)) ?? null,
    tick: async target => {
      queued.splice(queued.findIndex(r => r.targetId===target),1);sent.push(target!);
      if(target==='a')await blocked;
      return true;
    },
  }});
  loop.start();await vi.advanceTimersByTimeAsync(35);
  expect(sent).toEqual(['a','c']);expect(maintain.mock.calls.length).toBeGreaterThan(2);
  const stopping=loop.stop();release();await stopping;
  await vi.advanceTimersByTimeAsync(100);expect(sent).toEqual(['a','c']);expect(onError).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('housekeeping runs independently with Events disabled and failures do not strand its timer', async () => {
  vi.useFakeTimers();
  const maintain=vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined),onError=vi.fn();
  const loop=createAutomationMaintenanceLoop({maintain,onError,intervalMs:10});
  loop.start();await vi.advanceTimersByTimeAsync(25);await loop.stop();
  expect(maintain).toHaveBeenCalledTimes(3);expect(onError).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});


test('fast completions refill slots without waiting another polling interval', async () => {
  vi.useFakeTimers();
  const queue=Array.from({length:20},(_,i)=>({ownerId:String(i),targetId:String(i)}));
  const sent:string[]=[];
  const loop=createAutomationMaintenanceLoop({maintain:async()=>{},onError:()=>{},delivery:{
    nextRecipient:async excluded=>queue.find(r=>!excluded.includes(r.ownerId)) ?? null,
    tick:async target=>{queue.splice(queue.findIndex(r=>r.targetId===target),1);sent.push(target!);return true;},
  }});
  loop.start();await vi.advanceTimersByTimeAsync(0);await loop.stop();
  expect(sent).toHaveLength(20);expect(vi.getTimerCount()).toBe(0);
});
