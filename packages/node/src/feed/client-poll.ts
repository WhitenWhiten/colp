import { isProxy } from 'node:util/types';

import { isRfc3339DateTime } from '../shared/date-time.js';

/**
 * Client-side Feed poll / backoff controller (FEED-0008).
 *
 * Pure boundary: hosts supply clock and random; this helper never performs HTTP.
 */

export interface FeedPollLimits {
  /** Manifest `minPollIntervalSeconds` — clients MUST not poll sooner. */
  readonly minPollIntervalSeconds: number;
  /** Optional server upper bound for backoff. */
  readonly serverMaxBackoffSeconds?: number;
  readonly baseBackoffSeconds?: number;
  readonly jitterSeconds?: number;
  /**
   * Longest wait any single response may impose, in seconds. It bounds
   * `Retry-After`, `recommendedAfterSeconds`, `notBefore` and a deadline kept
   * from an earlier response, so one extreme value (or a wall-clock step)
   * cannot stop polling indefinitely. Default: 86400. Must not be below
   * `minPollIntervalSeconds`.
   */
  readonly maxDeferralSeconds?: number;
}

export interface FeedPollState {
  readonly etag: string | null;
  readonly attempt: number;
  readonly nextAllowedAtMs: number;
  readonly lastStatus: number | null;
}

export type FeedPollDecision =
  | {
      readonly action: 'poll';
      readonly headers: { readonly 'If-None-Match'?: string };
      readonly waitMs: number;
    }
  | {
      readonly action: 'wait';
      readonly waitMs: number;
      /** The response policy that established the current poll schedule. */
      readonly reason: 'min_poll' | 'retry_after' | 'backoff';
    };

type FeedPollWaitReason = 'min_poll' | 'retry_after' | 'backoff';

export interface FeedPollResponseHint {
  readonly status: number;
  readonly etag?: string | null;
  readonly retryAfterSeconds?: number;
  readonly recommendedAfterSeconds?: number;
  readonly notBefore?: string;
}

export interface FeedPollController {
  readonly state: () => FeedPollState;
  decide(nowMs: number): FeedPollDecision;
  observe(response: FeedPollResponseHint, nowMs: number): FeedPollState;
  /**
   * Records an attempt that produced no HTTP response (DNS failure, reset,
   * timeout). It backs off like a 5xx response and keeps the stored ETag.
   */
  observeNetworkError(nowMs: number): FeedPollState;
}

const DEFAULT_BASE_BACKOFF = 1;
const DEFAULT_JITTER = 1;
const DEFAULT_SERVER_MAX = 3600;
const DEFAULT_MAX_DEFERRAL = 86_400;
/** Maximum size of one Feed entity-tag, including weakness marker and quotes. */
export const MAX_FEED_ENTITY_TAG_LENGTH = 1024;
/** Largest seconds value whose conversion to milliseconds remains safe. */
const MAX_SAFE_DELAY_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const FEED_ENTITY_TAG_PATTERN = /^(?:W\/)?"[\x21\x23-\x7E\x80-\u00FF]*"$/u;
const LIMIT_KEYS = new Set([
  'minPollIntervalSeconds',
  'serverMaxBackoffSeconds',
  'baseBackoffSeconds',
  'jitterSeconds',
  'maxDeferralSeconds',
]);
const OPTION_KEYS = new Set(['random', 'initialEtag']);
const RESPONSE_HINT_KEYS = new Set([
  'status',
  'etag',
  'retryAfterSeconds',
  'recommendedAfterSeconds',
  'notBefore',
]);
const BACKOFF_INPUT_KEYS = new Set([
  'attempt',
  'baseSeconds',
  'serverMaxSeconds',
  'jitterSeconds',
  'random',
]);

interface FeedPollDeadlineCandidate {
  readonly deadlineMs: number;
  readonly reason: FeedPollWaitReason;
}

