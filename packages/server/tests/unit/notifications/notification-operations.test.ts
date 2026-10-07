import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { SOCIAL_FEED_WITHDRAWAL_HANDLER } from '../../../src/infrastructure/notifications/index.js';
import { SOCIAL_FEED_WITHDRAWAL_HANDLER as SOCIAL_FEED_WITHDRAWAL_ROUTE_HANDLER }
  from '../../../src/infrastructure/social/feed-withdrawal-worker-route.js';
import {
  assertNotificationOperationsConfig,
  deriveEmailDeliveryWorkerRunning,
  evaluateNotificationCapabilityReadiness,
  publishNotificationOperationsMetrics,
  recoverNotificationAccountForOperations,
  type NotificationAccountEvidence,
  type NotificationOperationsRepository,
  type NotificationOperationsStatus,
} from '../../../src/modules/notifications/index.js';

const config = Object.freeze({ queueAgeNotReadyMs: 60_000, queueBacklogNotReady: 1_000,
  queueDeadLetterNotReady: 1, deliveryBacklogDegraded: 500,
  deliveryDeadLetterDegraded: 1, retentionDays: 90, purgeBatchSize: 250,
  recoveryBatchSize: 100, recoveryMaxEvents: 500, recoveryTimeoutMs: 30_000 });
const capacity = Object.freeze({ workerConcurrency: 4, workerBatchSize: 2,
  workerLeaseDurationMs: 40_000, workerHandlerTimeoutMs: 30_000 });

function status(overrides: Partial<NotificationOperationsStatus> = {}): NotificationOperationsStatus {
  return Object.freeze({ dependency: 'available', worker: 'running', readyCount: 2,
    retryCount: 1, leasedCount: 0, deadLetterCount: 0, oldestEligibleAgeMs: 800,
    oldestDeadLetterAgeMs: 0, sourceEventCount: '3', processedEventCount: '2',
    maximumEventLag: '1',
    queueErrors: { unknownFutureVersion: 0, invalidContract: 0, retryExhausted: 0,
      dependency: 0, providerUnavailable: 0, other: 0 },
    delivery: { pendingCount: 0, retryCount: 0, leasedCount: 0,
      deliveredCount: 0, suppressedCount: 0, deadLetterCount: 0,
      oldestEligibleAgeMs: 0, oldestDeadLetterAgeMs: 0,
      errors: { unknownFutureVersion: 0, invalidContract: 0, retryExhausted: 0,
        dependency: 0, providerUnavailable: 0, other: 0 } }, ...overrides });
}

function accountEvidence(tag: 'before' | 'after'): NotificationAccountEvidence {
  const live = tag === 'before';
  return Object.freeze({ preferences: Object.freeze([Object.freeze({ channel: 'email',
    enabled: true, stateRevision: live ? 'pref-1' : 'pref-2',
    updatedAt: new Date('2026-01-01T00:00:00.000Z') })]),
    notifications: Object.freeze([Object.freeze({ notificationId: live ? 'n-1' : 'n-2',
      sourceEventId: live ? 's-1' : 's-2', state: 'unread', stateRevision: live ? 'r-1' : 'r-2',
      readAt: null, retainUntil: new Date('2026-04-01T00:00:00.000Z') })]),
    deliveries: Object.freeze([Object.freeze({ deliveryId: live ? 'd-1' : 'd-2',
      notificationId: live ? 'n-1' : 'n-2', state: 'pending', attemptCount: 1,
      stateRevision: live ? 'r-1' : 'r-2', nextAttemptAt: new Date('2026-01-02T00:00:00.000Z'),
      leasedUntil: null, deadLetteredAt: null, errorCategory: null })]),
  });
}

test('P5-25 rejects unsafe and cross-incoherent Notification operations capacity', () => {
  assert.doesNotThrow(() => assertNotificationOperationsConfig(config, capacity));
  for (const bad of [{ queueAgeNotReadyMs: 0 }, { queueBacklogNotReady: 0 },
    { queueDeadLetterNotReady: 0 }, { deliveryBacklogDegraded: 0 },
    { retentionDays: 89 }, { purgeBatchSize: 10_001 }, { recoveryBatchSize: 0 },
    { recoveryMaxEvents: 99 }, { recoveryTimeoutMs: 40_001 }]) {
    assert.throws(() => assertNotificationOperationsConfig({ ...config, ...bad }, capacity));
  }
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://known:known@localhost:5432/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    NOTIFICATION_RECOVERY_MAX_EVENTS: '99', NOTIFICATION_RECOVERY_BATCH_SIZE: '100' }),
  /recoveryMaxEvents must cover one recovery batch/u);
});

