import { describe, expect, it } from 'vitest';

import {
  exactLifecycleObject,
  lifecycleInstant,
  lifecycleNonEmpty,
  lifecycleOrdinal,
  MAX_LIFECYCLE_ORDINAL_DIGITS,
} from '../../src/sync/replica-lifecycle-parsing.js';

describe('replica lifecycle shared parsing', () => {
  it('accepts exact enumerable data objects and rejects shape drift', () => {
    const value = Object.freeze({ id: 'replica-1' });
    expect(exactLifecycleObject(value, new Set(['id']), 'Replica')).toBe(value);
    expect(() => exactLifecycleObject({ id: 'replica-1', extra: true }, new Set(['id']), 'Replica'))
      .toThrow(/unknown member/u);
    const accessor = Object.defineProperty({}, 'id', { enumerable: true, get: () => 'replica-1' });
    expect(() => exactLifecycleObject(accessor, new Set(['id']), 'Replica'))
      .toThrow(/enumerable data properties/u);
  });

  it('parses non-empty values, RFC 3339 instants, and canonical ordinals', () => {
    expect(lifecycleNonEmpty('replica-1', 'Replica ID')).toBe('replica-1');
    expect(lifecycleInstant('2026-07-22T00:00:00Z', 'Instant')).toEqual({
      wire: '2026-07-22T00:00:00Z',
      order: Date.parse('2026-07-22T00:00:00Z'),
    });
    expect(lifecycleOrdinal('42', 'Ordinal')).toEqual({ wire: '42', order: 42n });
  });

  it('rejects unknown offsets, non-canonical ordinals, and empty text', () => {
    expect(() => lifecycleInstant('2026-07-22T00:00:00-00:00', 'Instant')).toThrow(/known offset/u);
    expect(() => lifecycleOrdinal('01', 'Ordinal')).toThrow(/canonical/u);
    expect(() => lifecycleOrdinal('1'.repeat(MAX_LIFECYCLE_ORDINAL_DIGITS + 1), 'Ordinal'))
      .toThrow(/at most/u);
    expect(() => lifecycleNonEmpty('   ', 'Replica ID')).toThrow(/non-empty/u);
  });
});