interface FeedPollDeadlineInput {
  readonly previous?: FeedPollDeadlineCandidate;
  readonly minPoll: FeedPollDeadlineCandidate;
  readonly retryAfter?: FeedPollDeadlineCandidate;
  readonly backoff?: FeedPollDeadlineCandidate;
  readonly notBefore?: FeedPollDeadlineCandidate;
}

/**
 * Creates a Feed poll controller enforcing minPoll, ETag, 429 Retry-After, and
 * exponential backoff with jitter for 5xx, 429 without Retry-After, and
 * network failures (FEED-0008). Every wait is bounded by `maxDeferralSeconds`.
 */
export function createFeedPollController(
  limits: FeedPollLimits,
  options: {
    readonly random?: () => number;
    readonly initialEtag?: string | null;
  } = {},
): FeedPollController {
  const safeLimits = snapshotOwnDataRecord(limits, 'Feed poll limits', LIMIT_KEYS);
  const safeOptions = snapshotOwnDataRecord(options, 'Feed poll options', OPTION_KEYS);
  const minPoll = readPositiveDelayInteger(
    safeLimits.minPollIntervalSeconds,
    'minPollIntervalSeconds',
  );
  const serverMax = safeLimits.serverMaxBackoffSeconds === undefined
    ? DEFAULT_SERVER_MAX
    : readPositiveDelayInteger(
        safeLimits.serverMaxBackoffSeconds,
        'serverMaxBackoffSeconds',
      );
  const base = safeLimits.baseBackoffSeconds === undefined
    ? DEFAULT_BASE_BACKOFF
    : readPositiveDelayInteger(safeLimits.baseBackoffSeconds, 'baseBackoffSeconds');
  const jitter = safeLimits.jitterSeconds === undefined
    ? DEFAULT_JITTER
    : readSafeDelaySeconds(safeLimits.jitterSeconds, 'jitterSeconds');
  assertBackoffRange(serverMax, jitter);
  const maxDeferral = safeLimits.maxDeferralSeconds === undefined
    ? Math.max(DEFAULT_MAX_DEFERRAL, minPoll)
    : readPositiveDelayInteger(safeLimits.maxDeferralSeconds, 'maxDeferralSeconds');
  if (maxDeferral < minPoll) {
    throw new TypeError('maxDeferralSeconds must not be below minPollIntervalSeconds.');
  }

  const random = safeOptions.random === undefined
    ? Math.random
    : readRandomFunction(safeOptions.random);

  const initialEtag = safeOptions.initialEtag;
  let etag: string | null = initialEtag === undefined || initialEtag === null
    ? null
    : validateFeedEntityTag(initialEtag, 'initialEtag');
  let attempt = 0;
  let nextAllowedAtMs = 0;
  let lastStatus: number | null = null;
  let deadlineReason: FeedPollWaitReason | null = null;
  let randomInProgress = false;

  const sampleRandom = (): number => {
    randomInProgress = true;
    try {
      return random();
    } finally {
      randomInProgress = false;
    }
  };

  const snapshot = (): FeedPollState =>
    Object.freeze({
      etag,
      attempt,
      nextAllowedAtMs,
      lastStatus,
    });

  const selectDeadline = (
    nowMs: number,
    reason: FeedPollWaitReason,
    delays: {
      readonly regularIntervalSeconds: number;
      readonly retryAfterSeconds: number | undefined;
      readonly backoffSeconds: number | undefined;
      readonly notBeforeMs: number | undefined;
    },
  ): FeedPollDeadlineCandidate => {
    const candidate = (seconds: number, label: string): FeedPollDeadlineCandidate => ({
      deadlineMs: deadlineAfterSeconds(nowMs, seconds, label),
      reason,
    });
    const selected = computeFeedPollDeadline({
      ...(deadlineReason === null
        ? {}
        : { previous: { deadlineMs: nextAllowedAtMs, reason: deadlineReason } }),
      minPoll: candidate(delays.regularIntervalSeconds, 'Feed minimum poll interval'),
      ...(delays.retryAfterSeconds === undefined
        ? {}
        : { retryAfter: candidate(delays.retryAfterSeconds, 'Feed Retry-After') }),
      ...(delays.backoffSeconds === undefined
        ? {}
        : { backoff: candidate(delays.backoffSeconds, 'Feed backoff') }),
      ...(delays.notBeforeMs === undefined
        ? {}
        : { notBefore: { deadlineMs: delays.notBeforeMs, reason } }),
    });
    // No response, and no deadline kept from an earlier one, may defer the
    // next poll beyond the ceiling. The manifest minimum always fits under it.
    const ceilingMs = deadlineAfterSeconds(nowMs, maxDeferral, 'Feed maximum deferral');
    return selected.deadlineMs > ceilingMs
      ? Object.freeze({ deadlineMs: ceilingMs, reason: selected.reason })
      : selected;
  };

  return Object.freeze({
    state: snapshot,
    decide(nowMs: number): FeedPollDecision {
      const safeNowMs = readNonNegativeSafeInteger(nowMs, 'nowMs');
      const waitMs = safeNowMs < nextAllowedAtMs
        ? subtractSafeIntegers(nextAllowedAtMs, safeNowMs, 'Feed poll wait')
        : 0;
      if (waitMs > 0) {
        if (deadlineReason === null) {
          throw new TypeError('Feed poll state has no reason for its active deadline.');
        }
        return Object.freeze({ action: 'wait', waitMs, reason: deadlineReason });
      }
      const headers: { 'If-None-Match'?: string } = {};
      if (etag !== null) {
        // Validate again at the HTTP egress boundary even though stored values
        // have already passed the response/constructor boundary.
        headers['If-None-Match'] = validateFeedEntityTag(etag, 'Stored Feed ETag');
      }
      return Object.freeze({
        action: 'poll',
        headers: Object.freeze(headers),
        waitMs: 0,
      });
    },
    observe(response: FeedPollResponseHint, nowMs: number): FeedPollState {
      if (randomInProgress) {
        throw new TypeError('Feed poll observe must not be re-entered from random().');
      }
      const hint = snapshotResponseHint(response);
      const safeNowMs = readNonNegativeSafeInteger(nowMs, 'nowMs');
      const status = hint.status;
      if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
        throw new TypeError('status must be a valid HTTP status code.');
      }

      const newEtag = readResponseEtag(hint.etag, etag);
      const retryAfterSeconds = readOptionalNonNegativeNumber(
        hint.retryAfterSeconds,
        'retryAfterSeconds',
      );
      const recommendedAfterSeconds = readOptionalNonNegativeNumber(
        hint.recommendedAfterSeconds,
        'recommendedAfterSeconds',
      );
      const notBeforeMs = readOptionalNotBefore(hint.notBefore);

      // A 429 without Retry-After still means "slow down": back off like a 5xx
      // rather than leaving the schedule untouched and polling again at once.
      const isRetryAfter = status === 429 && retryAfterSeconds !== undefined;
      const isBackoff = status >= 500 || (status === 429 && !isRetryAfter);
      const newAttempt = isRetryAfter || isBackoff
        ? addSafeIntegers(attempt, 1, 'Feed poll attempt')
        : 0;
      const responseReason: FeedPollWaitReason = isRetryAfter
        ? 'retry_after'
        : isBackoff
          ? 'backoff'
          : 'min_poll';

      // A recommendation can lengthen the regular cadence, but never weaken
      // the manifest minimum. It is reported as `min_poll` when it wins.
      const regularIntervalSeconds = Math.max(minPoll, recommendedAfterSeconds ?? 0);
      const selectedDeadline = selectDeadline(safeNowMs, responseReason, {
        regularIntervalSeconds,
        retryAfterSeconds,
        backoffSeconds: isBackoff
          ? computeBackoffSeconds(newAttempt, base, serverMax, jitter, sampleRandom)
          : undefined,
        notBeforeMs,
      });

      // Commit only after every hint field and derived value has succeeded.
      etag = newEtag;
      attempt = newAttempt;
      lastStatus = status;
      nextAllowedAtMs = selectedDeadline.deadlineMs;
      deadlineReason = selectedDeadline.reason;
      return snapshot();
    },
    observeNetworkError(nowMs: number): FeedPollState {
      if (randomInProgress) {
        throw new TypeError('Feed poll observe must not be re-entered from random().');
      }
      const safeNowMs = readNonNegativeSafeInteger(nowMs, 'nowMs');
      const newAttempt = addSafeIntegers(attempt, 1, 'Feed poll attempt');
      const selectedDeadline = selectDeadline(safeNowMs, 'backoff', {
        regularIntervalSeconds: minPoll,
        retryAfterSeconds: undefined,
        backoffSeconds: computeBackoffSeconds(newAttempt, base, serverMax, jitter, sampleRandom),
        notBeforeMs: undefined,
      });
      attempt = newAttempt;
      lastStatus = null;
      nextAllowedAtMs = selectedDeadline.deadlineMs;
      deadlineReason = selectedDeadline.reason;
      return snapshot();
    },
  });
}

