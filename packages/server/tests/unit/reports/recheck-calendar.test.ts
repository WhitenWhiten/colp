import assert from 'node:assert/strict';
import { test } from 'vitest';
import { occurrences } from '../../../src/modules/reports/application/schedule.js';

test.each([
  { rrule: 'FREQ=MONTHLY', dtstart: '2026-01-31T09:00:00Z', from: '2026-03-01T00:00:00Z', until: '2026-12-31T23:59:59Z' },
  { rrule: 'FREQ=MONTHLY;INTERVAL=3', dtstart: '2026-01-31T09:00:00Z', from: '2026-06-01T00:00:00Z', until: '2028-12-31T23:59:59Z' },
  { rrule: 'FREQ=YEARLY', dtstart: '2024-02-29T09:00:00Z', from: '2027-01-01T00:00:00Z', until: '2032-12-31T23:59:59Z' },
  { rrule: 'FREQ=YEARLY;INTERVAL=2', dtstart: '2024-02-29T09:00:00Z', from: '2027-01-01T00:00:00Z', until: '2032-12-31T23:59:59Z' },
])('RECHECK: calendar query windows preserve overlap for $rrule', input => {
  const schedule = { ...input, timeZone: 'UTC' };
  const from = new Date(input.from), until = new Date(input.until);
  const full = occurrences(schedule, new Date(input.dtstart), until, 100).filter(date => date >= from);
  const bounded = occurrences(schedule, from, until, 100);
  assert.deepEqual(bounded.map(date => date.toISOString()), full.map(date => date.toISOString()));
  assert.ok(bounded.length > 0);
  assert.ok(bounded.every(date => date.getUTCDate() === new Date(input.dtstart).getUTCDate()));
});
