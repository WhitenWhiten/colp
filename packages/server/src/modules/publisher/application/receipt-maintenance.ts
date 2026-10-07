import type {
  PublisherReceiptMaintenancePortFactory,
} from './ports.js';

export interface PublisherReceiptPurgeSchedule {
  stop(): Promise<void>;
}

/**
 * Runs bounded cleanup outside Publisher request transactions. Overlapping ticks
 * are coalesced so a slow database cannot create an unbounded maintenance queue.
 */
export function schedulePublisherReceiptPurge(
  maintenance: PublisherReceiptMaintenancePortFactory,
  options: {
    readonly intervalMs: number;
    readonly batchSize: number;
    readonly onPurged?: (count: number) => void;
    readonly onError?: (error: unknown) => void;
  },
): PublisherReceiptPurgeSchedule {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new RangeError('Publisher receipt purge interval must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 10_000) {
    throw new RangeError('Publisher receipt purge batch size must be between 1 and 10000');
  }

  let running = false;
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    active = Promise.resolve(maintenance())
      .then((port) => port.purgeExpired({ limit: options.batchSize }))
      .then((count) => options.onPurged?.(count))
      .catch((error: unknown) => {
        // Maintenance must never create an unhandled rejection, including when
        // an observer fails while reporting the original cleanup error.
        try {
          options.onError?.(error);
        } catch {
          // The next scheduled tick remains eligible to run.
        }
      })
      .finally(() => {
        running = false;
        active = undefined;
      });
  }, options.intervalMs);
  timer.unref?.();
  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await active;
    },
  };
}
