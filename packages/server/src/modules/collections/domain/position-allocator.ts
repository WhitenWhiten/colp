import { randomBytes } from 'node:crypto';
import { CollectionsError, PositionRebalanceEscalationError } from './errors.js';

/** COLP orderKey alphabet in exact ASCII collation order. */
const CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const BASE = CHARS.length;
const MIN_CHAR = CHARS[0]!;
const MAX_CHAR = CHARS[CHARS.length - 1]!;
const MID_CHAR = CHARS[Math.floor(BASE / 2)]!;
const POSITION_MAX_OCTETS = 128;
const POSITION_PATTERN = /^[0-9A-Za-z_-]+$/;

/**
 * Allocate a live sibling position token strictly between bounds.
 *
 * @param beforeToken exclusive lower bound — position of the sibling immediately
 *   before the insertion point (`afterId`'s position), or null for -∞
 * @param afterToken exclusive upper bound — position of the sibling immediately
 *   after the insertion point (`beforeId`'s position), or null for +∞
 * @param existing live sibling position tokens under the parent (collision guard)
 */
export function allocatePosition(
  beforeToken: string | null,
  afterToken: string | null,
  existing: readonly string[] = [],
): string {
  if (beforeToken !== null) assertValidPositionToken(beforeToken, 'beforeToken');
  if (afterToken !== null) assertValidPositionToken(afterToken, 'afterToken');
  if (
    beforeToken !== null
    && afterToken !== null
    && beforeToken >= afterToken
  ) {
    throw new CollectionsError(
      'invalid_node_anchor',
      'position lower bound must be strictly less than upper bound',
    );
  }

  const occupied = new Set(existing);
  let candidate = generateKeyBetween(beforeToken, afterToken);

  if (
    !occupied.has(candidate)
    && isStrictlyBetween(candidate, beforeToken, afterToken)
    && isValidPositionToken(candidate)
  ) {
    return candidate;
  }

  // Rare collision or degenerate mid: try jittered keys that stay in range.
  for (let attempt = 0; attempt < 32; attempt += 1) {
    candidate = generateKeyBetween(beforeToken, afterToken);
    if (afterToken === null && beforeToken !== null) {
      candidate = `${beforeToken}${MID_CHAR}${randomBase62(4)}`;
    } else if (beforeToken === null && afterToken !== null) {
      candidate = prefixBefore(afterToken, randomBase62(4));
    } else if (beforeToken !== null && afterToken !== null) {
      const mid = generateKeyBetween(beforeToken, afterToken);
      candidate = mid.length < POSITION_MAX_OCTETS - 4
        ? `${mid}${randomBase62(4)}`
        : mid;
      // Jitter may leave the open interval; fall through to check.
    } else {
      candidate = `${MID_CHAR}${randomBase62(8)}`;
    }

    if (
      !occupied.has(candidate)
      && isStrictlyBetween(candidate, beforeToken, afterToken)
      && isValidPositionToken(candidate)
    ) {
      return candidate;
    }
  }

  // Last resort: rebalance-style evenly spaced token using index among existing.
  const ordered = [...existing].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const rebalanced = rebalanceInsert(beforeToken, afterToken, ordered);
  if (
    !occupied.has(rebalanced)
    && isStrictlyBetween(rebalanced, beforeToken, afterToken)
    && isValidPositionToken(rebalanced)
  ) {
    return rebalanced;
  }

  throw new CollectionsError(
    'invalid_node_anchor',
    'unable to allocate a unique position token between anchors',
  );
}

export function assertValidPositionToken(token: string, field = 'position'): string {
  if (!isValidPositionToken(token)) {
    throw new CollectionsError(
      'invalid_node_input',
      `${field} must be a 1..${POSITION_MAX_OCTETS} byte COLP order key`,
    );
  }
  return token;
}

export function isValidPositionToken(token: string): boolean {
  if (typeof token !== 'string' || token.length < 1) return false;
  if (Buffer.byteLength(token, 'utf8') > POSITION_MAX_OCTETS) return false;
  return POSITION_PATTERN.test(token);
}

