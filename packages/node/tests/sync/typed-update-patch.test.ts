import { describe, expect, it } from 'vitest';
import { applySyncTypedUpdatePatch } from '../../src/sync/index.js';

describe('typed domain patch application [C01]', () => {
  it('distinguishes absent, removal and null while preserving unrelated fields', () => {
    const current = { title: 'old', description: 'remove', serverOnly: true };
    const patch = { title: 'new', description: undefined, canonicalUrl: null };
    const result = applySyncTypedUpdatePatch(current, patch);
    expect(result).toEqual({ title: 'new', serverOnly: true, canonicalUrl: null });
    expect(Object.hasOwn(result, 'description')).toBe(false);
    expect(current.description).toBe('remove');
    expect(Object.hasOwn(patch, 'description')).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('detaches nested values and treats prototype-looking keys as data', () => {
    const nested = { values: ['original'] };
    const patch = Object.fromEntries([['__proto__', nested]]);
    const result = applySyncTypedUpdatePatch({}, patch);
    nested.values.push('changed');
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result.__proto__).toEqual({ values: ['original'] });
  });

  it('rejects getters and nested non-JSON values without weakening projection validation', () => {
    let accessed = false;
    const patch = { get description() { accessed = true; return 'unsafe'; } };
    expect(() => applySyncTypedUpdatePatch({}, patch)).toThrow(/data properties/);
    expect(accessed).toBe(false);
    expect(() => applySyncTypedUpdatePatch({}, { nested: { invalid: undefined } })).toThrow(/plain JSON/);
  });
});
