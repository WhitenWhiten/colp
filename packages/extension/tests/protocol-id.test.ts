import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { isProtocolOpaqueId } from '../src/protocol-id.js';

describe('protocol opaque IDs', () => {
  test('accepts every protocol-safe leading character and the length boundary', () => {
    for (const value of ['-base64url', '_base64url', '.opaque', '~opaque', 'A', 'z'.repeat(128)]) {
      assert.equal(isProtocolOpaqueId(value), true, value);
    }
  });

  test('rejects empty, oversized, colon, whitespace, and non-string values', () => {
    for (const value of ['', 'z'.repeat(129), 'collection:id', ' collection', 'collection ', null, 1]) {
      assert.equal(isProtocolOpaqueId(value), false, String(value));
    }
  });
});
