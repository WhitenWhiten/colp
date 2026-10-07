import type { NotificationAuthorityRepository } from './repository.js';

export interface NotificationOperationsConfig {
  readonly queueAgeNotReadyMs: number;
  readonly queueBacklogNotReady: number;
  readonly queueDeadLetterNotReady: number;
  readonly deliveryBacklogDegraded: number;
  readonly deliveryDeadLetterDegraded: number;
  readonly retentionDays: number;
  readonly purgeBatchSize: number;
  readonly recoveryBatchSize: number;
  readonly recoveryMaxEvents: number;
  readonly recoveryTimeoutMs: number;
}

export interface NotificationWorkerCapacity {
  readonly workerConcurrency: number; readonly workerBatchSize: number;
  readonly workerLeaseDurationMs: number; readonly workerHandlerTimeoutMs: number;
}

export interface NotificationOperationsStatus {
  readonly dependency: 'available' | 'unavailable';
  readonly worker: 'running' | 'idle' | 'stopped' | 'unknown';
  readonly readyCount: number; readonly retryCount: number; readonly leasedCount: number;
  readonly deadLetterCount: number; readonly oldestEligibleAgeMs: number;
  readonly oldestDeadLetterAgeMs: number; readonly sourceEventCount: string;
  readonly processedEventCount: string; readonly maximumEventLag: string;
  readonly queueErrors: Readonly<{ unknownFutureVersion: number; invalidContract: number;
    retryExhausted: number; dependency: number; providerUnavailable: number; other: number }>;
  readonly delivery: Readonly<{ pendingCount: number; retryCount: number; leasedCount: number;
    deliveredCount: number; suppressedCount: number; deadLetterCount: number;
    oldestEligibleAgeMs: number; oldestDeadLetterAgeMs: number;
    errors: Readonly<{ unknownFutureVersion: number; invalidContract: number;
      retryExhausted: number; dependency: number; providerUnavailable: number; other: number }> }>;
}

export interface NotificationAccountEvidence {
  readonly preferences: readonly Readonly<{ channel: 'email' | 'in_app'; enabled: boolean;
    stateRevision: string; updatedAt: Date }>[];
  readonly notifications: readonly Readonly<{ notificationId: string; sourceEventId: string;
    state: 'read' | 'unread'; stateRevision: string; readAt: Date | null;
    retainUntil: Date }>[];
  readonly deliveries: readonly Readonly<{ deliveryId: string; notificationId: string;
    state: string; attemptCount: number; stateRevision: string; nextAttemptAt: Date;
    leasedUntil: Date | null; deadLetteredAt: Date | null; errorCategory: string | null }>[];
}

export interface NotificationOperationsRepository {
  inspectStatus(): Promise<NotificationOperationsStatus>;
  captureAccount(recipientAccountId: string): Promise<NotificationAccountEvidence>;
  replayDeadLetters(input: { readonly recipientAccountId: string; readonly limit: number;
    readonly allowUnknownFutureVersion?: boolean }): Promise<Readonly<{
      outboxIds: readonly string[]; deliveryIds: readonly string[] }>>;
  recoverMissingSources(input: { readonly recipientAccountId: string;
    readonly limit: number }): Promise<Readonly<{ outboxIds: readonly string[] }>>;
}

export interface NotificationOperationsMetrics { gauge(name: string, value: number): void }
export type NotificationCapabilityReadiness = Readonly<{ capability: 'notifications';
  status: 'ready' | 'not-ready'; reason: 'none' | 'dependency_unavailable' |
    'worker_unavailable' | 'queue_age' | 'backlog' | 'dead_letter';
  inApp: Readonly<{ status: 'ready' | 'not-ready'; reason: string }>;
  optionalDelivery: Readonly<{ status: 'available' | 'degraded'; reason: string }> }>;

export function assertNotificationOperationsConfig(config: NotificationOperationsConfig,
  capacity: NotificationWorkerCapacity): void {
  bounded(config.queueAgeNotReadyMs, 'queueAgeNotReadyMs', 86_400_000);
  bounded(config.queueBacklogNotReady, 'queueBacklogNotReady', 1_000_000);
  bounded(config.queueDeadLetterNotReady, 'queueDeadLetterNotReady', 1_000_000);
  bounded(config.deliveryBacklogDegraded, 'deliveryBacklogDegraded', 1_000_000);
  bounded(config.deliveryDeadLetterDegraded, 'deliveryDeadLetterDegraded', 1_000_000);
  bounded(config.retentionDays, 'retentionDays', 3650);
  bounded(config.purgeBatchSize, 'purgeBatchSize', 10_000);
  bounded(config.recoveryBatchSize, 'recoveryBatchSize', 1_000);
  bounded(config.recoveryMaxEvents, 'recoveryMaxEvents', 10_000);
  bounded(config.recoveryTimeoutMs, 'recoveryTimeoutMs', 3_600_000);
  if (config.retentionDays !== 90) {
    throw new RangeError('retentionDays must match the read-state Notification authority retention (unread 365 / read 90 / delivery 30)');
  }
  if (config.recoveryMaxEvents < config.recoveryBatchSize) {
    throw new RangeError('recoveryMaxEvents must cover one recovery batch');
  }
  bounded(capacity.workerConcurrency, 'workerConcurrency', 64);
  bounded(capacity.workerBatchSize, 'workerBatchSize', 64);
  bounded(capacity.workerLeaseDurationMs, 'workerLeaseDurationMs', 3_600_000);
  bounded(capacity.workerHandlerTimeoutMs, 'workerHandlerTimeoutMs', 3_600_000);
  if (capacity.workerBatchSize > capacity.workerConcurrency
      || capacity.workerHandlerTimeoutMs > capacity.workerLeaseDurationMs
      || config.recoveryTimeoutMs > capacity.workerLeaseDurationMs) {
    throw new RangeError('Notification operations capacity is incoherent with worker lease capacity');
  }
}

