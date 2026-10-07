/**
 * FIX-L-046 delivery limiter composite-key parsing regression.
 *
 * The limiter previously encoded the fixed-window start into the Map key as
 * `${principalId}:${windowStartMs}` and prune re-parsed the key with
 * `split(':')[1]`. Any principal id containing a colon broke the parse:
 * - a non-numeric second segment produced NaN, so expired buckets were never
 *   pruned (stale state consumed tracking capacity);
 * - a small numeric second segment (e.g. `node:7`) produced a value below the
 *   prune threshold, so the CURRENT (still valid) bucket was deleted on the
 *   next prune pass, silently resetting the principal's budget.
 *
 * This suite pins the fixed behaviour: the window start lives in the Map
 * value, prune never parses the principal string, numeric account ids keep
 * their exact previous semantics, and capacity eviction still only forgives
 * the oldest inserted bucket when the map is genuinely full.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDeliveryRateLimiter } from '../../../src/modules/attachments/index.js';

const BASE_TIME = new Date('2026-08-08T12:00:00.000Z');
const WINDOW_MS = 60_000;

test('numeric account ids (no colon) keep budget, retry-after, rollover and pruning', () => {
  const limiter = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 2, maxTrackedPrincipals: 16 });
  let nowMs = BASE_TIME.getTime();
  const check = (principalId: string) => limiter.check(principalId, new Date(nowMs));

  assert.equal(check('1001').allowed, true);
  const first = check('1001');
  assert.equal(first.allowed, true);
  assert.equal(first.windowStartEpochMs, Math.floor(BASE_TIME.getTime() / WINDOW_MS) * WINDOW_MS,
    'the deterministic window start is reported');
  const third = check('1001');
  assert.equal(third.allowed, false, 'budget is exhausted inside the window');
  assert.ok(third.retryAfterSeconds > 0, 'denied attempts carry a retry-after');
  assert.equal(check('2002').allowed, true, 'a different account is independent');

  nowMs += WINDOW_MS + 1_000;
  assert.equal(check('1001').allowed, true, 'a fresh window resets the budget');

  // Two more windows: the W0 buckets of both principals and the W1 bucket
  // are expired and pruned; only the new W3 bucket remains.
  nowMs += 2 * WINDOW_MS;
  check('1001');
  assert.equal(limiter.trackedCount(), 1, 'expired windows are pruned for numeric account ids too');
});

test('a principal id with one colon keeps its budget and expired buckets are pruned', () => {
  const limiter = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 2, maxTrackedPrincipals: 16 });
  const principal = 'alice:zone';
  const t0 = BASE_TIME.getTime();

  assert.equal(limiter.check(principal, new Date(t0)).allowed, true);
  assert.equal(limiter.check(principal, new Date(t0)).allowed, true);
  assert.equal(limiter.check(principal, new Date(t0)).allowed, false, 'budget enforced for a colon principal');

  // Window W1: the previous-window bucket stays (boundary behaviour).
  assert.equal(limiter.check(principal, new Date(t0 + WINDOW_MS + 1_000)).allowed, true);
  assert.equal(limiter.trackedCount(), 2);

  // Window W2: the W0 bucket is now expired and must be pruned. The old code
  // parsed `split(':')[1]` = 'zone' → NaN, so it was never removed.
  assert.equal(limiter.check(principal, new Date(t0 + 2 * WINDOW_MS + 1_000)).allowed, true);
  assert.equal(limiter.trackedCount(), 2, 'the W0 bucket was pruned; W1 + W2 remain');

  // Window W3: the W1 bucket is pruned in turn.
  assert.equal(limiter.check(principal, new Date(t0 + 3 * WINDOW_MS + 1_000)).allowed, true);
  assert.equal(limiter.trackedCount(), 2, 'the W1 bucket was pruned; W2 + W3 remain');
});

test('a principal id with multiple colons keeps its budget and expired buckets are pruned', () => {
  const limiter = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 3, maxTrackedPrincipals: 16 });
  const principal = 'urn:known:account:alice';
  const t0 = BASE_TIME.getTime();

  assert.equal(limiter.check(principal, new Date(t0)).allowed, true);
  assert.equal(limiter.check(principal, new Date(t0)).allowed, true);
  assert.equal(limiter.check(principal, new Date(t0)).allowed, true);
  assert.equal(limiter.check(principal, new Date(t0)).allowed, false, 'budget enforced for a multiple-colon principal');

  // Window W2: the W0 bucket is expired and must be pruned (old code: NaN).
  assert.equal(limiter.check(principal, new Date(t0 + 2 * WINDOW_MS + 1_000)).allowed, true);
  assert.equal(limiter.trackedCount(), 1, 'the W0 bucket was pruned; only W2 remains');

  // Window W3: W2 stays (boundary), so two buckets are tracked.
  assert.equal(limiter.check(principal, new Date(t0 + 3 * WINDOW_MS + 1_000)).allowed, true);
  assert.equal(limiter.trackedCount(), 2, 'W2 + W3 are tracked');
});

test('a colon principal whose second segment is a small number is not forgiven early', () => {
  const limiter = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 2, maxTrackedPrincipals: 16 });
  const t0 = BASE_TIME.getTime();

  assert.equal(limiter.check('node:7', new Date(t0)).allowed, true);
  assert.equal(limiter.check('node:7', new Date(t0)).allowed, true);
  // A different principal inserts a new bucket, which triggers a prune pass.
  assert.equal(limiter.check('other', new Date(t0)).allowed, true);
  // The `node:7` bucket belongs to the CURRENT window: it must survive prune.
  // (Old code parsed `split(':')[1]` = 7 < prune threshold → bucket deleted →
  // budget silently reset → the third admission below was wrongly allowed.)
  assert.equal(limiter.check('node:7', new Date(t0)).allowed, false, 'the current-window bucket must not be pruned');
  assert.equal(limiter.check('node:7', new Date(t0)).allowed, false);
});

test('capacity eviction stays bounded and does not forgive a still-valid bucket', () => {
  const limiter = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 1, maxTrackedPrincipals: 2 });
  const t0 = BASE_TIME.getTime();

  assert.equal(limiter.check('p-a', new Date(t0)).allowed, true);
  assert.equal(limiter.check('p-b', new Date(t0)).allowed, true);
  assert.equal(limiter.trackedCount(), 2);
  // Full: inserting a third principal evicts the OLDEST inserted bucket (p-a),
  // while p-b's still-valid bucket must keep its count.
  assert.equal(limiter.check('p-c', new Date(t0)).allowed, true);
  assert.equal(limiter.trackedCount(), 2, 'memory stays bounded at capacity');
  assert.equal(limiter.check('p-b', new Date(t0)).allowed, false, 'p-b was not evicted: its budget still applies');
  assert.equal(limiter.check('p-a', new Date(t0)).allowed, true, 'an evicted principal gets a fresh window');
});

test('expired buckets are pruned before capacity eviction (colon principals)', () => {
  const limiter = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 5, maxTrackedPrincipals: 3 });
  const t0 = BASE_TIME.getTime();
  const principals = ['urn:known:account:a', 'urn:known:account:b', 'urn:known:account:c', 'urn:known:account:d'];

  for (const principal of principals) {
    assert.equal(limiter.check(principal, new Date(t0)).allowed, true);
  }
  assert.equal(limiter.trackedCount(), 3, 'memory stays bounded for colon principals');

  // Two windows later all W0 buckets are expired: prune reclaims them BEFORE
  // capacity eviction, so no valid bucket is evicted. (Old code: NaN parse →
  // nothing pruned → a valid bucket was evicted for capacity instead.)
  assert.equal(limiter.check('urn:known:account:d', new Date(t0 + 2 * WINDOW_MS + 1_000)).allowed, true);
  assert.equal(limiter.trackedCount(), 1, 'prune removed all three expired W0 buckets');
});
