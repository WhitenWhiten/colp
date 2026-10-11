import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  addUtcDays,
  publishingInsightsWindowBounds,
  utcDayString,
  PUBLISHING_INSIGHTS_WINDOW_DAYS,
} from '../../../src/modules/publication/index.js';

const PINNED_NOW = new Date('2026-08-19T08:00:00.000Z');

describe('publishingInsightsWindowBounds', () => {
  test('pins 30 UTC days including today and 4×7 weekly buckets for 2026-08-19T08:00Z', () => {
    const bounds = publishingInsightsWindowBounds(PINNED_NOW);
    const today = utcDayString(PINNED_NOW);
    assert.equal(today, '2026-08-19');
    assert.equal(bounds.fromDayInclusive, '2026-07-21');
    assert.equal(bounds.toDayExclusive, '2026-08-20');
    assert.deepEqual(bounds.weeklyStarts, ['2026-07-23', '2026-07-30', '2026-08-06', '2026-08-13']);
    assert.equal(addUtcDays(today, 1 - 30), '2026-07-21');
    assert.equal(addUtcDays(today, -27), '2026-07-23');
    assert.equal(PUBLISHING_INSIGHTS_WINDOW_DAYS, 30);
  });
});
