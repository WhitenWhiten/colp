/**
 * P-06 bounded overdue collaboration-invite expiry. GET lists are read-only;
 * writes still expire per-collection. This worker expires globally in a
 * bounded batch so pending rows cannot accumulate unbounded.
 */
export interface CollaborationInviteMaintenancePort {
  expireOverdue(options?: {
    readonly now?: Date;
    readonly limit?: number;
  }): Promise<number>;
}

export type CollaborationInviteMaintenancePortFactory =
  () => CollaborationInviteMaintenancePort | Promise<CollaborationInviteMaintenancePort>;

export interface CollaborationInviteCleanupSchedule {
  stop(): Promise<void>;
}

export const COLLABORATION_INVITE_CLEANUP_BATCH_MAX = 10_000;

/**
 * Runs bounded overdue-invite expiry outside list GETs. Overlapping ticks
 * are coalesced so a slow database cannot queue unbounded work.
 */
export function scheduleCollaborationInviteCleanup(
  maintenance: CollaborationInviteMaintenancePortFactory,
  options: {
    readonly intervalMs: number;
    readonly batchSize: number;
    readonly now?: () => Date;
    readonly onExpired?: (count: number) => void;
    readonly onError?: (error: unknown) => void;
  },
): CollaborationInviteCleanupSchedule {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new RangeError('Collaboration invite cleanup interval must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(options.batchSize)
    || options.batchSize < 1
    || options.batchSize > COLLABORATION_INVITE_CLEANUP_BATCH_MAX
  ) {
    throw new RangeError('Collaboration invite cleanup batch size must be between 1 and 10000');
  }

  let running = false;
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    active = Promise.resolve(maintenance())
      .then((port) => port.expireOverdue({
        limit: options.batchSize,
        now: options.now?.(),
      }))
      .then((count) => options.onExpired?.(count))
      .catch((error: unknown) => {
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
