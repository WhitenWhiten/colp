interface DeliveryQueue {
  nextRecipient(excludedOwners: readonly string[], after: string): Promise<{ ownerId: string; targetId: string } | null>;
  tick(targetId?: string): Promise<boolean>;
}

/** One in-flight callback per Owner, bounded concurrency across Owners. Housekeeping
 * has its own clock and runs even when Events is disabled or a receiver is slow. */
export function createAutomationMaintenanceLoop(options: {
  delivery?: DeliveryQueue; maintain(): Promise<void>;
  onError(kind: 'delivery' | 'maintenance', error: unknown): void;
  concurrency?: number; intervalMs?: number;
}) {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new RangeError('Invalid delivery concurrency');
  const active = new Map<string, Promise<void>>();
  let stopping = true, after = '', refill = false;
  let deliveryTimer: ReturnType<typeof setInterval> | undefined, maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let dispatch: Promise<void> | undefined, maintenance: Promise<void> | undefined;

  function deliveries() {
    if (stopping || !options.delivery || dispatch) return;
    refill = false;
    dispatch = (async () => {
      for (let n = 0; n < concurrency && !stopping && active.size < concurrency; n++) {
        const recipient = await options.delivery!.nextRecipient([...active.keys()], after);
        if (!recipient || stopping) break;
        after = `${recipient.ownerId}:${recipient.targetId}`;
        let progressed = false;
        const work = options.delivery!.tick(recipient.targetId)
          .then(result => { progressed = result; }, error => options.onError('delivery', error))
          .finally(() => {
            active.delete(recipient.ownerId);
            if (progressed && !stopping) { refill = true; if (!dispatch) deliveries(); }
          });
        active.set(recipient.ownerId, work);
      }
    })().catch(error => options.onError('delivery', error)).finally(() => { dispatch = undefined; if (refill && !stopping) deliveries(); });
  }
  function maintain() {
    if (stopping || maintenance) return;
    maintenance = options.maintain().catch(error => options.onError('maintenance', error)).finally(() => { maintenance = undefined; });
  }
  return {
    start() {
      if (!stopping) return;
      stopping = false;
      if (options.delivery) { deliveryTimer = setInterval(deliveries, options.intervalMs ?? 1000); deliveryTimer.unref(); deliveries(); }
      maintenanceTimer = setInterval(maintain, options.intervalMs ?? 1000); maintenanceTimer.unref(); maintain();
    },
    async stop() {
      stopping = true;
      clearInterval(deliveryTimer); clearInterval(maintenanceTimer);
      deliveryTimer = maintenanceTimer = undefined;
      await dispatch;
      await Promise.all([...active.values(), maintenance]);
    },
  };
}
