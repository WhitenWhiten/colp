/**
 * CS-02 community hot ranking: the frozen `hot-v1` score formula.
 *
 * Pure domain logic — no I/O, no clock of its own. `now` is injected so the
 * projection rebuild and any replay of the algorithm agree on the instant.
 *
 * Frozen formula (contract):
 *   n          = up + down
 *   p          = (up + 1) / (n + 2)
 *   confidence = 1 - 1 / sqrt(n + 1)
 *   signed     = (2 * p - 1) * confidence
 *   ageHours   = max(0, (now - firstVoteAt) / 1h)
 *   hot        = signed * log1p(n + 1) * exp(-ln(2) * ageHours / 168)
 *
 * Rules: a zero-vote target scores exactly 0; a target with no accepted vote
 * has firstVoteAt = null (no creation-time fallback); a future firstVoteAt
 * clamps age to 0; counts must be non-negative safe integers.
 */
export const COMMUNITY_HOT_SCORE_VERSION = 'hot-v1' as const;

/** Half-life in hours: score mass halves every 168 hours (one week). */
export const COMMUNITY_HOT_HALF_LIFE_HOURS = 168 as const;

const HOUR_MS = 3_600_000;
const HALF_LIFE_DECAY_PER_HOUR = Math.LN2 / COMMUNITY_HOT_HALF_LIFE_HOURS;

export interface CommunityHotScoreInput {
  readonly up: number;
  readonly down: number;
  /** UTC instant of the first accepted vote; null when the target has none. */
  readonly firstVoteAt: Date | null;
  /** Injected clock instant (normalized UTC). */
  readonly now: Date;
}

function assertCount(value: number, name: 'up' | 'down'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`hot-v1 ${name} count must be a non-negative safe integer`);
  }
  return value;
}

function assertInstantMs(value: Date, name: string): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`hot-v1 ${name} must be a finite Date`);
  }
  return value.getTime();
}

/**
 * Compute the durable hot score. Returns a finite number; the caller persists
 * it verbatim beside the algorithm version so later versions can coexist.
 */
export function computeCommunityHotScore(input: CommunityHotScoreInput): number {
  const up = assertCount(input.up, 'up');
  const down = assertCount(input.down, 'down');
  const nowMs = assertInstantMs(input.now, 'now');
  const n = up + down;
  if (n === 0) return 0;
  if (input.firstVoteAt === null) {
    // n > 0 with no recorded first vote is a data invariant breach; a zero
    // age (first vote cast right now) is the defensive normalization rather
    // than an invented creation-time fallback.
    return firstVoteAdjusted(up, n, 0);
  }
  const ageHours = Math.max(0, (nowMs - assertInstantMs(input.firstVoteAt, 'firstVoteAt')) / HOUR_MS);
  return firstVoteAdjusted(up, n, ageHours);
}

function firstVoteAdjusted(up: number, n: number, ageHours: number): number {
  const p = (up + 1) / (n + 2);
  const confidence = 1 - 1 / Math.sqrt(n + 1);
  const signed = (2 * p - 1) * confidence;
  const hot = signed * Math.log1p(n + 1) * Math.exp(-HALF_LIFE_DECAY_PER_HOUR * ageHours);
  // Floating-point dust can produce -0; the stored value is exact 0.
  return hot === 0 ? 0 : hot;
}