/**
 * Generate a key strictly between a (exclusive lower) and b (exclusive upper).
 * null means unbounded on that side.
 */
export function generateKeyBetween(a: string | null, b: string | null): string {
  if (a === null && b === null) {
    return MID_CHAR;
  }
  if (a === null) {
    return getKeyBefore(b!);
  }
  if (b === null) {
    return getKeyAfter(a);
  }
  return getKeyBetween(a, b);
}

function getKeyAfter(a: string): string {
  // Prefer appending mid digit so a + mid > a lexicographically.
  if (Buffer.byteLength(a, 'utf8') + 1 <= POSITION_MAX_OCTETS) {
    return `${a}${MID_CHAR}`;
  }
  // Increment last digit with carry; if overflow, append mid.
  const incremented = tryIncrement(a);
  if (incremented !== null) return incremented;
  return `${a}${MID_CHAR}`.slice(0, POSITION_MAX_OCTETS);
}

function getKeyBefore(b: string): string {
  // Find a token lexicographically before b.
  if (b.length === 0) {
    throw new CollectionsError('invalid_node_anchor', 'upper bound position is empty');
  }
  // If b starts with something > MIN, midpoint from empty prefix.
  const first = indexOfChar(b[0]!);
  if (first > 0) {
    return CHARS[Math.floor(first / 2)]!;
  }
  // b starts with MIN_CHAR: try shorter or dig into remaining.
  if (b.length === 1) {
    // No character before MIN_CHAR — dig deeper: MIN + mid of rest.
    return `${MIN_CHAR}${MID_CHAR}`;
  }
  // midpoint between MIN_CHAR and b
  return getKeyBetween(MIN_CHAR, b);
}

function getKeyBetween(a: string, b: string): string {
  if (a >= b) {
    throw new CollectionsError(
      'invalid_node_anchor',
      'position lower bound must be strictly less than upper bound',
    );
  }

  // Common prefix
  let prefixLen = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefixLen < minLen && a[prefixLen] === b[prefixLen]) {
    prefixLen += 1;
  }

  const prefix = a.slice(0, prefixLen);
  const digitA = prefixLen < a.length ? indexOfChar(a[prefixLen]!) : -1;
  const digitB = prefixLen < b.length ? indexOfChar(b[prefixLen]!) : BASE;

  if (digitB - digitA > 1) {
    const mid = Math.floor((digitA + digitB) / 2);
    // digitA can be -1 (a exhausted); map to mid digit >= 0
    const midDigit = Math.max(0, mid);
    if (midDigit > digitA && midDigit < digitB) {
      return `${prefix}${CHARS[midDigit]!}`;
    }
  }

  // Adjacent digits or a is prefix of b: extend past a.
  if (prefixLen === a.length) {
    // a is prefix of b → pick something between a and b by descending into b's suffix.
    // Example: a="a", b="aU" → need "a" < x < "aU" → "a" + key before "U"
    const rest = b.slice(a.length);
    const beforeRest = getKeyBefore(rest);
    const candidate = `${a}${beforeRest}`;
    if (candidate > a && candidate < b) return candidate;
    return `${a}${MIN_CHAR}`;
  }

  // Extend a with mid so a < a+mid < b (when b is not a prefix of a — already a < b).
  const extended = `${a}${MID_CHAR}`;
  if (extended < b) return extended;

  // Digits almost adjacent: dig into a.
  const deeper = `${a}${MIN_CHAR}`;
  if (deeper < b) return deeper;

  // Fall back to midpoint via digit arrays.
  return averageStrings(a, b);
}

