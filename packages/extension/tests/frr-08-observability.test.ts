import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  KNS09_METRICS, KNS09_STOP_METRICS, kns09Paused, observeKns09EngineWake, observeKns09PushReceipt,
  recordKns09FirstRun, recordKns09Stop, resetKns09MetricsForTests, snapshotKns09Metrics,
} from '../src/kns-09-release.js';

const scope = {
  collectionId: 'collection-frr08', replicaId: 'replica-frr08',
};

test('FRR-08-A: one first-run confirm/status/resume records started once and completed once', () => {
  resetKns09MetricsForTests();
  recordKns09FirstRun('started', scope, 'conf-1');
  recordKns09FirstRun('started', scope, 'conf-1');
  recordKns09FirstRun('started', scope, 'conf-1');
  recordKns09FirstRun('completed', scope, 'conf-1');
  recordKns09FirstRun('completed', scope, 'conf-1');
  const snap = snapshotKns09Metrics();
  assert.equal(snap.counters[`${KNS09_METRICS.firstRun}.started`], 1);
  assert.equal(snap.counters[`${KNS09_METRICS.firstRun}.completed`], 1);
});

test('FRR-08-A: receipt latency and backlog without a proven start are unknown, not zero', () => {
  resetKns09MetricsForTests();
  observeKns09PushReceipt(scope, { retry: { attempt: 0, notBefore: 0 } });
  observeKns09EngineWake({
    scope, frozenBefore: false, frozenAfter: false, pendingCount: 1, backlogAgeMs: null,
  });
  const snap = snapshotKns09Metrics();
  assert.equal(snap.histograms[KNS09_METRICS.pushReceiptLatencyMs]?.unknown, 1);
  assert.equal(snap.histograms[KNS09_METRICS.queueBacklogAgeMs]?.unknown, 1);
  assert.ok((snap.histograms[KNS09_METRICS.pushReceiptLatencyMs]?.counts ?? []).every((count) => count === 0));
});

test('FRR-08-B: six stop reasons are visible, bounded, and out-of-scope upload pauses ingress', async () => {
  resetKns09MetricsForTests();
  for (const reason of Object.keys(KNS09_STOP_METRICS) as Array<keyof typeof KNS09_STOP_METRICS>) {
    recordKns09Stop(reason, scope);
  }
  const snap = snapshotKns09Metrics();
  for (const metric of Object.values(KNS09_STOP_METRICS)) {
    assert.equal(snap.counters[metric], 1);
  }
  assert.ok(snap.ringLength <= 32);
  assert.equal(await kns09Paused('ingress'), true);
  const text = JSON.stringify(snap);
  assert.doesNotMatch(text, /collection-frr08|replica-frr08/u);
});