/**
 * Selects the earliest permitted poll time. Ties preserve the earlier
 * candidate in the documented order: previous, minPoll, Retry-After,
 * backoff, then notBefore. All candidates from one response carry that
 * response's public policy reason; a still-active previous deadline retains
 * the reason that originally established it.
 */
function computeFeedPollDeadline(input: FeedPollDeadlineInput): FeedPollDeadlineCandidate {
  const candidates = [
    input.previous,
    input.minPoll,
    input.retryAfter,
    input.backoff,
    input.notBefore,
  ];
  let selected: FeedPollDeadlineCandidate | undefined;
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    readSafeInteger(candidate.deadlineMs, `${candidate.reason} deadline`);
    if (selected === undefined || candidate.deadlineMs > selected.deadlineMs) {
      selected = candidate;
    }
  }
  if (selected === undefined) {
    throw new TypeError('Feed poll deadline requires at least one constraint.');
  }
  return Object.freeze({ ...selected });
}

function snapshotResponseHint(response: FeedPollResponseHint): Readonly<FeedPollResponseHint> {
  return snapshotOwnDataRecord(
    response,
    'Feed poll response hint',
    RESPONSE_HINT_KEYS,
  ) as Readonly<FeedPollResponseHint>;
}

function readResponseEtag(value: unknown, current: string | null): string | null {
  if (value === undefined) return current;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError('etag must be a string or null.');
  }
  return validateFeedEntityTag(value, 'etag');
}

function readOptionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return readSafeDelaySeconds(value, name);
}

function readOptionalNotBefore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isRfc3339DateTime(value)) {
    throw new TypeError('notBefore must be a valid RFC 3339 date-time string.');
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError('notBefore must be a valid date-time with a safe integer timestamp.');
  }
  return parsed;
}

function computeBackoffSeconds(
  attempt: number,
  base: number,
  serverMax: number,
  jitter: number,
  random: () => number,
): number {
  return computeValidatedBackoffSeconds(attempt - 1, base, serverMax, jitter, random);
}

function deadlineAfterSeconds(nowMs: number, seconds: number, label: string): number {
  const delayMs = secondsToMilliseconds(seconds, label);
  return addSafeIntegers(nowMs, delayMs, `${label} deadline`);
}

function secondsToMilliseconds(seconds: number, label: string): number {
  const safeSeconds = readSafeDelaySeconds(seconds, `${label} seconds`);
  const milliseconds = Math.ceil(safeSeconds * 1000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError(`${label} milliseconds must be a safe integer.`);
  }
  return milliseconds;
}

function addSafeIntegers(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`${label} exceeds the safe integer range.`);
  }
  return result;
}

function subtractSafeIntegers(left: number, right: number, label: string): number {
  const result = left - right;
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`${label} exceeds the safe integer range.`);
  }
  return result;
}

/**
 * Computes exponential backoff delay with jitter:
 * `min(serverMax, base * 2^attempt) + random(0, jitter)`.
 */
