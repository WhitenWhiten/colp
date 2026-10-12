import { expect,test } from 'vitest';
import { maintainThenApply,runFairMappings,withContentSlot,withMapping } from '../src/bookmark-subscriptions/coordination.js';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
test('two content slots admit queued work after a failure without exceeding the profile limit',async()=>{
 const gates=Array.from({length:4},deferred),started:number[]=[];let active=0,peak=0;
 const tasks=gates.map((gate,i)=>withContentSlot(async()=>{started.push(i);active++;peak=Math.max(active,peak);await gate.promise;active--;if(i===0)throw new Error('network_failed');}));
 const settled=Promise.allSettled(tasks);await Promise.resolve();await Promise.resolve();expect(started).toEqual([0,1]);gates[0]!.resolve();
 await new Promise(resolve=>setTimeout(resolve,0));expect(started).toEqual([0,1,2]);gates[1]!.resolve();gates[2]!.resolve();gates[3]!.resolve();
 expect((await settled).map(r=>r.status)).toEqual(['rejected','fulfilled','fulfilled','fulfilled']);expect(peak).toBe(2);
});
test('fifty maintenance mappings continue around a blocked large source and serialize each mapping',async()=>{
 const gate=deferred(),started:number[]=[],finished:number[]=[];const all=runFairMappings(Array.from({length:50},(_,i)=>i),async id=>{started.push(id);if(id===0)await gate.promise;finished.push(id);});
 await new Promise(resolve=>setTimeout(resolve,0));expect(started).toHaveLength(50);expect(finished).toHaveLength(49);expect(finished).not.toContain(0);gate.resolve();await all;
 const first=deferred(),order:string[]=[];const a=withMapping('one',async()=>{order.push('first');await first.promise;});const b=withMapping('one',async()=>{order.push('second');});const c=withMapping('other',async()=>{order.push('other');});await c;expect(order).toEqual(['first','other']);first.resolve();await Promise.all([a,b]);expect(order).toEqual(['first','other','second']);
});
test('the runtime scheduler completes all fifty permission checks before any large content jobs can block lanes',async()=>{
 const release=deferred(),maintained:number[]=[],applied:number[]=[];let active=0,peak=0;
 const running=maintainThenApply(Array.from({length:50},(_,i)=>i),async id=>{maintained.push(id);return id===49?undefined:id;},async id=>{expect(maintained).toHaveLength(50);applied.push(id);active++;peak=Math.max(peak,active);await release.promise;active--;});
 await new Promise(resolve=>setTimeout(resolve,0));expect(maintained).toHaveLength(50);expect(applied).toHaveLength(2);release.resolve();await running;expect(applied).toHaveLength(49);expect(applied).not.toContain(49);expect(peak).toBe(2);
});
