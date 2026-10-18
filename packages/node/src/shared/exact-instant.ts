import { isRfc3339DateTime } from './date-time.js';

/**
 * An exact, comparable RFC 3339 instant. Only whole seconds pass through
 * JavaScript's Date parser: a decimal fraction must never be truncated to
 * milliseconds when making an expiry or retention decision.
 */
export interface ExactRfc3339Instant {
  /** Integer UTC epoch milliseconds at the start of the containing second. */
  readonly wholeSecond: number;
  /** Exact decimal digits with trailing zeroes removed; empty means zero. */
  readonly fraction: string;
}

/**
 * RFC 3339 -00:00 still gives a known UTC instant; only the local offset is
 * unknown (section 4.3). Individual lifecycle APIs may impose a stricter
 * offset policy before this parser. Leap seconds retain the clocks' existing
 * fail-closed behavior:
 * JavaScript Date cannot represent them, so they are outside this clock model.
 */
export function parseExactRfc3339Instant(value: string): ExactRfc3339Instant | undefined {
  if (!isRfc3339DateTime(value)) return undefined;
  const parts = /^(.{17})([0-9]{2})(?:[.]([0-9]+))?([Zz]|[+-][0-9]{2}:[0-9]{2})$/u.exec(value)!;
  const wholeSecond = Date.parse(parts[1]! + parts[2]! + parts[4]!);
  if (!Number.isFinite(wholeSecond)) return undefined;
  return Object.freeze({
    wholeSecond,
    fraction: (parts[3] ?? '').replace(/0+$/u, ''),
  });
}

/** Compare parsed instants without floating-point fractional arithmetic. */
export function compareExactRfc3339Instants(
  left: ExactRfc3339Instant,
  right: ExactRfc3339Instant,
): -1 | 0 | 1 {
  if (left.wholeSecond !== right.wholeSecond) return left.wholeSecond < right.wholeSecond ? -1 : 1;
  // After trimming trailing zeroes, lexical order is decimal-fraction order:
  // if one value is a prefix, the longer value has a later nonzero digit.
  if (left.fraction === right.fraction) return 0;
  return left.fraction < right.fraction ? -1 : 1;
}