test('P5-25 readiness isolates in-app authority from optional delivery and other features', () => {
  assert.deepEqual(evaluateNotificationCapabilityReadiness(status(), config), {
    capability: 'notifications', status: 'ready', reason: 'none',
    inApp: { status: 'ready', reason: 'none' },
    optionalDelivery: { status: 'available', reason: 'none' },
  });
  const delivery = { ...status().delivery, pendingCount: 999, deadLetterCount: 9 };
  assert.deepEqual(evaluateNotificationCapabilityReadiness(status({ delivery }), config), {
    capability: 'notifications', status: 'ready', reason: 'none',
    inApp: { status: 'ready', reason: 'none' },
    optionalDelivery: { status: 'degraded', reason: 'dead_letter' },
  });
  assert.equal(evaluateNotificationCapabilityReadiness(status({ worker: 'stopped' }), config).status,
    'not-ready');
  // The baseline flows into readiness evaluation and its result composes into
  // the capability snapshot; evaluation must stay read-only over the shared
  // baseline (KA-P5-SOC-10).
  const baseline = status();
  const composition = { core: 'ready', feed: 'ready',
    notifications: evaluateNotificationCapabilityReadiness(baseline, config) };
  assert.deepEqual(baseline, status(), 'readiness must not mutate the shared baseline');
  assert.deepEqual(composition, { core: 'ready', feed: 'ready',
    notifications: { capability: 'notifications', status: 'ready', reason: 'none',
      inApp: { status: 'ready', reason: 'none' },
      optionalDelivery: { status: 'available', reason: 'none' } } });
});

test('P5-29 optional email readiness is feature-scoped and never degrades in-app', () => {
  assert.deepEqual(evaluateNotificationCapabilityReadiness(status(), config, { enabled: false }), {
    capability: 'notifications', status: 'ready', reason: 'none',
    inApp: { status: 'ready', reason: 'none' },
    optionalDelivery: { status: 'degraded', reason: 'disabled' },
  });
  assert.deepEqual(evaluateNotificationCapabilityReadiness(status(), config,
    { enabled: true, workerRunning: false }), {
    capability: 'notifications', status: 'ready', reason: 'none',
    inApp: { status: 'ready', reason: 'none' },
    optionalDelivery: { status: 'degraded', reason: 'worker_unavailable' },
  });
  assert.deepEqual(evaluateNotificationCapabilityReadiness(status(), config,
    { enabled: true, workerRunning: true }), {
    capability: 'notifications', status: 'ready', reason: 'none',
    inApp: { status: 'ready', reason: 'none' },
    optionalDelivery: { status: 'available', reason: 'none' },
  });
  // A delivery dead-letter backlog with the worker running degrades only the
  // optional channel; in-app authority stays ready (P5-29 completion standard).
  const delivery = { ...status().delivery, deadLetterCount: 9 };
  const degraded = evaluateNotificationCapabilityReadiness(status({ delivery }), config,
    { enabled: true, workerRunning: true });
  assert.deepEqual(degraded.inApp, { status: 'ready', reason: 'none' });
  assert.equal(degraded.optionalDelivery.status, 'degraded');
  assert.equal(degraded.optionalDelivery.reason, 'dead_letter');
});
test('m2: API-process workerRunning derivation feeds the full readiness matrix', () => {
  // The API process derives workerRunning from the repository worker state:
  // running/idle mean a worker is demonstrably consuming or the queue is
  // drained; stopped/unknown fail closed as NOT running.
  assert.equal(deriveEmailDeliveryWorkerRunning('running'), true);
  assert.equal(deriveEmailDeliveryWorkerRunning('idle'), true);
  assert.equal(deriveEmailDeliveryWorkerRunning('stopped'), false);
  assert.equal(deriveEmailDeliveryWorkerRunning('unknown'), false);

  // Matrix: disabled / enabled+worker-unknown / enabled+worker-stopped /
  // enabled+worker-running. In-app readiness is never degraded by the
  // optional channel.
  const disabled = evaluateNotificationCapabilityReadiness(status(), config,
    { enabled: false, workerRunning: false });
  assert.deepEqual(disabled.optionalDelivery, { status: 'degraded', reason: 'disabled' });
  assert.deepEqual(disabled.inApp, { status: 'ready', reason: 'none' });
  for (const worker of ['stopped', 'unknown'] as const) {
    // 'unknown' realistically co-occurs with dependency=unavailable (the
    // repository catch path); 'stopped' means due work with no worker activity.
    const base = worker === 'unknown'
      ? status({ dependency: 'unavailable', worker: 'unknown' })
      : status({ worker: 'stopped' });
    const degraded = evaluateNotificationCapabilityReadiness(base, config,
      { enabled: true, workerRunning: deriveEmailDeliveryWorkerRunning(worker) });
    assert.deepEqual(degraded.optionalDelivery,
      { status: 'degraded', reason: 'worker_unavailable' },
      `worker=${worker} must report degraded/worker_unavailable (m2)`);
    assert.deepEqual(degraded.inApp,
      worker === 'stopped'
        ? { status: 'not-ready', reason: 'worker_unavailable' }
        : { status: 'not-ready', reason: 'dependency_unavailable' },
      'in-app readiness reflects the notification worker/dependency state (m2)');
  }
  const running = evaluateNotificationCapabilityReadiness(status(), config,
    { enabled: true, workerRunning: deriveEmailDeliveryWorkerRunning('running') });
  assert.deepEqual(running.optionalDelivery, { status: 'available', reason: 'none' });
});

