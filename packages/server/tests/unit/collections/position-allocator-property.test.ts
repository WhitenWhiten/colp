import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { describe, test } from 'vitest';
import {
  allocatePosition,
  CollectionsError,
  isValidPositionToken,
  PositionRebalanceEscalationError,
} from '../../../src/modules/collections/index.js';

/** COLP orderKey alphabet in ASCII collation order (same as the allocator). */
const POSITION_ALPHABET = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const POSITION_CHAR = fc.constantFrom(...POSITION_ALPHABET);

const positionTokenArb = fc
  .array(POSITION_CHAR, { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(''));

const optionalBoundArb = fc.option(positionTokenArb, { nil: null });

const allocationCaseArb = fc.record({
  before: optionalBoundArb,
  after: optionalBoundArb,
  extras: fc.array(positionTokenArb, { maxLength: 8 }),
}).map(({ before, after, extras }) => {
  const existing = [...extras];
  if (before !== null) existing.push(before);
  if (after !== null) existing.push(after);
  return { before, after, existing };
});

type AllocationOutcome =
  | { readonly ok: true; readonly token: string }
  | {
    readonly ok: false;
    readonly error: CollectionsError | PositionRebalanceEscalationError;
  };

function observeAllocate(
  beforeToken: string | null,
  afterToken: string | null,
  existing: readonly string[],
): AllocationOutcome {
  try {
    return { ok: true, token: allocatePosition(beforeToken, afterToken, existing) };
  } catch (error: unknown) {
    if (error instanceof PositionRebalanceEscalationError) {
      return { ok: false, error };
    }
    if (error instanceof CollectionsError) {
      return { ok: false, error };
    }
    throw error;
  }
}

function assertExplicitFailure(error: CollectionsError | PositionRebalanceEscalationError): void {
  if (error instanceof PositionRebalanceEscalationError) {
    assert.equal(error.code, 'position_context_stale');
    return;
  }
  assert.ok(
    error.code === 'invalid_node_anchor' || error.code === 'invalid_node_input',
    `unexpected CollectionsError code ${error.code}`,
  );
}

function assertAllocatedToken(
  token: string,
  beforeToken: string | null,
  afterToken: string | null,
  existing: readonly string[],
): void {
  assert.equal(isValidPositionToken(token), true, 'returned token must be a valid position token');
  assert.ok(!existing.includes(token), 'returned token must not be in the existing set');
  if (beforeToken !== null) {
    assert.notEqual(token, beforeToken, 'must not silently return the lower bound');
    assert.ok(token > beforeToken, 'token must be strictly after the exclusive lower bound');
  }
  if (afterToken !== null) {
    assert.notEqual(token, afterToken, 'must not silently return the upper bound');
    assert.ok(token < afterToken, 'token must be strictly before the exclusive upper bound');
  }
}

describe('allocatePosition property gate', () => {
  test('returns a valid open-interval token or escalates explicitly', () => {
    fc.assert(
      fc.property(allocationCaseArb, ({ before, after, existing }) => {
        if (before !== null && after !== null) {
          fc.pre(before < after);
        }
        const observed = observeAllocate(before, after, existing);
        if (!observed.ok) {
          assertExplicitFailure(observed.error);
          return;
        }
        assertAllocatedToken(observed.token, before, after, existing);
      }),
      { numRuns: 80 },
    );
  });

  test('prefix-adjacent bounds stay strictly between or escalate', () => {
    fc.assert(
      fc.property(positionTokenArb, POSITION_CHAR, (prefix, extra) => {
        const after = `${prefix}${extra}`;
        const existing = [prefix, after];
        const observed = observeAllocate(prefix, after, existing);
        if (!observed.ok) {
          assertExplicitFailure(observed.error);
          return;
        }
        assertAllocatedToken(observed.token, prefix, after, existing);
      }),
      { numRuns: 40 },
    );
  });

  test('inverted or equal bounds throw CollectionsError and never return a bound', () => {
    fc.assert(
      fc.property(positionTokenArb, positionTokenArb, fc.array(positionTokenArb, { maxLength: 6 }), (
        left,
        right,
        extras,
      ) => {
        const before = left >= right ? left : right;
        const after = left >= right ? right : left;
        fc.pre(before >= after);
        const existing = [...extras, before, after];
        assert.throws(
          () => allocatePosition(before, after, existing),
          (error: unknown) => {
            if (!(error instanceof CollectionsError)) return false;
            return error.code === 'invalid_node_anchor';
          },
        );
      }),
      { numRuns: 40 },
    );
  });

  test('invalid bound tokens throw CollectionsError instead of minting a token', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', ' ', 'a.b', 'a/b', 'café', 'a b'),
        optionalBoundArb,
        (invalid, other) => {
          assert.throws(
            () => allocatePosition(invalid, other),
            (error: unknown) => {
              if (!(error instanceof CollectionsError)) return false;
              return error.code === 'invalid_node_input';
            },
          );
          assert.throws(
            () => allocatePosition(other, invalid),
            (error: unknown) => {
              if (!(error instanceof CollectionsError)) return false;
              return error.code === 'invalid_node_input';
            },
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});
