// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { renderCaptureCharts } from '../src/capture/charts.js';
import { emptyCaptureCounters } from '../src/capture/statistics.js';
import type { CaptureStatistics } from '../src/capture/statistics.js';

function statistics(saveFailures: Record<string, number>, classificationDeferrals: Record<string, number>): CaptureStatistics {
  return {
    definitionVersion: 'capture-metrics.v1', timezone: 'UTC', updatedAt: 0, from: 0, to: 1,
    counts: emptyCaptureCounters(), days: [],
    latency: { save: { samples: 0, p50: null, p95: null }, classification: { samples: 0, p50: null, p95: null } },
    saveFailures, classificationDeferrals,
  };
}

test('reason chips render curated labels, never raw codes', () => {
  const host = document.createElement('div');
  renderCaptureCharts(host, statistics(
    { sign_in_required: 2, some_future_code: 1 },
    { permission_required: 3 },
  ), () => {});
  const text = host.textContent ?? '';
  expect(text).toContain('Sign-in needed: 2');
  expect(text).toContain('Bookmark permission needed: 3');
  expect(text).toContain('Other: 1');
  expect(text).not.toContain('sign_in_required');
  expect(text).not.toContain('some_future_code');
});

test('empty reason buckets render the none-in-period line', () => {
  const host = document.createElement('div');
  renderCaptureCharts(host, statistics({}, {}), () => {});
  expect(host.textContent ?? '').toContain('None in this period.');
});
