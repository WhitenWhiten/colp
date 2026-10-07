import assert from 'node:assert/strict';
import { test } from 'vitest';
import { occurrences } from '../../../src/modules/reports/application/schedule.js';

test.each([
  ['Asia/Tokyo', '2026-01-01T00:00:00Z', '20260102T000000Z'],
  ['America/Los_Angeles', '2026-01-01T17:00:00Z', '20260102T160000Z'],
  ['UTC', '2026-01-01T09:00:00Z', '20260102T090000Z'],
  ['Asia/Kathmandu', '2026-01-01T03:15:00Z', '20260102T031500Z'],
  ['Australia/Adelaide', '2026-01-01T22:30:00Z', '20260102T223000Z'],
  ['America/New_York', '2026-10-31T05:30:00Z', '20261101T060000Z'],
  ['America/New_York', '2026-03-07T07:30:00Z', '20260308T073000Z'],
])('absolute UNTIL matches bounded infinite rule: %s', (timeZone, dtstart, cutoff) => {
  const end = new Date(cutoff.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
  const until = new Date(end.getTime() + 3 * 86400000);
  for (const count of ['', ';COUNT=4']) {
    for (const from of [new Date(dtstart), new Date(end.getTime() - 3600000)]) {
      const schedule = { timeZone, dtstart, rrule: `FREQ=DAILY${count}` };
      const expected = occurrences(schedule, from, until).filter(date => date <= end);
      const actual = occurrences({ ...schedule, rrule: `${schedule.rrule};UNTIL=${cutoff}` }, from, until);
      assert.deepEqual(actual, expected);
      for (const offset of [-1, 0, 1]) {
        const windowEnd = new Date(end.getTime() + offset);
        assert.deepEqual(occurrences({ ...schedule, rrule: `${schedule.rrule};UNTIL=${cutoff}` }, from, windowEnd), expected.filter(date => date <= windowEnd));
      }
    }
  }
});
