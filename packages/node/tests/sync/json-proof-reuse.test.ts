import { expect, test } from 'vitest';
import { immutableJsonSnapshot, omitUndefinedJsonProperties, readImmutableJsonProof } from '../../src/shared/immutable-json.js';
import { canonicalJsonSnapshot, encodeCanonicalJson } from '../../src/sync/canonical-json.js';

test('library-owned frozen subtrees cross JSON and canonical boundaries without another copy', () => {
  const frozen = immutableJsonSnapshot({ deep: { child: { value: 1 } }, sibling: { value: 2 } }, 'fixture');
  expect(immutableJsonSnapshot(frozen.sibling, 'sibling', { maxDepth: 1 })).toBe(frozen.sibling);
  expect(canonicalJsonSnapshot(frozen.sibling, 'sibling', { maxDepth: 1 })).toBe(frozen.sibling);
  expect(() => canonicalJsonSnapshot(frozen.deep, 'deep', { maxDepth: 1 })).toThrow(/depth/u);
});

test('reuse preserves the different JSON-member and own-key array budgets', () => {
  const frozen = canonicalJsonSnapshot({ items: [1, 2] }, 'canonical', { maxMembers: 3 });
  expect(() => immutableJsonSnapshot(frozen, 'own keys', { maxMembers: 3 })).toThrow(/member/u);
  expect(immutableJsonSnapshot(frozen, 'own keys', { maxMembers: 4 })).toBe(frozen);
  const own = immutableJsonSnapshot({ items: [1, 2] }, 'own keys', { maxMembers: 4 });
  expect(canonicalJsonSnapshot(own, 'JSON members', { maxMembers: 3 })).toBe(own);
});

test('sanitized snapshots retain exact support when omitted fields had conservative input charges', () => {
  const sanitized = omitUndefinedJsonProperties({ discarded: undefined }, 'optional fields');
  const expected = '{"child":{}}';
  const wrapped = immutableJsonSnapshot({ child: sanitized }, 'wrapped', { maxBytes: expected.length });
  expect(encodeCanonicalJson(wrapped, 'wrapped')).toBe(expected);
  expect(canonicalJsonSnapshot(sanitized, 'empty', { maxBytes: 2 })).toEqual({});
});

test('a caller-frozen container has no proof and cannot retain mutable child aliases', () => {
  const child = { value: 'before' };
  const caller = Object.freeze({ child });
  const frozen = immutableJsonSnapshot(caller, 'caller frozen');
  child.value = 'after';
  expect(frozen.child.value).toBe('before');
  expect(frozen.child).not.toBe(child);
  let calls = 0;
  const getter = Object.freeze(Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1; } }));
  expect(() => immutableJsonSnapshot(getter, 'accessor')).toThrow(/data/u);
  expect(calls).toBe(0);
});

test('repeated proven subtrees are charged at every occurrence in the enclosing budget', () => {
  const child = immutableJsonSnapshot({ text: 'line\n💾' }, 'child');
  const source = { a: child, b: child };
  const bytes = Buffer.byteLength(JSON.stringify(source));
  expect(() => immutableJsonSnapshot(source, 'members', { maxMembers: 3 })).toThrow(/member/u);
  expect(() => canonicalJsonSnapshot(source, 'members', { maxMembers: 3 })).toThrow(/member/u);
  expect(() => immutableJsonSnapshot(source, 'bytes', { maxBytes: bytes - 1 })).toThrow(/byte/u);
  expect(() => canonicalJsonSnapshot(source, 'bytes', { maxBytes: bytes - 1 })).toThrow(/byte/u);
  expect(immutableJsonSnapshot(source, 'exact', { maxBytes: bytes, maxMembers: 4 })).toEqual(source);
});

test('observed subtree budgets are immutable even when their diagnostic proof is read', () => {
  const frozen = immutableJsonSnapshot({ child: { value: 'line\n💾' } }, 'fixture');
  const proof = readImmutableJsonProof(frozen.child)!;
  expect(proof.observedDepth).toBe(1);
  expect(proof.observedBytes).toBe(Buffer.byteLength(JSON.stringify(frozen.child)));
  expect(Object.isFrozen(proof)).toBe(true);
  expect(Reflect.set(proof, 'observedBytes', 0)).toBe(false);
  expect(() => canonicalJsonSnapshot(frozen.child, 'tight byte bound', { maxBytes: 2 })).toThrow(/byte/u);
});
