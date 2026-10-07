import {
  createDigestScheduler,
  type DigestScheduleConnector,
  type DigestSchedulerOptions,
} from './scheduler.js';

export type ReportsSchedulerReadiness = 'disabled' | 'ready' | 'not_ready';

export interface ReportsSchedulerComposition {
  readonly scheduler: ReturnType<typeof createDigestScheduler>;
  readonly readiness: () => ReportsSchedulerReadiness;
}

/**
 * Compose the optional scheduler without manufacturing a fake durable store.
 * An enabled scheduler is `not_ready` until both the run ledger and controlled
 * connector are present; callers may use that state in startup/readiness rather
 * than silently creating pending runs which can never be submitted.
 */
export function composeReportsScheduler(input: {
  readonly enabled: boolean;
  readonly connector?: DigestScheduleConnector;
  readonly store?: DigestSchedulerOptions['store'];
  readonly ownerId?: string;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly maxCatchUp?: number;
  readonly leaseMs?: number;
  readonly handlerTimeoutMs?: number;
  readonly now?: () => Date;
}): ReportsSchedulerComposition {
  if (!input.enabled) {
    return {
      scheduler: createDigestScheduler({
        store: unavailableStore(),
        ownerId: input.ownerId ?? 'reports-scheduler-disabled',
        ...(input.now === undefined ? {} : { now: input.now }),
      }),
      readiness: () => 'disabled',
    };
  }
  if (!input.connector || !input.store) {
    // Keep an inert scheduler object for graceful shutdown, but expose the
    // missing dependency honestly. Worker composition must reject this state
    // before start() rather than claiming work into an unusable ledger.
    return {
      scheduler: createDigestScheduler({
        store: unavailableStore(),
        ownerId: input.ownerId ?? 'reports-scheduler-not-ready',
        ...(input.now === undefined ? {} : { now: input.now }),
      }),
      readiness: () => 'not_ready',
    };
  }
  return {
    scheduler: createDigestScheduler({
      store: input.store,
      connector: input.connector,
      ownerId: input.ownerId ?? 'reports-scheduler',
      batchSize: Math.max(1, input.concurrency ?? 1),
      ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      ...(input.maxCatchUp === undefined ? {} : { maxCatchUp: input.maxCatchUp }),
      ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
      ...(input.handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs: input.handlerTimeoutMs }),
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
    readiness: () => 'ready',
  };
}

function unavailableStore(): DigestSchedulerOptions['store'] {
  return {
    listDue: async () => [],
    listDueRuns: async () => [],
    getSchedule: async () => null,
    upsertRun: async () => { throw new Error('reports scheduler is disabled'); },
    claimRun: async () => null,
    completeRun: async () => undefined,
    retryRun: async () => undefined,
    failRun: async () => undefined,
  };
}
