/**
 * P4A-RL03 fixed Lua script contract (plan §2.3 + §4.3 mutations).
 *
 * The window script is a FROZEN, VERSIONED constant (`RATE_LIMIT_LUA_SCRIPT` +
 * `RATE_LIMIT_LUA_SCRIPT_VERSION`): the application can never assemble script
 * text from user input (parameters flow only through KEYS/ARGV), the window
 * identity comes from Redis server time (`redis.call('time')`), the counter is
 * a single atomic INCR, and PEXPIRE runs only on the FIRST write of a window
 * (count == 1) so high-frequency hits never extend the fixed window. The
 * mutation controls "Redis Lua 改为应用 GET/SET" and "Redis 每次 INCR 都刷新
 * TTL" (plan §4.3) are pinned here structurally AND behaviorally by the real
 * Redis suite (phase4a-rl03-redis.integration.test.ts).
 *
 * The reply parser pins the wire contract `{allowed, count, remaining,
 * retryAfterSeconds, windowStartEpochMs}` fail-closed: a malformed script
 * reply can never become a decision.
 *
 * No Redis, no PostgreSQL, no browser.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  RATE_LIMIT_LUA_SCRIPT,
  RATE_LIMIT_LUA_SCRIPT_NAME,
  RATE_LIMIT_LUA_SCRIPT_VERSION,
  parseRateLimitScriptReply,
} from '../../../src/infrastructure/rate-limit/index.js';

test('the script is a frozen, versioned constant with the fixed-window semantics', () => {
  assert.equal(RATE_LIMIT_LUA_SCRIPT_VERSION, 1);
  assert.equal(RATE_LIMIT_LUA_SCRIPT_NAME, 'rate_limit_fixed_window_v1');
  assert.equal(typeof RATE_LIMIT_LUA_SCRIPT, 'string');
  assert.ok(RATE_LIMIT_LUA_SCRIPT.length > 300, 'the script carries the full fixed-window semantics');

  // Frozen: no template interpolation path can ever inject app/user values
  // into the script text (plan §8 RL03: "不得动态拼接用户输入进脚本").
  assert.equal(RATE_LIMIT_LUA_SCRIPT.includes('${'), false, 'the script text must be a plain constant');

  // Atomic: server time + INCR + first-write-only PEXPIRE inside ONE script —
  // never application GET -> INCR -> EXPIRE (plan §4.3 mutation).
  assert.ok(RATE_LIMIT_LUA_SCRIPT.includes("redis.call('time')"), 'the script must read Redis server time');
  assert.ok(RATE_LIMIT_LUA_SCRIPT.includes("redis.call('incr'"), 'the script must INCR atomically');
  assert.ok(RATE_LIMIT_LUA_SCRIPT.includes("redis.call('pexpire'"), 'the script must set the window TTL');
  assert.ok(
    /if count == 1 then[\s\S]*redis\.call\('pexpire'/u.test(RATE_LIMIT_LUA_SCRIPT),
    'PEXPIRE must run only on the first write of a window (plan §4.3 TTL mutation)',
  );
  assert.equal(
    RATE_LIMIT_LUA_SCRIPT.includes("redis.call('get'"),
    false,
    'the script must never GET the counter (no GET -> INCR -> EXPIRE)',
  );
  assert.equal(
    RATE_LIMIT_LUA_SCRIPT.includes('redis.call(\'expire\''),
    false,
    'the script must use PEXPIRE (ms), never seconds-level EXPIRE',
  );

  // Server-time windowing: the host-time seed embedded in KEYS[1] is replaced
  // by the server-derived window so replicas cannot split windows (plan §2.3).
  assert.ok(RATE_LIMIT_LUA_SCRIPT.includes('windowStartMs'), 'the script derives the window from server time');
  // Malformed-key guard: a key that does not end in the canonical :<window>
  // segment fails closed with a stable error marker.
  assert.ok(RATE_LIMIT_LUA_SCRIPT.includes('RATE_LIMIT_KEY_MALFORMED'));
  // The reply shape is fixed (5 elements, in order).
  assert.ok(
    RATE_LIMIT_LUA_SCRIPT.includes('return {allowed, count, remaining, retryAfterSeconds, windowStartMs}'),
    'the script returns the fixed 5-element reply shape',
  );
});

// ---------------------------------------------------------------------------
// Reply parser: the fixed wire contract
// ---------------------------------------------------------------------------

test('a valid allowed reply parses into the fixed decision shape', () => {
  const parsed = parseRateLimitScriptReply([1, 5, 25, 30, 1_749_999_960_000], 30, 60_000);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.equal(parsed.reply.allowed, true);
  assert.equal(parsed.reply.count, 5);
  assert.equal(parsed.reply.remaining, 25);
  assert.equal(parsed.reply.retryAfterSeconds, 30);
  assert.equal(parsed.reply.windowStartEpochMs, 1_749_999_960_000);
});

test('a denied reply parses with remaining clamped at zero (quota fact, not a failure)', () => {
  const parsed = parseRateLimitScriptReply([0, 40, 0, 30, 0], 30, 60_000);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.equal(parsed.reply.allowed, false);
  assert.equal(parsed.reply.count, 40);
  assert.equal(parsed.reply.remaining, 0);
});

test('malformed script replies are rejected fail-closed and can never become a decision', () => {
  const rateMax = 30;
  const windowMs = 60_000;
  const malformed: unknown[] = [
    [1, 5, 25, 30], // wrong length (4)
    [1, 5, 25, 30, 0, 0], // wrong length (6)
    [1, 0, 30, 30, 0], // count must be >= 1
    [1, 5, 26, 30, 0], // remaining must equal max(0, rateMax - count)
    [1, 5, 24, 30, 0], // remaining mismatch (low side)
    [1, 5, 25, -1, 0], // negative retry-after
    [1, 5, 25, 30, -5], // negative window start
    [1, 5, 25, 30, 123], // window start not floor-aligned to the window
    [2, 5, 25, 30, 0], // allowed must be 0 or 1
    [-1, 5, 25, 30, 0], // allowed must be 0 or 1
    ['1', 5, 25, 30, 0], // strings are not the Lua number reply
    [true, 5, 25, 30, 0], // booleans are not the Lua number reply
    [1, 5.5, 25, 30, 0], // non-integer count
    [1, 5, 25, 30.5, 0], // non-integer retry-after
    [1, 5, 25, 30, 60_000.5], // non-integer window start
    [1, 5, 25, 30, Number.MAX_SAFE_INTEGER + 1], // unsafe integer window start
    null,
    undefined,
    '1,5,25,30,0',
    { 0: 1, 1: 5, 2: 25, 3: 30, 4: 0 },
  ];
  for (const reply of malformed) {
    const parsed = parseRateLimitScriptReply(reply, rateMax, windowMs);
    assert.equal(parsed.kind, 'malformed', `reply ${JSON.stringify(reply)} must be malformed`);
  }
});

test('the parser accepts only safe integers and keeps the remaining invariant', () => {
  // Boundary: count exactly at the ceiling.
  assert.equal(parseRateLimitScriptReply([1, 30, 0, 30, 60_000], 30, 60_000).kind, 'ok');
  // Boundary: a huge but safe window start stays aligned.
  const aligned = 1_749_999_960_000;
  assert.equal(parseRateLimitScriptReply([1, 1, 29, 60, aligned], 30, 60_000).kind, 'ok');
  // One millisecond off the aligned boundary is malformed.
  assert.equal(parseRateLimitScriptReply([1, 1, 29, 60, aligned + 1], 30, 60_000).kind, 'malformed');
});
