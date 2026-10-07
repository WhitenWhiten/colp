import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_HOT_HALF_LIFE_HOURS,
  COMMUNITY_HOT_SCORE_VERSION,
  computeCommunityHotScore,
} from '../../../src/modules/community/community-hot-score.js';

const NOW = new Date('2026-10-02T00:00:00.000Z');
const HOUR_MS = 3_600_000;

/** Reference implementation of the frozen formula for cross-checking. */
function reference(up: number, down: number, ageHours: number): number {
  const n = up + down;
  const p = (up + 1) / (n + 2);
  const confidence = 1 - 1 / Math.sqrt(n + 1);
  const signed = (2 * p - 1) * confidence;
  return signed * Math.log1p(n + 1) * Math.exp(-Math.LN2 / 168 * ageHours);
}

test('hot-v1 version and half-life constants are frozen', () => {
  assert.equal(COMMUNITY_HOT_SCORE_VERSION, 'hot-v1');
  assert.equal(COMMUNITY_HOT_HALF_LIFE_HOURS, 168);
});

test('a zero-vote target scores exactly 0 with a null firstVoteAt', () => {
  assert.equal(computeCommunityHotScore({ up: 0, down: 0, firstVoteAt: null, now: NOW }), 0);
  // Even a recorded instant cannot move a zero-vote score off 0.
  assert.equal(computeCommunityHotScore({
    up: 0, down: 0, firstVoteAt: new Date(NOW.getTime() - 10 * HOUR_MS), now: NOW,
  }), 0);
  // No negative-zero leaks into the projection.
  assert.equal(Object.is(computeCommunityHotScore(
    { up: 0, down: 0, firstVoteAt: null, now: NOW }), -0), false);
});

test('votes with a null firstVoteAt use defensive zero age, never creation time', () => {
  const score = computeCommunityHotScore({ up: 3, down: 1, firstVoteAt: null, now: NOW });
  assert.equal(score, reference(3, 1, 0));
});

test('the frozen formula matches the reference at zero age', () => {
  for (const [up, down] of [[1, 0], [4, 1], [10, 10], [0, 5], [25, 3]] as const) {
    const firstVoteAt = new Date(NOW.getTime());
    assert.equal(
      computeCommunityHotScore({ up, down, firstVoteAt, now: NOW }),
      reference(up, down, 0),
      `up=${up} down=${down}`,
    );
  }
});

test('up-heavy scores are positive and down-heavy scores are negative', () => {
  const firstVoteAt = new Date(NOW.getTime() - HOUR_MS);
  const hot = computeCommunityHotScore({ up: 9, down: 1, firstVoteAt, now: NOW });
  assert.ok(hot > 0, `expected positive, got ${hot}`);
  const cold = computeCommunityHotScore({ up: 1, down: 9, firstVoteAt, now: NOW });
  assert.ok(cold < 0, `expected negative, got ${cold}`);
});

test('the score mass halves every 168 hours of first-vote age', () => {
  const firstVoteAt = new Date(NOW.getTime() - 24 * HOUR_MS);
  const young = computeCommunityHotScore({ up: 8, down: 2, firstVoteAt, now: NOW });
  const aged = computeCommunityHotScore({
    up: 8, down: 2,
    firstVoteAt: new Date(firstVoteAt.getTime() - COMMUNITY_HOT_HALF_LIFE_HOURS * HOUR_MS),
    now: NOW,
  });
  assert.ok(Math.abs(aged / young - 0.5) < 1e-12, `ratio ${aged / young}`);
});

test('a future firstVoteAt clamps age to zero rather than going negative', () => {
  const future = new Date(NOW.getTime() + 48 * HOUR_MS);
  assert.equal(
    computeCommunityHotScore({ up: 5, down: 1, firstVoteAt: future, now: NOW }),
    reference(5, 1, 0),
  );
});

test('counts must be non-negative safe integers and dates finite', () => {
  const firstVoteAt = new Date(NOW.getTime() - HOUR_MS);
  for (const bad of [
    { up: -1, down: 0, firstVoteAt, now: NOW },
    { up: 0, down: -2, firstVoteAt, now: NOW },
    { up: 1.5, down: 0, firstVoteAt, now: NOW },
    { up: Number.MAX_SAFE_INTEGER + 1, down: 0, firstVoteAt, now: NOW },
  ]) {
    assert.throws(() => computeCommunityHotScore(bad), RangeError, JSON.stringify(bad));
  }
  // A non-Date, non-finite firstVoteAt rejects; only `null` is the legal
  // "no accepted vote" marker.
  for (const badDate of [new Date(Number.NaN), 'not-a-date', 42] as const) {
    assert.throws(() => computeCommunityHotScore(
      { up: 1, down: 0, firstVoteAt: badDate as Date, now: NOW }));
  }
  for (const badNow of [new Date(Number.NaN), 'not-a-date', null] as const) {
    assert.throws(() => computeCommunityHotScore(
      { up: 1, down: 0, firstVoteAt, now: badNow as Date }));
  }
});