function averageStrings(a: string, b: string): string {
  const len = Math.max(a.length, b.length) + 1;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < len; i += 1) {
    left.push(i < a.length ? indexOfChar(a[i]!) : 0);
    right.push(i < b.length ? indexOfChar(b[i]!) : 0);
  }

  const mid: number[] = [];
  let carry = 0;
  for (let i = 0; i < len; i += 1) {
    const sum = left[i]! + right[i]! + carry * BASE;
    // Rough average; refine with residual on next digits.
    mid.push(Math.floor(sum / 2));
    carry = sum % 2;
    // Propagate fractional remainder by continuing.
  }

  // Ensure strict between by adjusting if equal to bounds.
  let result = digitsToString(mid);
  if (result <= a || result >= b) {
    result = `${a}${MID_CHAR}`;
    if (result >= b) {
      result = `${a}${MIN_CHAR}${MID_CHAR}`;
    }
  }
  if (result.length > POSITION_MAX_OCTETS) {
    result = result.slice(0, POSITION_MAX_OCTETS);
  }
  if (!(result > a && result < b)) {
    throw new CollectionsError(
      'invalid_node_anchor',
      'no allocatable gap between position anchors',
    );
  }
  return result;
}

function digitsToString(digits: number[]): string {
  // Trim trailing zeros for shorter tokens.
  let end = digits.length;
  while (end > 1 && digits[end - 1] === 0) end -= 1;
  let out = '';
  for (let i = 0; i < end; i += 1) {
    const d = digits[i]!;
    const clamped = Math.min(BASE - 1, Math.max(0, d));
    out += CHARS[clamped]!;
  }
  return out.length > 0 ? out : MID_CHAR;
}

function tryIncrement(token: string): string | null {
  const chars = token.split('');
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const idx = indexOfChar(chars[i]!);
    if (idx < BASE - 1) {
      chars[i] = CHARS[idx + 1]!;
      for (let j = i + 1; j < chars.length; j += 1) chars[j] = MIN_CHAR;
      return chars.join('');
    }
  }
  return null;
}

function prefixBefore(upper: string, salt: string): string {
  const first = indexOfChar(upper[0]!);
  if (first > 0) {
    const mid = Math.floor(first / 2);
    return `${CHARS[mid]!}${salt}`.slice(0, POSITION_MAX_OCTETS);
  }
  return `${MIN_CHAR}${salt}`.slice(0, POSITION_MAX_OCTETS);
}

function rebalanceInsert(
  beforeToken: string | null,
  afterToken: string | null,
  ordered: readonly string[],
): string {
  // Assign conceptual ranks and pick mid rank string of fixed width.
  let lo = 0;
  let hi = ordered.length + 1;
  if (beforeToken !== null) {
    const idx = ordered.indexOf(beforeToken);
    if (idx >= 0) lo = idx + 1;
  }
  if (afterToken !== null) {
    const idx = ordered.indexOf(afterToken);
    if (idx >= 0) hi = idx + 1;
  }
  const rank = Math.floor((lo + hi) / 2);
  // Encode rank as fixed-width base62 so order is stable.
  return encodeRank(rank, Math.max(4, String(ordered.length + 2).length + 1));
}

function encodeRank(rank: number, width: number): string {
  let n = Math.max(0, rank);
  let out = '';
  for (let i = 0; i < width; i += 1) {
    out = CHARS[n % BASE]! + out;
    n = Math.floor(n / BASE);
  }
  while (n > 0) {
    out = CHARS[n % BASE]! + out;
    n = Math.floor(n / BASE);
  }
  return out || MIN_CHAR;
}

export interface BoundedPositionSibling {
  readonly id: string;
  readonly positionToken: string;
}

export interface BoundedPositionAssignment {
  readonly resourceId: string;
  readonly positionToken: string;
}

export interface BoundedPositionRebalancePlan {
  readonly targetPositionToken: string;
  readonly siblingAssignments: readonly BoundedPositionAssignment[];
  readonly windowStart: number;
  readonly windowEnd: number;
}

/**
 * Re-space only a deterministic neighborhood around an insertion point.
 * The target is not counted as a rewritten sibling. Tokens outside [windowStart,
 * windowEnd) are immutable bounds and are never returned as assignments.
 */
