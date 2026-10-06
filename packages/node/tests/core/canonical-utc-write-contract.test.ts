import { describe, expect, it } from 'vitest';

import * as packageBoundary from '../../src/schema/index.js';
import * as schemaBoundary from '../../src/schema/index.js';

type CanonicalDateTimeFormatter = (value: Date | string) => string;

interface CanonicalDateTimeApi {
  readonly formatCanonicalDateTime?: CanonicalDateTimeFormatter;
}

const packageApi = packageBoundary as CanonicalDateTimeApi;
const schemaApi = schemaBoundary as CanonicalDateTimeApi;

function formatter(): CanonicalDateTimeFormatter {
  expect(
    typeof packageApi.formatCanonicalDateTime,
    'CORE-0018 needs a public canonical date-time formatter',
  ).toBe('function');
  return packageApi.formatCanonicalDateTime as CanonicalDateTimeFormatter;
}

describe('CORE-0018 canonical UTC writes [evidence:core.canonical-utc-write]', () => {
  it('exposes the formatter at the schema public boundary', () => {
    expect(typeof packageApi.formatCanonicalDateTime).toBe('function');
    expect(schemaApi.formatCanonicalDateTime).toBe(packageApi.formatCanonicalDateTime);
  });

  it.each([
    ['Unix epoch', new Date(0), '1970-01-01T00:00:00.000Z'],
    [
      'minimum four-digit year',
      new Date('0000-01-01T00:00:00.000Z'),
      '0000-01-01T00:00:00.000Z',
    ],
    [
      'maximum four-digit year',
      new Date('9999-12-31T23:59:59.999Z'),
      '9999-12-31T23:59:59.999Z',
    ],
  ] as const)('writes a %s Date in UTC with a terminal Z', (_label, value, expected) => {
    const actual = formatter()(value);

    expect(actual).toBe(expected);
    expect(actual).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });

  it.each([
    ['2026-07-16T15:30:45+08:00', '2026-07-16T07:30:45.000Z'],
    ['2026-07-16T02:30:45-05:00', '2026-07-16T07:30:45.000Z'],
    ['2027-01-01T00:30:00+01:00', '2026-12-31T23:30:00.000Z'],
    ['2026-07-15T23:30:00-08:00', '2026-07-16T07:30:00.000Z'],
    ['2024-02-29T23:59:59.987+05:30', '2024-02-29T18:29:59.987Z'],
    ['2026-07-16T23:59:59+23:59', '2026-07-16T00:00:59.000Z'],
    ['2026-07-16T00:00:00-23:59', '2026-07-16T23:59:00.000Z'],
  ] as const)('normalizes offset input %s without changing its instant', (input, expected) => {
    const actual = formatter()(input);

    expect(actual).toBe(expected);
    expect(new Date(actual).getTime()).toBe(new Date(input).getTime());
    expect(actual.endsWith('Z')).toBe(true);
    expect(actual).not.toMatch(/[+-]\d{2}:\d{2}$/u);
  });

  it.each([
    ['2026-07-16T07:00:00Z', '2026-07-16T07:00:00.000Z'],
    ['2026-07-16t07:00:00z', '2026-07-16T07:00:00.000Z'],
    ['2026-07-16T07:00:00.1Z', '2026-07-16T07:00:00.100Z'],
    ['2026-07-16T07:00:00.1200Z', '2026-07-16T07:00:00.120Z'],
    ['2026-07-16T07:00:00.123000+00:00', '2026-07-16T07:00:00.123Z'],
  ] as const)('stabilizes fractional seconds for %s', (input, expected) => {
    const actual = formatter()(input);

    expect(actual).toBe(expected);
    expect(formatter()(actual)).toBe(actual);
  });

  it('rejects an invalid Date instead of emitting an invalid wire timestamp', () => {
    expect(() => formatter()(new Date(Number.NaN))).toThrow();
  });

  it.each([
    'not-a-date-time',
    '2026-07-16T07:00:00',
    '2023-02-29T12:00:00Z',
    '2026-07-16T07:00:00+24:00',
    '2026-07-16T07:00:00Z trailing-data',
  ])('rejects invalid date-time string %j', (input) => {
    expect(() => formatter()(input)).toThrow();
  });

  it('rejects a leap second that cannot be represented without changing its instant', () => {
    expect(() => formatter()('1990-12-31T23:59:60Z')).toThrow();
  });

  it.each(['2026-07-16T07:00:00.1234Z', '2026-07-16T07:00:00.0001+00:00'])(
    'rejects sub-millisecond precision it cannot preserve for %s',
    (input) => {
      expect(() => formatter()(input)).toThrow('precision');
    },
  );

  it('rejects an unknown local offset instead of falsely asserting UTC', () => {
    expect(schemaBoundary.isRfc3339DateTime('2026-07-16T07:00:00-00:00')).toBe(true);
    expect(() => formatter()('2026-07-16T07:00:00-00:00')).toThrow('unknown local offset');
  });

  it('rejects values outside its public Date-or-string input contract at runtime', () => {
    const uncheckedFormatter = formatter() as unknown as (value: unknown) => string;
    expect(() => uncheckedFormatter(0)).toThrow('Date or RFC 3339 string');
  });

  it.each([
    [
      'immediately below the RFC 3339 four-digit year range',
      new Date('-000001-12-31T23:59:59.999Z'),
    ],
    [
      'immediately above the RFC 3339 four-digit year range',
      new Date('+010000-01-01T00:00:00.000Z'),
    ],
    ['at the minimum JavaScript Date instant', new Date(-8_640_000_000_000_000)],
    ['at the maximum JavaScript Date instant', new Date(8_640_000_000_000_000)],
  ] as const)('rejects a valid Date %s', (_label, value) => {
    expect(Number.isNaN(value.getTime())).toBe(false);
    expect(() => formatter()(value)).toThrow();
  });

  it.each([
    '0000-01-01T00:00:00+00:01',
    '9999-12-31T23:59:59-00:01',
  ])('rejects offset input whose UTC instant crosses the four-digit year range: %s', (input) => {
    expect(schemaBoundary.isRfc3339DateTime(input)).toBe(true);
    expect(() => formatter()(input)).toThrow('four-digit year range');
  });

  it.each([
    '2026-07-16T15:30:45+08:00',
    '2026-07-16T02:30:45-05:00',
    '2026-07-16T07:00:00-00:00',
    '2024-02-29T23:59:59.999+14:00',
    '1991-01-01T00:59:60+01:00',
  ])('keeps reader/schema acceptance for valid offset timestamp %s', (input) => {
    expect(schemaBoundary.isRfc3339DateTime(input)).toBe(true);
    expect(schemaBoundary.createValidatorRegistry().validate('dateTime', input)).toEqual({
      valid: true,
      errors: [],
    });
  });
});
