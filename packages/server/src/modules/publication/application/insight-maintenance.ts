import {
  PUBLICATION_INSIGHT_PURGE_LIMIT,
  type PublicationInsightPurgeCounts,
} from './record-insight-event.js';

export interface PublicationInsightMaintenancePort {
  purgeExpired(options?: {
    readonly now?: Date;
    readonly limit?: number;
  }): Promise<PublicationInsightPurgeCounts>;
}

export type PublicationInsightMaintenancePortFactory =
  () => PublicationInsightMaintenancePort | Promise<PublicationInsightMaintenancePort>;

export interface PublicationInsightPurgeSchedule {
  stop(): Promise<void>;
}

/**
 * Runs bounded insight retention cleanup outside ingest request transactions.
 * Overlapping ticks are coalesced so a slow database cannot queue unbounded work.
 */
export function schedulePublicationInsightPurge(
  maintenance: PublicationInsightMaintenancePortFactory,
  options: {
    readonly intervalMs: number;
    readonly batchSize: number;
    readonly now?: () => Date;
    readonly onPurged?: (counts: PublicationInsightPurgeCounts) => void;
    readonly onError?: (error: unknown) => void;
  },
): PublicationInsightPurgeSchedule {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new RangeError('Publication insight purge interval must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(options.batchSize)
    || options.batchSize < 1
    || options.batchSize > 10_000
  ) {
    throw new RangeError('Publication insight purge batch size must be between 1 and 10000');
  }

  let running = false;
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    active = Promise.resolve(maintenance())
      .then((port) => port.purgeExpired({
        limit: options.batchSize ?? PUBLICATION_INSIGHT_PURGE_LIMIT,
        now: options.now?.(),
      }))
      .then((counts) => options.onPurged?.(counts))
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