export function computeFeedBackoffSeconds(input: {
  readonly attempt: number;
  readonly baseSeconds?: number;
  readonly serverMaxSeconds?: number;
  readonly jitterSeconds?: number;
  readonly random?: () => number;
}): number {
  const safeInput = snapshotOwnDataRecord(
    input,
    'Feed backoff input',
    BACKOFF_INPUT_KEYS,
  );
  const attempt = readNonNegativeInteger(safeInput.attempt, 'attempt');
  const base = safeInput.baseSeconds === undefined
    ? DEFAULT_BASE_BACKOFF
    : readPositiveDelayInteger(safeInput.baseSeconds, 'baseSeconds');
  const serverMax = safeInput.serverMaxSeconds === undefined
    ? DEFAULT_SERVER_MAX
    : readPositiveDelayInteger(safeInput.serverMaxSeconds, 'serverMaxSeconds');
  const jitter = safeInput.jitterSeconds === undefined
    ? DEFAULT_JITTER
    : readSafeDelaySeconds(safeInput.jitterSeconds, 'jitterSeconds');
  const random = safeInput.random === undefined
    ? Math.random
    : readRandomFunction(safeInput.random);
  assertBackoffRange(serverMax, jitter);
  return computeValidatedBackoffSeconds(attempt, base, serverMax, jitter, random);
}

function computeValidatedBackoffSeconds(
  exponent: number,
  base: number,
  serverMax: number,
  jitter: number,
  random: () => number,
): number {
  const multiplier = 2 ** Math.min(exponent, 20);
  const capped = base > serverMax / multiplier
    ? serverMax
    : Math.min(serverMax, base * multiplier);
  const result = capped + randomUnit(random) * jitter;
  return readSafeDelaySeconds(result, 'Feed backoff result');
}

function randomUnit(random: () => number): number {
  const value = random();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('random() must return a finite number in [0, 1].');
  }
  return value;
}

function readPositiveDelayInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  if (value > MAX_SAFE_DELAY_SECONDS) {
    throw new TypeError(`${name} exceeds the safe delay range.`);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function readSafeDelaySeconds(value: unknown, name: string): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > MAX_SAFE_DELAY_SECONDS
  ) {
    throw new TypeError(`${name} must be a non-negative finite number in the safe delay range.`);
  }
  return value;
}

function assertBackoffRange(serverMax: number, jitter: number): void {
  if (serverMax + jitter > MAX_SAFE_DELAY_SECONDS) {
    throw new TypeError('serverMaxSeconds plus jitterSeconds exceeds the safe delay range.');
  }
}

function readRandomFunction(value: unknown): () => number {
  if (typeof value !== 'function' || isProxy(value)) {
    throw new TypeError('random must be a non-Proxy function.');
  }
  return value as () => number;
}

function readSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer.`);
  }
  return value;
}

function readNonNegativeSafeInteger(value: unknown, name: string): number {
  const integer = readSafeInteger(value, name);
  if (integer < 0) {
    throw new TypeError(`${name} must be non-negative.`);
  }
  return integer;
}

function snapshotOwnDataRecord(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${label} must be a plain Own-data Record.`);
  }
  // Node's Proxy check does not invoke traps and must precede every reflective
  // operation on caller-controlled input.
  if (isProxy(value)) {
    throw new TypeError(`${label} must not be a Proxy.`);
  }
  if (Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain Own-data Record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain Own-data Record.`);
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new TypeError(`${label} must not contain symbol keys.`);
    }
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unknown field "${key}".`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} fields must be enumerable own data properties.`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

/** Validate one RFC 9110 strong or weak entity-tag for Feed conditional GET. */
function validateFeedEntityTag(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string.`);
  }
  if (value.length > MAX_FEED_ENTITY_TAG_LENGTH) {
    throw new TypeError(`${name} must not exceed ${MAX_FEED_ENTITY_TAG_LENGTH} characters.`);
  }
  if (!FEED_ENTITY_TAG_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a single RFC 9110 strong or weak entity-tag.`);
  }
  return value;
}