/**
 * m2: the API process never runs the optional email delivery loop itself, so
 * the worker-running signal for feature-scoped readiness is derived from the
 * notification operations repository state (which observes worker activity via
 * leases/completions on the shared database). 'running'/'idle' mean a worker is
 * demonstrably consuming or the queue is drained (treated as running); 'stopped'
 * (due work with no worker activity) and 'unknown' (repository dependency
 * unavailable) fail closed as NOT running so readiness reports
 * degraded/worker_unavailable instead of claiming the optional channel is
 * available (gate doc 14.6).
 */
export function deriveEmailDeliveryWorkerRunning(
  worker: NotificationOperationsStatus['worker'],
): boolean {
  return worker === 'running' || worker === 'idle';
}

export function evaluateNotificationCapabilityReadiness(status: NotificationOperationsStatus,
  config: NotificationOperationsConfig,
  emailDelivery?: { readonly enabled: boolean; readonly workerRunning?: boolean },
): NotificationCapabilityReadiness {
  const reason = status.dependency === 'unavailable' ? 'dependency_unavailable'
    : status.worker !== 'running' && status.worker !== 'idle' ? 'worker_unavailable'
      : status.deadLetterCount >= config.queueDeadLetterNotReady ? 'dead_letter'
        : status.oldestEligibleAgeMs >= config.queueAgeNotReadyMs ? 'queue_age'
          : status.readyCount + status.retryCount >= config.queueBacklogNotReady ? 'backlog' : 'none';
  // P5-29 feature-scoped semantics: the optional email delivery channel is
  // reported degraded when the feature is disabled (no worker runs) or the
  // worker is known-stopped; in-app Notification readiness is NEVER affected
  // by the optional delivery channel (the inApp status above ignores it).
  let deliveryReason: 'none' | 'backlog' | 'dead_letter' | 'disabled' | 'worker_unavailable';
  if (emailDelivery && !emailDelivery.enabled) {
    deliveryReason = 'disabled';
  } else if (emailDelivery?.enabled === true && emailDelivery.workerRunning === false) {
    deliveryReason = 'worker_unavailable';
  } else {
    deliveryReason = status.delivery.deadLetterCount >= config.deliveryDeadLetterDegraded
      ? 'dead_letter' : status.delivery.pendingCount + status.delivery.retryCount
        >= config.deliveryBacklogDegraded ? 'backlog' : 'none';
  }
  return Object.freeze({ capability: 'notifications', status: reason === 'none' ? 'ready' : 'not-ready',
    reason, inApp: Object.freeze({ status: reason === 'none' ? 'ready' : 'not-ready', reason }),
    optionalDelivery: Object.freeze({ status: deliveryReason === 'none' ? 'available' : 'degraded',
      reason: deliveryReason }) });
}