test('P5-25 metrics have fixed series and never label tenant, event, delivery or secret input', () => {
  const series = new Map<string, number>();
  const metrics = { gauge(name: string, value: number) { series.set(name, value); } };
  for (let index = 0; index < 200; index += 1) {
    publishNotificationOperationsMetrics(status({ readyCount: index,
      sourceEventCount: String(index), delivery: { ...status().delivery,
        pendingCount: index } }), metrics);
  }
  const serialized = JSON.stringify([...series]);
  for (const secret of ['tenant-secret-199', 'event-secret-199', 'delivery-secret-199']) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
  }
  assert.equal(series.size, 33);
  assert.ok([...series.keys()].every((name) => name.startsWith('notifications.')));
});

test('FIX-L-057 recover snapshots the account before and after, forwards the limit and merges replayed outbox ids', async () => {
  const calls: string[] = [];
  const before = accountEvidence('before');
  const after = accountEvidence('after');
  let captures = 0;
  let recoveryInput: { recipientAccountId: string; limit: number } | undefined;
  const operations: NotificationOperationsRepository = {
    async inspectStatus() { throw new Error('unused'); },
    async captureAccount(recipientAccountId: string) {
      calls.push(`capture:${recipientAccountId}`);
      captures += 1;
      return captures === 1 ? before : after;
    },
    async replayDeadLetters() { throw new Error('unused'); },
    async recoverMissingSources(input: { recipientAccountId: string; limit: number }) {
      recoveryInput = input;
      calls.push('recover');
      return { outboxIds: ['recovered-outbox-1'] };
    },
  };
  const evidence = await recoverNotificationAccountForOperations({ operations,
    recipientAccountId: 'ops-recover', limit: 7 });
  assert.deepEqual(calls, ['capture:ops-recover', 'recover', 'capture:ops-recover'],
    'recover must capture the account, requeue missing sources with the forwarded limit, then capture again');
  assert.deepEqual(recoveryInput, { recipientAccountId: 'ops-recover', limit: 7 },
    'the recovery limit must be forwarded verbatim');
  assert.deepEqual(evidence.beforePreferences, before.preferences);
  assert.deepEqual(evidence.beforeNotifications, before.notifications);
  assert.deepEqual(evidence.beforeDeliveries, before.deliveries);
  assert.deepEqual(evidence.afterPreferences, after.preferences);
  assert.deepEqual(evidence.afterNotifications, after.notifications);
  assert.deepEqual(evidence.afterDeliveries, after.deliveries);
  assert.deepEqual(evidence.outboxIds, ['recovered-outbox-1'],
    'replayed outbox ids must be merged into the evidence');
});

test('FIX-L-057 recover propagates capture and replay failures without partial evidence', async () => {
  await assert.rejects(recoverNotificationAccountForOperations({ operations: {
    async inspectStatus() { throw new Error('unused'); },
    async captureAccount() { throw new Error('capture exploded'); },
    async replayDeadLetters() { throw new Error('unused'); },
    async recoverMissingSources() { return { outboxIds: [] }; },
  }, recipientAccountId: 'ops-a', limit: 1 }), /capture exploded/u);
  await assert.rejects(recoverNotificationAccountForOperations({ operations: {
    async inspectStatus() { throw new Error('unused'); },
    async captureAccount() { return accountEvidence('before'); },
    async replayDeadLetters() { throw new Error('unused'); },
    async recoverMissingSources() { throw new Error('recovery exploded'); },
  }, recipientAccountId: 'ops-a', limit: 1 }), /recovery exploded/u);
  let captures = 0;
  await assert.rejects(recoverNotificationAccountForOperations({ operations: {
    async inspectStatus() { throw new Error('unused'); },
    async captureAccount() {
      captures += 1;
      if (captures === 2) throw new Error('after capture exploded');
      return accountEvidence('before');
    },
    async replayDeadLetters() { throw new Error('unused'); },
    async recoverMissingSources() { return { outboxIds: ['recovered-outbox-1'] }; },
  }, recipientAccountId: 'ops-a', limit: 1 }), /after capture exploded/u);
});

test('FIX-L-063 ops dead-letter replay binds the production Feed withdrawal handler name', () => {
  // The account-scoped dead-letter replay resolves the withdrawal's affected
  // recipient from the closed payload; the handler name must stay the exact
  // production route constant so the two surfaces cannot silently drift.
  assert.equal(SOCIAL_FEED_WITHDRAWAL_HANDLER, SOCIAL_FEED_WITHDRAWAL_ROUTE_HANDLER);
  assert.equal(SOCIAL_FEED_WITHDRAWAL_HANDLER, 'social_feed_withdrawal');
});
