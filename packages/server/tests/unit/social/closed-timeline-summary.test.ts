import assert from 'node:assert/strict';
import { test } from 'vitest';
import { closedTimelineSummary as notificationSummary } from '../../../src/modules/notifications/application/closed-timeline-summary.js';
import { closedTimelineSummary as socialSummary } from '../../../src/modules/social/application/closed-timeline-summary.js';

const TABLE = [
  ['follow_activity', true, 'new_follower'],
  ['follow_activity', false, 'new_follower'],
  ['collection_change', true, 'public_collection_updated'],
  ['collection_change', false, null],
] as const;

test('social and notifications closedTimelineSummary copies agree on the token table', () => {
  for (const [kind, locatorsVisible, expected] of TABLE) {
    assert.equal(socialSummary(kind, locatorsVisible), expected, `social ${kind}/${locatorsVisible}`);
    assert.equal(notificationSummary(kind, locatorsVisible), expected,
      `notifications ${kind}/${locatorsVisible}`);
    assert.equal(socialSummary(kind, locatorsVisible), notificationSummary(kind, locatorsVisible));
  }
});
