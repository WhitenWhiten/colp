import assert from 'node:assert/strict';
import { test } from 'vitest';
import { stableJson } from '../../../src/infrastructure/sync/product-sync-stable-json.js';

test('response bodies omit undefined members and encode undefined array entries as null', () => {
  const encoded = stableJson({ a: undefined, b: 1, list: [1, undefined, 3], nested: { gone: undefined, kept: 'x' } });
  assert.equal(encoded, '{"b":1,"list":[1,null,3],"nested":{"kept":"x"}}');
  assert.doesNotThrow(() => JSON.parse(encoded));
  // Same bytes as JSON.stringify once undefined is removed / nulled.
  assert.equal(encoded, JSON.stringify({ b: 1, list: [1, null, 3], nested: { kept: 'x' } }));
});

test('legal values keep the historical sorted, whitespace-free encoding', () => {
  assert.equal(stableJson({ b: 2, a: [3, 'x'], c: { z: false, y: null } }), '{"a":[3,"x"],"b":2,"c":{"y":null,"z":false}}');
  assert.equal(stableJson({ v: 1, p: 'product-sync-conflicts', exp: 123, createdAt: '2026-10-19T00:00:00.000Z', id: 'a', limit: 50 }),
    '{"createdAt":"2026-10-19T00:00:00.000Z","exp":123,"id":"a","limit":50,"p":"product-sync-conflicts","v":1}');
});

test('signed payloads reject undefined instead of silently changing the payload', () => {
  assert.throws(() => stableJson({ id: 'a', missing: undefined }, 'reject'), /cannot encode undefined/u);
  assert.throws(() => stableJson({ list: [1, undefined] }, 'reject'), /cannot encode undefined/u);
  assert.throws(() => stableJson(undefined, 'reject'), /top-level undefined/u);
  assert.throws(() => stableJson(undefined, 'omit'), /top-level undefined/u);
  assert.equal(stableJson({ id: 'a', limit: 10 }, 'reject'), '{"id":"a","limit":10}');
});
