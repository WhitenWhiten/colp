import { Buffer } from 'node:buffer';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import * as clientBoundary from '../../src/client/index.js';
import * as packageBoundary from '../../src/semantic/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import * as semanticBoundary from '../../src/semantic/index.js';
import { propertyOptions } from '../helpers/property-options.js';

const evidence = '[evidence:core.position-ascii-octet-order]';
const positionAlphabet = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const invalidPositionMessage = 'Position tokens must match ^[0-9A-Za-z_-]{1,128}$.';

type PositionComparator = (left: string, right: string) => number;
type PositionApi = { readonly compareOrderKeys?: PositionComparator };

const boundaries = [
  ['semantic public entry', packageBoundary as PositionApi],
  ['semantic', semanticBoundary as PositionApi],
  ['client', clientBoundary as PositionApi],
] as const;

const invalidPositions: readonly (readonly [label: string, value: unknown])[] = [
  ['empty string', ''],
  ['129-octet string', 'a'.repeat(129)],
  ['non-ASCII letter', 'caf\u00e9'],
  ['decomposed non-ASCII letter', 'cafe\u0301'],
  ['NUL control character', 'a\u0000b'],
  ['line-feed control character', 'a\nb'],
  ['space punctuation', 'a b'],
  ['period punctuation', 'a.b'],
  ['slash punctuation', 'a/b'],
  ['null', null],
  ['undefined', undefined],
  ['boolean', true],
  ['number', 1],
  ['bigint', 1n],
  ['symbol', Symbol('position')],
  ['array', ['a']],
  ['object', { position: 'a' }],
  ['function', () => 'a'],
] as const;

const positionToken = fc
  .array(fc.constantFrom(...positionAlphabet), { minLength: 1, maxLength: 128 })
  .map((octets) => octets.join(''));

function comparator(): PositionComparator {
  const candidate = (packageBoundary as PositionApi).compareOrderKeys;
  expect(typeof candidate, 'CORE-0025 needs a public Position comparator').toBe('function');
  return candidate as PositionComparator;
}

