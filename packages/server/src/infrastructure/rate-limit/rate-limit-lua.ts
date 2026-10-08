/**
 * P4A-RL03 fixed Lua window script + reply parser (plan §2.3, §4.3, §8 RL03).
 *
 * The window script is a FROZEN, VERSIONED constant:
 *
 *  - the window identity comes from Redis SERVER time (`redis.call('time')`),
 *    never host time, so replicas with skewed host clocks share one quota;
 *    the host-time window seed embedded in KEYS[1] (the RL02 codec key) is
 *    replaced inside the script by the server-derived window, while the
 *    canonical prefix and the HMAC subject segment are preserved verbatim;
 *  - the counter is a single atomic INCR shared by every replica/client;
 *  - PEXPIRE runs only on the FIRST write of a window (count == 1), so
 *    high-frequency hits never extend the fixed window (plan §4.3 mutation);
 *  - the reply is the fixed shape
 *    `{allowed, count, remaining, retryAfterSeconds, windowStartEpochMs}`;
 *  - the script text is a plain constant: application/user input can only
 *    flow through KEYS/ARGV, never into the script text (plan §8 RL03: "不得
 *    动态拼接用户输入进脚本").
 *
 * The parser pins the wire contract fail-closed: a malformed script reply can
 * never become a decision.
 */
export const RATE_LIMIT_LUA_SCRIPT_VERSION = 1;
export const RATE_LIMIT_LUA_SCRIPT_NAME = 'rate_limit_fixed_window_v1';
export const RATE_LIMIT_LUA_SCRIPT = `-- P4A-RL03 fixed-window admission script (version 1)
-- KEYS[1]  canonical codec key carrying a host-time window SEED:
--          <prefix>:<env>:ratelimit:v1:{att:<subjectHmac>}:<routeClass>:<seedWindow>
-- ARGV[1]  rateMax  (allowed attempts per fixed window)
-- ARGV[2]  windowMs (fixed window length in milliseconds)
-- Semantics (plan 2.3 / 4.3):
--   * Redis server time (TIME) defines the window identity: the host-time
--     seed embedded in KEYS[1] is replaced by the server-derived window, so
--     replicas with skewed host clocks cannot split one quota;
--   * the canonical prefix and the HMAC subject segment are preserved;
--   * INCR is a single atomic step shared by every replica;
--   * PEXPIRE runs only on the FIRST write of a window (count == 1), so
--     frequent hits never extend the fixed window;
--   * the reply is the fixed shape
--     {allowed, count, remaining, retryAfterSeconds, windowStartMs}.
local serverTime = redis.call('time')
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local windowMs = tonumber(ARGV[2])
local windowStartMs = math.floor(nowMs / windowMs) * windowMs
local prefix = string.match(KEYS[1], '^(.*):%d+$')
if prefix == nil then
  return redis.error_reply('RATE_LIMIT_KEY_MALFORMED')
end
local counterKey = prefix .. ':' .. tostring(windowStartMs)
local count = redis.call('incr', counterKey)
if count == 1 then
  redis.call('pexpire', counterKey, windowMs)
end
local rateMax = tonumber(ARGV[1])
local allowed = 0
if count <= rateMax then
  allowed = 1
end
local remaining = rateMax - count
if remaining < 0 then
  remaining = 0
end
local retryAfterSeconds = 0
if nowMs < windowStartMs + windowMs then
  retryAfterSeconds = math.max(1, math.ceil((windowStartMs + windowMs - nowMs) / 1000))
end
return {allowed, count, remaining, retryAfterSeconds, windowStartMs}`;

/**
 * FIX-M-018 distinct-element fixed-window script (version 1) for the MCP
 * commit-distinct-plan policy. Same server-time windowing, first-write-only
 * PEXPIRE and reply shape as the counter script, but the budget counts
 * DISTINCT elements (SADD/SCARD) instead of raw hits:
 *
 *  - KEYS[1]  canonical MCP codec key carrying a host-time window SEED;
 *  - ARGV[1]  maxDistinct (allowed DISTINCT elements per fixed window);
 *  - ARGV[2]  windowMs;
 *  - ARGV[3]  element (the commit planId — a SET member, never key text);
 *  - an exact replay of a KNOWN element (SADD returns 0) is ALWAYS allowed
 *    and never consumes a new slot (MRTR retry / exact replay free rule);
 *  - a NEW element beyond the budget is denied and REMOVED again (SREM), so
 *    denied plans never occupy a slot — identical to the in-process port's
 *    distinct-plan semantics;
 *  - PEXPIRE runs only on the FIRST write of a window (the set did not
 *    exist before this call), so frequent hits never extend the window;
 *  - the reply is the same frozen 5-element shape as the counter script, so
 *    the fail-closed parser pins the identical wire contract.
 */
