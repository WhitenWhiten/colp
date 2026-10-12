/** Serialize one mapping across alarms, manual refreshes and exit actions. */
const lanes = new Map<string, Promise<unknown>>();
export function subscriptionLane<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = lanes.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(work);
  lanes.set(key, task);
  void task.finally(() => { if (lanes.get(key) === task) lanes.delete(key); }).catch(() => undefined);
  return task;
}
export const withMapping = <T>(id: string, work: () => Promise<T>) => subscriptionLane('mapping:' + id, work);
export const mappingBusy = (id: string) => lanes.has('mapping:' + id);
/** Observe the current lane without joining it or blocking other maintenance. */
export function whenMappingIdle(id: string): Promise<void> {
  return (lanes.get('mapping:' + id) ?? Promise.resolve()).then(() => undefined, () => undefined);
}
export function tryWithMapping<T>(id: string, work: () => Promise<T>): Promise<T> | undefined {
  return mappingBusy(id) ? undefined : withMapping(id, work);
}

/** Content snapshots/applications share a profile-wide two-slot admission limit. */
let contentActive=0;
const contentWaiters:Array<()=>void>=[];
export async function withContentSlot<T>(work:()=>Promise<T>):Promise<T>{
  await new Promise<void>(resolve=>{const start=()=>{contentActive++;resolve();};if(contentActive<2)start();else contentWaiters.push(start);});
  try{return await work();}finally{contentActive--;contentWaiters.shift()?.();}
}
export async function runFairMappings<T>(rows:T[],work:(row:T)=>Promise<void>,concurrency=3){let next=0;await Promise.all(Array.from({length:Math.min(concurrency,rows.length)},async()=>{for(;;){const index=next++;if(index>=rows.length)return;await work(rows[index]!);}}));}
/** Finish due permission work before large content jobs occupy application slots. */
export async function maintainThenApply<T,U>(rows:T[],maintain:(row:T)=>Promise<U|undefined>,apply:(row:U)=>Promise<void>){
  const ready:U[]=[];
  await runFairMappings(rows,async row=>{const next=await maintain(row);if(next!==undefined)ready.push(next);});
  await runFairMappings(ready,apply,2);
}
