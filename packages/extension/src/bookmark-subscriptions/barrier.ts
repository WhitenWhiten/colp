/** MV3/pages share the browser Web Lock; unresolved IDB intents survive its release on worker death. */
const NAME='known-bookmark-subscriptions-native-boundary';
let fallback:Promise<unknown>=Promise.resolve();
export function subscriptionBoundary<T>(mode:'shared'|'exclusive',work:()=>Promise<T>):Promise<T>{
  const locks=typeof navigator!=='undefined'?navigator.locks:undefined;
  if(locks)return locks.request(NAME,{mode},work);
  // Non-browser adapters/tests have a single context. Mounting checks native Web Locks separately.
  const task=fallback.then(work,work);fallback=task.catch(()=>undefined);return task;
}
export const withSubscriptionRead=<T>(work:()=>Promise<T>)=>subscriptionBoundary('shared',work);
export const withSubscriptionCreate=<T>(work:()=>Promise<T>)=>subscriptionBoundary('exclusive',work);