export const RATE_LIMIT_DISTINCT_LUA_SCRIPT_VERSION = 1;
export const RATE_LIMIT_DISTINCT_LUA_SCRIPT_NAME = 'rate_limit_distinct_window_v1';

export const RATE_LIMIT_DISTINCT_LUA_SCRIPT = `-- FIX-M-018 distinct-element fixed-window admission script (version 1)
-- KEYS[1]  canonical codec key carrying a host-time window SEED
-- ARGV[1]  maxDistinct (allowed DISTINCT elements per fixed window)
-- ARGV[2]  windowMs (fixed window length in milliseconds)
-- ARGV[3]  element    (the distinct element, e.g. a commit planId)
-- Semantics:
--   * Redis server time (TIME) defines the window identity, so replicas
--     with skewed host clocks cannot split one quota;
--   * SADD adds the element once; SCARD counts DISTINCT elements, so an
--     exact retry of a known element never consumes a new slot;
--   * PEXPIRE runs only on the FIRST write of a window (the set did not
--     exist before this call);
--   * a new element beyond the budget is denied and removed again, so
--     denied elements never occupy a slot (distinct-plan semantics);
--   * the reply is the frozen 5-element shape
--     {allowed, count, remaining, retryAfterSeconds, windowStartMs}.
local serverTime = redis.call('time')
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local windowMs = tonumber(ARGV[2])
local windowStartMs = math.floor(nowMs / windowMs) * windowMs
local prefix = string.match(KEYS[1], '^(.*):%d+$')
if prefix == nil then
  return redis.error_reply('RATE_LIMIT_KEY_MALFORMED')
end
local setKey = prefix .. ':' .. tostring(windowStartMs)
local created = redis.call('exists', setKey)
local added = redis.call('sadd', setKey, ARGV[3])
if created == 0 then
  redis.call('pexpire', setKey, windowMs)
end
local count = redis.call('scard', setKey)
local rateMax = tonumber(ARGV[1])
local allowed = 0
if added == 0 then
  allowed = 1
elseif count <= rateMax then
  allowed = 1
else
  redis.call('srem', setKey, ARGV[3])
  count = redis.call('scard', setKey)
end
local remaining = rateMax - count
if remaining < 0 then
  remaining = 0
end
local retryAfterSeconds = 0
if nowMs < windowStartMs + windowMs then
  retryAfterSeconds = math.max(1, math.ceil((windowStartMs + windowMs - nowMs) / 1000))
end
return {allowed, count, remaining, retryAfterSeconds, windowStartMs}`;

/** Parsed script reply (all values are validated safe integers). */
export interface RateLimitScriptReply {
  readonly allowed: boolean;
  readonly count: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly windowStartEpochMs: number;
}

export type RateLimitScriptParseResult =
  | { readonly kind: 'ok'; readonly reply: RateLimitScriptReply }
  | { readonly kind: 'malformed' };

/**
 * Fail-closed parser for the fixed 5-element reply:
 *
 *  - `allowed` must be exactly 0 or 1 (Lua numbers, not strings/booleans);
 *  - `count` must be a safe integer >= 1;
 *  - `remaining` must equal `max(0, rateMax - count)` — a reply that does not
 *    honor the budget invariant is protocol corruption;
 *  - `retryAfterSeconds` and `windowStartEpochMs` must be non-negative safe
 *    integers and the window start must be floor-aligned to `windowMs`
 *    (the same rounding `windowStartFor` pins in the RL02 policy module).
 */
export function parseRateLimitScriptReply(
  reply: unknown,
  rateMax: number,
  windowMs: number,
): RateLimitScriptParseResult {
  if (!Array.isArray(reply) || reply.length !== 5) return { kind: 'malformed' };
  const [allowedRaw, countRaw, remainingRaw, retryAfterRaw, windowStartRaw] = reply;
  if (allowedRaw !== 0 && allowedRaw !== 1) return { kind: 'malformed' };
  if (!Number.isSafeInteger(countRaw) || countRaw < 1) return { kind: 'malformed' };
  if (!Number.isSafeInteger(retryAfterRaw) || retryAfterRaw < 0) return { kind: 'malformed' };
  if (!Number.isSafeInteger(windowStartRaw) || windowStartRaw < 0) return { kind: 'malformed' };
  const expectedRemaining = Math.max(0, rateMax - countRaw);
  if (remainingRaw !== expectedRemaining) return { kind: 'malformed' };
  if (windowStartRaw % windowMs !== 0) return { kind: 'malformed' };
  return {
    kind: 'ok',
    reply: Object.freeze({
      allowed: allowedRaw === 1,
      count: countRaw,
      remaining: remainingRaw,
      retryAfterSeconds: retryAfterRaw,
      windowStartEpochMs: windowStartRaw,
    }),
  };
}
