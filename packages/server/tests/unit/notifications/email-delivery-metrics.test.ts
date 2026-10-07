import { runWorkerInspectionTick } from '../../../src/bootstrap/worker-inspection-tick.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  EMAIL_DELIVERY_METRIC_NAMES,
  EMAIL_DELIVERY_METRIC_CARDINALITY,
  EMAIL_DELIVERY_GAUGE_METRIC_NAMES,
  publishEmailDeliveryMetrics,
  inspectEmailDeliveryMetrics,
  type EmailDeliveryMetricsFacts,
} from '../../../src/modules/notifications/index.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

class RecordingMetrics {
  readonly gauges = new Map<string, number>();
  readonly increments = new Map<string, number>();
  gauge(name: string, value: number): void { this.gauges.set(name, value); }
  increment(name: string, value = 1): void {
    this.increments.set(name, (this.increments.get(name) ?? 0) + value);
  }
  observe(): void { /* not used */ }
  get(name: string): number { return this.gauges.get(name) ?? 0; }
  observations(): number[] { return []; }
}

const facts: EmailDeliveryMetricsFacts = {
  enabled: true,
  workerRunning: true,
  suppressionFacts: 3,
  probeStatus: 1,
  optionalDeliveryAvailable: true,
};

test('P5-31 email delivery metric catalog is frozen, low-cardinality and PII-free', () => {
  assert.equal(EMAIL_DELIVERY_METRIC_CARDINALITY, 'low');
  assert.ok(Array.isArray(EMAIL_DELIVERY_METRIC_NAMES) && EMAIL_DELIVERY_METRIC_NAMES.length >= 8);
  for (const name of EMAIL_DELIVERY_METRIC_NAMES) {
    assert.match(name, /^notifications\.(?:email_delivery|optional_delivery)\./u);
    assert.equal(name.includes('{'), false, `${name} must not carry label cardinality`);
    assert.doesNotMatch(name, /recipient|account|email_address|payload|marker/iu);
    assert.doesNotMatch(name, /\s/u, `${name} must be a single token`);
  }
  for (const name of ['notifications.email_delivery.enabled', 'notifications.email_delivery.worker_running',
    'notifications.email_delivery.suppression_facts', 'notifications.email_delivery.probe.status',
    'notifications.optional_delivery.available']) {
    assert.ok(EMAIL_DELIVERY_GAUGE_METRIC_NAMES.includes(name), `${name} must be a gauge`);
  }
  for (const name of ['notifications.email_delivery.callback.accepted',
    'notifications.email_delivery.callback.rejected']) {
    assert.ok(EMAIL_DELIVERY_METRIC_NAMES.includes(name), `${name} must be in the catalog`);
    assert.equal(EMAIL_DELIVERY_GAUGE_METRIC_NAMES.includes(name), false, `${name} is increment-only`);
  }
});

test('P5-31 publishEmailDeliveryMetrics publishes exactly the gauge subset', () => {
  const metrics = new RecordingMetrics();
  publishEmailDeliveryMetrics(facts, metrics);
  for (const name of EMAIL_DELIVERY_GAUGE_METRIC_NAMES) {
    assert.equal(metrics.gauges.has(name), true, `${name} must be published`);
  }
  assert.equal(metrics.gauges.get('notifications.email_delivery.enabled'), 1);
  assert.equal(metrics.gauges.get('notifications.email_delivery.worker_running'), 1);
  assert.equal(metrics.gauges.get('notifications.email_delivery.suppression_facts'), 3);
  assert.equal(metrics.gauges.get('notifications.email_delivery.probe.status'), 1);
  assert.equal(metrics.gauges.get('notifications.optional_delivery.available'), 1);
  assert.equal(metrics.increments.size, 0);
});

test('P5-31 metrics names are documented in the ops runbook without account/recipient labels', () => {
  const runbook = readFileSync(resolve(backendRoot, 'docs/runbooks/email-delivery-operations.md'), 'utf8');
  for (const name of EMAIL_DELIVERY_METRIC_NAMES) {
    assert.match(runbook, new RegExp(name.replace(/\./gu, '\\.'), 'u'), name);
  }
  assert.match(runbook, /low.?cardinality|fixed names|no .*labels/iu);
});

test('P5-31 sanitized email config never exposes the ops token', () => {
  const config = readFileSync(resolve(backendRoot, 'src/bootstrap/config.ts'), 'utf8');
  const configTypes = readFileSync(resolve(backendRoot, 'src/bootstrap/config-types.ts'), 'utf8');
  const emailConfig = readFileSync(resolve(backendRoot, 'src/bootstrap/config-email.ts'), 'utf8');
  assert.match(config + configTypes, /opsToken/u);
  assert.match(emailConfig, /EMAIL_OPS_TOKEN/u);
  const sanitizedStart = emailConfig.indexOf('export function sanitizeEmailFeatureConfig');
  const sanitizedEnd = emailConfig.indexOf('export function loadAuthEmailFeatureConfig');
  assert.ok(sanitizedStart >= 0 && sanitizedEnd > sanitizedStart, 'sanitizeEmailFeatureConfig must be present');
  const sanitizedSource = emailConfig.slice(sanitizedStart, sanitizedEnd);
  assert.doesNotMatch(sanitizedSource, /opsToken/u);
});

test('inspection count failure is observable, preserves last gauge and cannot overlap', async () => {
  const metrics = new RecordingMetrics();
  publishEmailDeliveryMetrics(facts, metrics);
  const gate = { running: false };
  let calls = 0;
  let reject!: (error: Error) => void;
  const pending = new Promise<number>((_, fail) => { reject = fail; });
  const errors: unknown[] = [];
  const options = {
    enabled: true, gate,
    inspect: () => inspectEmailDeliveryMetrics({ countSuppressionFacts: () => { calls++; return pending; } }, facts, metrics),
    onError(error: unknown) { errors.push(error); metrics.increment('notifications.operations_inspect_error'); },
  };
  const first = runWorkerInspectionTick(options);
  await runWorkerInspectionTick(options);
  assert.equal(calls, 1);
  const error = new Error('count query unavailable');
  reject(error);
  await first;
  assert.deepEqual(errors, [error]);
  assert.equal(metrics.increments.get('notifications.operations_inspect_error'), 1);
  assert.equal(metrics.get('notifications.email_delivery.suppression_facts'), 3);
  assert.equal(gate.running, false);
  await inspectEmailDeliveryMetrics({ countSuppressionFacts: async () => 10000 }, facts, metrics);
  assert.equal(metrics.get('notifications.email_delivery.suppression_facts'), 10000);
});