export function publishNotificationOperationsMetrics(status: NotificationOperationsStatus,
  metrics: NotificationOperationsMetrics): void {
  const values: Readonly<Record<string, number>> = {
    'notifications.queue.ready': status.readyCount, 'notifications.queue.retry': status.retryCount,
    'notifications.queue.leased': status.leasedCount,
    'notifications.queue.dead_letter': status.deadLetterCount,
    'notifications.queue.oldest_eligible_age_ms': status.oldestEligibleAgeMs,
    'notifications.queue.oldest_dead_letter_age_ms': status.oldestDeadLetterAgeMs,
    'notifications.queue.source_event_count': ordinal(status.sourceEventCount),
    'notifications.queue.processed_event_count': ordinal(status.processedEventCount),
    'notifications.queue.maximum_event_lag': ordinal(status.maximumEventLag),
    'notifications.queue.error.unknown_future_version': status.queueErrors.unknownFutureVersion,
    'notifications.queue.error.invalid_contract': status.queueErrors.invalidContract,
    'notifications.queue.error.retry_exhausted': status.queueErrors.retryExhausted,
    'notifications.queue.error.dependency': status.queueErrors.dependency,
    'notifications.queue.error.provider_unavailable': status.queueErrors.providerUnavailable,
    'notifications.queue.error.other': status.queueErrors.other,
    'notifications.worker.running': ['running', 'idle'].includes(status.worker) ? 1 : 0,
    'notifications.dependency.available': status.dependency === 'available' ? 1 : 0,
    'notifications.delivery.pending': status.delivery.pendingCount,
    'notifications.delivery.retry': status.delivery.retryCount,
    'notifications.delivery.leased': status.delivery.leasedCount,
    'notifications.delivery.delivered': status.delivery.deliveredCount,
    'notifications.delivery.suppressed': status.delivery.suppressedCount,
    'notifications.delivery.dead_letter': status.delivery.deadLetterCount,
    'notifications.delivery.oldest_eligible_age_ms': status.delivery.oldestEligibleAgeMs,
    'notifications.delivery.oldest_dead_letter_age_ms': status.delivery.oldestDeadLetterAgeMs,
    'notifications.delivery.error.unknown_future_version': status.delivery.errors.unknownFutureVersion,
    'notifications.delivery.error.invalid_contract': status.delivery.errors.invalidContract,
    'notifications.delivery.error.retry_exhausted': status.delivery.errors.retryExhausted,
    'notifications.delivery.error.dependency': status.delivery.errors.dependency,
    'notifications.delivery.error.provider_unavailable': status.delivery.errors.providerUnavailable,
    'notifications.delivery.error.other': status.delivery.errors.other,
    'notifications.in_app.ready': status.dependency === 'available' ? 1 : 0,
    'notifications.optional_delivery.available': status.delivery.deadLetterCount === 0 ? 1 : 0,
  };
  for (const [name, value] of Object.entries(values)) metrics.gauge(name, value);
}

export async function purgeNotificationRetentionForOperations(input: {
  readonly authority: NotificationAuthorityRepository; readonly operations: NotificationOperationsRepository;
  readonly recipientAccountId: string; readonly cutoff: Date; readonly limit: number;
}) {
  const before = await input.operations.captureAccount(input.recipientAccountId);
  // FIX-H-005: the independent 30-day delivery purge runs FIRST under its own
  // resolved-terminal policy, then the state-aware Notification purge whose
  // FK cascade removes whatever delivery rows remain for purged rows.
  const purgedDeliveries = await input.authority.purgeExpiredDeliveries({ cutoff: input.cutoff,
    limit: input.limit, recipientAccountId: input.recipientAccountId });
  const purged = await input.authority.purgeExpiredNotifications({ cutoff: input.cutoff,
    limit: input.limit, recipientAccountId: input.recipientAccountId });
  const after = await input.operations.captureAccount(input.recipientAccountId);
  return Object.freeze({ beforePreferences: before.preferences,
    beforeNotifications: before.notifications, beforeDeliveries: before.deliveries,
    afterPreferences: after.preferences, afterNotifications: after.notifications,
    afterDeliveries: after.deliveries, deletedCount: purged.deletedCount,
    deletedNotificationIds: purged.notificationIds,
    deletedDeliveryCount: purgedDeliveries.deletedCount,
    deletedDeliveryIds: purgedDeliveries.deliveryIds });
}

export async function replayNotificationDeadLettersForOperations(input: {
  readonly operations: NotificationOperationsRepository; readonly recipientAccountId: string;
  readonly limit: number; readonly allowUnknownFutureVersion?: boolean;
}) {
  const before = await input.operations.captureAccount(input.recipientAccountId);
  const replayed = await input.operations.replayDeadLetters(input);
  const after = await input.operations.captureAccount(input.recipientAccountId);
  return Object.freeze({ beforePreferences: before.preferences,
    beforeNotifications: before.notifications, beforeDeliveries: before.deliveries,
    afterPreferences: after.preferences, afterNotifications: after.notifications,
    afterDeliveries: after.deliveries, ...replayed });
}

export async function recoverNotificationAccountForOperations(input: {
  readonly operations: NotificationOperationsRepository; readonly recipientAccountId: string;
  readonly limit: number;
}) {
  const before = await input.operations.captureAccount(input.recipientAccountId);
  const replayed = await input.operations.recoverMissingSources({
    recipientAccountId: input.recipientAccountId, limit: input.limit });
  const after = await input.operations.captureAccount(input.recipientAccountId);
  return Object.freeze({ beforePreferences: before.preferences,
    beforeNotifications: before.notifications, beforeDeliveries: before.deliveries,
    afterPreferences: after.preferences, afterNotifications: after.notifications,
    afterDeliveries: after.deliveries, outboxIds: replayed.outboxIds });
}

function bounded(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be between 1 and ${max}`);
  }
}
function ordinal(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return 0;
  const parsed = BigInt(value); return Number(parsed > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER : parsed);
}