function sign(value: number): -1 | 0 | 1 {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function bufferOracle(left: string, right: string): -1 | 0 | 1 {
  return sign(Buffer.compare(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii')));
}

describe(`CORE-0025 opaque Position ASCII octet ordering ${evidence}`, () => {
  const validators = createValidatorRegistry();

  it.each(['-', positionAlphabet, 'z'.repeat(128)])(
    'accepts structurally valid Position token %j',
    (token) => {
      expect(validators.validate('orderKey', token)).toEqual({ valid: true, errors: [] });
    },
  );

  it.each(invalidPositions)('structurally rejects %s', (_label, invalid) => {
    expect(validators.validate('orderKey', invalid).valid).toBe(false);
  });

  it.each(boundaries)('exports the comparator from the %s boundary', (_name, boundary) => {
    expect(boundary.compareOrderKeys).toBe(comparator());
  });

  it('orders the complete allowed alphabet by unsigned ASCII octet value', () => {
    expect([...positionAlphabet].reverse().sort(comparator()).join('')).toBe(positionAlphabet);
  });

  it.each([
    ['hyphen before digit', '-', '0'],
    ['digit before uppercase', '9', 'A'],
    ['uppercase before underscore', 'Z', '_'],
    ['underscore before lowercase', '_', 'a'],
    ['uppercase before lowercase', 'A', 'a'],
  ])('orders %s', (_label, lower, higher) => {
    expect(comparator()(lower, higher)).toBe(-1);
    expect(comparator()(higher, lower)).toBe(1);
  });

  it.each([
    ['one-octet prefix', 'A', 'A0'],
    ['multi-octet prefix', 'alpha', 'alpha0'],
    ['delimiter-bearing prefix', 'A-', 'A-0'],
  ])('orders a shorter %s before its extension', (_label, prefix, extension) => {
    expect(comparator()(prefix, extension)).toBe(-1);
    expect(comparator()(extension, prefix)).toBe(1);
  });

  it.each(['-', '0', 'Position', '_', 'z'.repeat(128)])(
    'returns equality only for the same valid opaque token %j',
    (token) => {
      expect(comparator()(token, token)).toBe(0);
    },
  );

  it('uses lexicographic ordering rather than numeric ordering', () => {
    expect(['2', '10', '1'].sort(comparator())).toEqual(['1', '10', '2']);
  });

  it('does not use locale-aware or case-folded collation', () => {
    expect(['a', '_', 'Z', 'z', 'A'].sort(comparator())).toEqual(['A', 'Z', '_', 'a', 'z']);
  });

  it('compares hyphens and underscores as ordinary octets', () => {
    expect(['A_', 'A0', 'A-a', 'A_a', 'A-'].sort(comparator())).toEqual([
      'A-',
      'A-a',
      'A0',
      'A_',
      'A_a',
    ]);
  });

  it('accepts and compares the minimum one-octet Position', () => {
    expect(comparator()('-', '0')).toBe(-1);
  });

  it('accepts and compares the maximum 128-octet Position', () => {
    const maximumLength = 'z'.repeat(128);
    expect(comparator()(maximumLength, maximumLength)).toBe(0);
    expect(comparator()(`${'z'.repeat(127)}y`, maximumLength)).toBe(-1);
  });

  it('keeps leading zeroes opaque instead of parsing a number', () => {
    expect(['1', '001', '01', '0001'].sort(comparator())).toEqual(['0001', '001', '01', '1']);
    expect(comparator()('01', '1')).not.toBe(0);
  });

  it('keeps delimiter-looking content opaque instead of parsing components', () => {
    expect(['part-2', 'part-10', 'part_2', 'part_10'].sort(comparator())).toEqual([
      'part-10',
      'part-2',
      'part_10',
      'part_2',
    ]);
  });

  it.each(invalidPositions)('rejects %s on the left operand', (_label, invalid) => {
    expect(() => comparator()(invalid as string, 'A')).toThrowError(
      new TypeError(invalidPositionMessage),
    );
  });

  it.each(invalidPositions)('rejects %s on the right operand', (_label, invalid) => {
    expect(() => comparator()('A', invalid as string)).toThrowError(
      new TypeError(invalidPositionMessage),
    );
  });

  it('matches an independent Buffer unsigned-byte oracle for random valid Positions', () => {
    fc.assert(
      fc.property(positionToken, positionToken, (left, right) => {
        expect(sign(comparator()(left, right))).toBe(bufferOracle(left, right));
      }),
      propertyOptions(500),
    );
  });

  it('is antisymmetric for random valid Positions', () => {
    fc.assert(
      fc.property(positionToken, positionToken, (left, right) => {
        const reverse = sign(comparator()(right, left));
        expect(sign(comparator()(left, right))).toBe(reverse === 0 ? 0 : -reverse);
      }),
      propertyOptions(300),
    );
  });

  it('is transitive for random valid Positions', () => {
    fc.assert(
      fc.property(positionToken, positionToken, positionToken, (left, middle, right) => {
        const compare = comparator();
        if (compare(left, middle) <= 0 && compare(middle, right) <= 0) {
          expect(compare(left, right)).toBeLessThanOrEqual(0);
        }
      }),
      propertyOptions(300),
    );
  });

  it('sorts random Position arrays exactly like the unsigned-byte oracle', () => {
    fc.assert(
      fc.property(fc.array(positionToken, { minLength: 0, maxLength: 100 }), (positions) => {
        expect([...positions].sort(comparator())).toEqual([...positions].sort(bufferOracle));
      }),
      propertyOptions(300),
    );
  });

  it('preserves input order for records with equal Position tokens', () => {
    const records = [
      { id: 'first-a', position: 'A' },
      { id: 'first-b', position: 'B' },
      { id: 'second-a', position: 'A' },
      { id: 'second-b', position: 'B' },
      { id: 'third-a', position: 'A' },
    ];

    expect(records.sort((left, right) => comparator()(left.position, right.position))).toEqual([
      { id: 'first-a', position: 'A' },
      { id: 'second-a', position: 'A' },
      { id: 'third-a', position: 'A' },
      { id: 'first-b', position: 'B' },
      { id: 'second-b', position: 'B' },
    ]);
  });
});
