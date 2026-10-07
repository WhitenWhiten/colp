import type { EmailSuppressionOpsRepository } from './email-suppression-ops.js';
/**
 * P5-31 low-cardinality email delivery metrics catalog.
 *
 * Every metric is a fixed single-token name with NO labels: no account id,
 * recipient, event, delivery, payload, error text or secret can appear in a
 * metric name or label (gate doc D10). The catalog is the source of truth for
 * the ops runbook and the deployment probe's readiness-gauge check.
 *
 * Existing worker/operations metrics (frozen in P5-29/30):
 * - notifications.email_delivery.enabled (0/1 gauge, worker runtime)
 * - notifications.email_delivery.worker_running (0/1 gauge, worker runtime)
 * - notifications.optional_delivery.available (0/1 gauge, operations status)
 * - notifications.email_delivery.claims / poll_error / heartbeat /
 *   heartbeat_lost / heartbeat_error / {disposition} / error counters
 *
 * P5-31 additions:
 * - notifications.email_delivery.suppression_facts (gauge, row count)
 * - notifications.email_delivery.callback.accepted (counter, verified+202)
 * - notifications.email_delivery.callback.rejected (counter, 401/403)
 * - notifications.email_delivery.callback.rate_limited (counter, ingress 429)
 * - notifications.email_delivery.callback.rate_limit_failure (counter, limiter outage 503)
 * - notifications.email_delivery.probe.status (0/1 gauge, deployment probe)
 */
export interface EmailDeliveryMetrics {
  gauge(name: string, value: number): void;
  increment(name: string, value?: number): void;
}

export const EMAIL_DELIVERY_METRIC_CARDINALITY = 'low' as const;

export const EMAIL_DELIVERY_GAUGE_METRIC_NAMES: readonly string[] = Object.freeze([
  'notifications.email_delivery.enabled',
  'notifications.email_delivery.worker_running',
  'notifications.email_delivery.suppression_facts',
  'notifications.email_delivery.probe.status',
  'notifications.optional_delivery.available',
]);

/** Complete frozen catalog including increment-only counters. */
export const EMAIL_DELIVERY_METRIC_NAMES: readonly string[] = Object.freeze([
  ...EMAIL_DELIVERY_GAUGE_METRIC_NAMES,
  'notifications.email_delivery.callback.accepted',
  'notifications.email_delivery.callback.rejected',
  'notifications.email_delivery.callback.rate_limited',
  'notifications.email_delivery.callback.rate_limit_failure',
  'notifications.email_delivery.suppression_cleared',
]);

export interface EmailDeliveryMetricsFacts {
  readonly enabled: boolean;
  readonly workerRunning: boolean;
  readonly suppressionFacts: number;
  readonly probeStatus: 0 | 1;
  /** 1 when the delivery queue has no dead-letter backlog (existing ops semantic). */
  readonly optionalDeliveryAvailable: boolean;
}

export function publishEmailDeliveryMetrics(
  facts: EmailDeliveryMetricsFacts,
  metrics: EmailDeliveryMetrics,
): void {
  metrics.gauge('notifications.email_delivery.enabled', facts.enabled ? 1 : 0);
  metrics.gauge('notifications.email_delivery.worker_running', facts.workerRunning ? 1 : 0);
  metrics.gauge('notifications.email_delivery.suppression_facts', facts.suppressionFacts);
  metrics.gauge('notifications.email_delivery.probe.status', facts.probeStatus);
  metrics.gauge('notifications.optional_delivery.available',
    facts.optionalDeliveryAvailable ? 1 : 0);
}

export function assertEmailDeliveryMetricNames(names: readonly string[]): void {
  const required = new Set(EMAIL_DELIVERY_METRIC_NAMES);
  for (const name of names) {
    if (!required.has(name)) {
      throw new Error(`unknown email delivery metric name: ${name}`);
    }
  }
}

/** Publish only a complete sample. Failure propagates to the inspection gate;
 * the last successful gauges remain intact instead of representing unknown as zero. */
export async function inspectEmailDeliveryMetrics(
  repository: Pick<EmailSuppressionOpsRepository, 'countSuppressionFacts'> | undefined,
  facts: Omit<EmailDeliveryMetricsFacts, 'suppressionFacts'>,
  metrics: EmailDeliveryMetrics,
): Promise<void> {
  const suppressionFacts = repository === undefined ? 0 : await repository.countSuppressionFacts();
  publishEmailDeliveryMetrics({ ...facts, suppressionFacts }, metrics);
}
