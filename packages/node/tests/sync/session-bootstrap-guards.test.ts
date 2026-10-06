import { describe, expect, it } from 'vitest';
import { assertMembers, assertObject, sameData } from '../../src/sync/session-bootstrap-guards.js';

describe('Bootstrap stored-state guards', () => {
  it('accepts plain and null-prototype records while rejecting non-record state', () => {
    expect(() => assertObject({}, 'Session')).not.toThrow();
    expect(() => assertObject(Object.create(null), 'Session')).not.toThrow();
    for (const value of [undefined, null, 1, [], new Date(), Object.create({ inherited: true })]) {
      expect(() => assertObject(value, 'Session')).toThrow(/Session must be a plain object/u);
    }
  });

  it('rejects unknown, symbol, hidden and accessor members without invoking getters', () => {
    const allowed = new Set(['status']);
    expect(() => assertMembers({ status: 'active' }, allowed, 'Session')).not.toThrow();
    for (const value of [{ unknown: true }, { [Symbol('status')]: 'active' }]) {
      expect(() => assertMembers(value, allowed, 'Session')).toThrow(/unknown member/u);
    }
    let reads = 0;
    for (const descriptor of [
      { value: 'active', enumerable: false },
      { get: () => { reads += 1; return 'active'; }, enumerable: true },
    ]) {
      expect(() => assertMembers(Object.defineProperty({}, 'status', descriptor), allowed, 'Session'))
        .toThrow(/enumerable data properties/u);
    }
    expect(reads).toBe(0);
  });

  it('compares complete Session state independently of object key order', () => {
    const expected = { status: 'active', collectionId: null, scopes: ['sync:push', 'sync:pull'] };
    expect(sameData(expected, {
      scopes: ['sync:push', 'sync:pull'], collectionId: null, status: 'active',
    })).toBe(true);
    for (const changed of [
      { ...expected, status: 'terminated' },
      { ...expected, collectionId: 'collection-1' },
      { ...expected, scopes: ['sync:pull', 'sync:push'] },
      { ...expected, scopes: ['sync:push'] },
      { ...expected, scopes: { 0: 'sync:push', 1: 'sync:pull' } },
      { ...expected, leaseGeneration: '2' },
      { status: 'active', collectionId: null, leaseGeneration: '2' },
      null,
      'active',
    ]) expect(sameData(expected, changed)).toBe(false);
    expect(sameData(null, null)).toBe(true);
    expect(sameData(null, expected)).toBe(false);
    expect(sameData('active', 'terminated')).toBe(false);
  });
});
