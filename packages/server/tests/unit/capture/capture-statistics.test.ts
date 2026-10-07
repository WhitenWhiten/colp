import { expect, test } from 'vitest';
import { aggregateCaptures, type CaptureStatisticFact } from '../../../src/modules/collections/application/capture-statistics.js';
const createdAt = Date.parse('2026-09-19T16:30:00Z');
function cohort(): CaptureStatisticFact[] {
  return Array.from({ length: 100 }, (_, index) => ({ captureId: String(index), revision: 1, createdAt,
    disposition: 'new', save: index < 94 ? 'local-saved' : index < 96 ? 'failed' : 'unknown',
    automaticIntent: index < 90, originalApplied: index < 80,
    feedback: index < 18 ? 'explicit_positive' : index < 24 ? 'explicit_negative' : index < 64 ? 'implicit_positive' : null,
    sync: index < 94 ? 'confirmed' : 'local-only', needsAttention: index >= 94,
  }));
}
const query = { from: createdAt - 1000, to: createdAt + 1000, timezone: 'Asia/Tokyo', now: createdAt + 2000 };
test('the frozen 100-task cohort reproduces 94/100, 80/90, 18/24 and 24/80', () => {
  const result = aggregateCaptures(cohort(), query);
  expect(result.counts).toMatchObject({ total: 100, saved: 94, failed: 2, unknown: 4, automaticEligible: 90,
    automaticApplied: 80, positive: 18, negative: 6, implicit: 40, unrated: 16 });
  expect(result.counts.positive / (result.counts.positive + result.counts.negative)).toBe(0.75);
  expect(result.days[0]?.date).toBe('2026-09-20');
  expect(aggregateCaptures(cohort(), { ...query, timezone: 'UTC' }).days[0]?.date).toBe('2026-09-19');
});
test('late receipts and withdrawn feedback revise the original cohort and cross-device copies count once', () => {
  const facts = cohort();
  const result = aggregateCaptures([...facts, ...facts, { ...facts[99]!, revision: 2, save: 'local-saved' },
    { ...facts[0]!, revision: 2, feedback: 'withdrawn' }], query);
  expect(result.counts).toMatchObject({ total: 100, saved: 95, unknown: 3, positive: 17, unrated: 17 });
  expect(result.days).toHaveLength(1);
});
test('zero denominators and unknown timings stay empty; previews/existing/cancelled never enter new saves', () => {
  expect(aggregateCaptures([], query)).toMatchObject({ counts: { total: 0, automaticEligible: 0 }, latency: { save: { samples: 0, p50: null, p95: null } } });
  expect(aggregateCaptures([{ ...cohort()[0]!, disposition: 'existing' }, { ...cohort()[1]!, disposition: 'cancelled' }], query).counts).toMatchObject({ total: 0, existing: 1, cancelled: 1 });
});
