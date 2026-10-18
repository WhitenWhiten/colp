import { describe, expect, it } from 'vitest';
import { compareExactRfc3339Instants, parseExactRfc3339Instant } from '../../src/shared/exact-instant.js';

function compare(left: string, right: string): number {
  const a = parseExactRfc3339Instant(left);
  const b = parseExactRfc3339Instant(right);
  if (a === undefined || b === undefined) throw new Error('Expected comparable instants.');
  return compareExactRfc3339Instants(a, b);
}

describe('exact RFC 3339 expiry and retention clocks', () => {
  it.each([
    ['2026-07-18T01:00:00.0001Z', '2026-07-18T01:00:00.0009Z', -1],
    ['2026-07-18T01:00:00.1Z', '2026-07-18T01:00:00.10000Z', 0],
    ['2026-07-18T01:00:00Z', '2026-07-18T01:00:00.00000Z', 0],
    ['2026-07-18T09:00:00.0009+08:00', '2026-07-18T01:00:00.0001Z', 1],
    ['2026-07-18T00:00:00.0001-01:00', '2026-07-18T01:00:00.00010Z', 0],
    ['2026-07-18T01:00:00.0001-00:00', '2026-07-18T01:00:00.00010Z', 0],
    ['1969-12-31T23:59:59.9991Z', '1969-12-31T23:59:59.9999Z', -1],
    [`2026-07-18T01:00:00.${'9'.repeat(100)}Z`, '2026-07-18T01:00:01Z', -1],
    [`2026-07-18T01:00:00.${'0'.repeat(100)}1Z`, '2026-07-18T01:00:00Z', 1],
  ] as const)('orders %s against %s exactly', (left, right, expected) => {
    expect(compare(left, right)).toBe(expected);
    expect(compare(right, left)).toBe(expected === 0 ? 0 : -expected);
  });

  it('agrees with integer arithmetic across decimal widths and equivalent trailing zeros', () => {
    const fractions = ['0', '1', '9', '10', '01', '001', '0001', '0009', '1001',
      '1000000000000000000001', '9999999999999999999999'];
    for (const left of fractions) for (const right of fractions) {
      const lhs = BigInt(left) * 10n ** BigInt(right.length);
      const rhs = BigInt(right) * 10n ** BigInt(left.length);
      const expected = lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
      expect(compare(`2026-07-18T01:00:00.${left}Z`, `2026-07-18T01:00:00.${right}Z`))
        .toBe(expected);
    }
  });

  it.each(['invalid', '2026-02-30T01:00:00Z', '2016-12-31T23:59:60Z'])(
    'fails closed for an unorderable clock value %s', (value) => {
      expect(parseExactRfc3339Instant(value)).toBeUndefined();
    },
  );
});
