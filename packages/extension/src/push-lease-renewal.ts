import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Keep one fenced Push lease alive until the drain's finally block closes it. */
export function startPushLeaseRenewal(input: {
  readonly store: Pick<ReturnType<typeof createSyncStateStore>, 'renewLease'>; readonly scope: SyncScope;
  readonly ownerId: string; readonly fence: number; readonly duration: number; readonly now: () => number;
}) {
  let failure: unknown;
  const timer = setInterval(() => {
    void input.store.renewLease(input.scope, input.ownerId, input.fence, input.now(), input.duration)
      .catch(error => { failure ??= error; });
  }, Math.max(1000, Math.floor(input.duration / 3)));
  return { assertCurrent() { if (failure) throw failure; }, close() { clearInterval(timer); } };
}