export function planBoundedPositionRebalance(input: {
  readonly siblings: readonly BoundedPositionSibling[];
  readonly targetId: string;
  readonly insertIndex: number;
  readonly windowSize: number;
  readonly outsideLowerBoundToken?: string | null;
  readonly outsideUpperBoundToken?: string | null;
}): BoundedPositionRebalancePlan {
  const { siblings, targetId, insertIndex, windowSize } = input;
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new CollectionsError('invalid_node_input', 'position rebalance window must be a positive integer');
  }
  if (!Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > siblings.length) {
    throw new CollectionsError('invalid_node_anchor', 'position insertion index is outside the sibling set');
  }
  for (let index = 0; index < siblings.length; index += 1) {
    const sibling = siblings[index]!;
    assertValidPositionToken(sibling.positionToken, `siblings.${sibling.id}.positionToken`);
    if (index > 0 && siblings[index - 1]!.positionToken >= sibling.positionToken) {
      throw new CollectionsError('invalid_node_anchor', 'live sibling positions must be strictly increasing');
    }
  }

  const rewriteCount = Math.min(windowSize, siblings.length);
  const left = Math.floor(rewriteCount / 2);
  let windowStart = Math.max(0, insertIndex - left);
  let windowEnd = Math.min(siblings.length, windowStart + rewriteCount);
  windowStart = Math.max(0, windowEnd - rewriteCount);

  const lowerBound = input.outsideLowerBoundToken !== undefined
    ? input.outsideLowerBoundToken
    : siblings[windowStart - 1]?.positionToken ?? null;
  const upperBound = input.outsideUpperBoundToken !== undefined
    ? input.outsideUpperBoundToken
    : siblings[windowEnd]?.positionToken ?? null;
  const window = siblings.slice(windowStart, windowEnd);
  const localInsertIndex = insertIndex - windowStart;
  const orderedIds = window.map((sibling) => sibling.id);
  orderedIds.splice(localInsertIndex, 0, targetId);

  let tokens: readonly string[];
  try {
    tokens = generateBoundedPositionTokens(orderedIds.length, lowerBound, upperBound);
  } catch (error: unknown) {
    if (error instanceof CollectionsError && error.code === 'invalid_node_anchor') {
      throw new PositionRebalanceEscalationError(windowSize);
    }
    throw error;
  }
  const assignments = orderedIds.map((resourceId, index) => ({
    resourceId,
    positionToken: tokens[index]!,
  }));
  const target = assignments.find((assignment) => assignment.resourceId === targetId);
  if (!target) throw new PositionRebalanceEscalationError(windowSize);
  return {
    targetPositionToken: target.positionToken,
    siblingAssignments: assignments.filter((assignment) => assignment.resourceId !== targetId),
    windowStart,
    windowEnd,
  };
}

function generateBoundedPositionTokens(
  count: number,
  lowerBound: string | null,
  upperBound: string | null,
): readonly string[] {
  const tokens: string[] = [];
  let lower = lowerBound;
  for (let index = 0; index < count; index += 1) {
    const token = generateKeyBetween(lower, upperBound);
    if (!isValidPositionToken(token) || !isStrictlyBetween(token, lower, upperBound)) {
      throw new CollectionsError('invalid_node_anchor', 'bounded position window has no allocatable token');
    }
    tokens.push(token);
    lower = token;
  }
  return tokens;
}

function isStrictlyBetween(
  token: string,
  beforeToken: string | null,
  afterToken: string | null,
): boolean {
  if (beforeToken !== null && !(token > beforeToken)) return false;
  if (afterToken !== null && !(token < afterToken)) return false;
  return true;
}

function indexOfChar(char: string): number {
  const idx = CHARS.indexOf(char);
  if (idx < 0) {
    throw new CollectionsError(
      'invalid_node_input',
      'position token contains an unsupported character',
    );
  }
  return idx;
}

function randomBase62(byteLength: number): string {
  const bytes = randomBytes(byteLength);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += CHARS[bytes[i]! % BASE]!;
  }
  return out;
}
