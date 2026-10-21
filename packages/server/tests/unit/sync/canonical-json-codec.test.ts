import assert from 'node:assert/strict';
import { test } from 'vitest';

import { canonicalJson as receiptJson } from '../../../src/modules/commands/application/receipt.js';
import {
  encodeAckResultDigestJson,
  encodeLiteralUndefinedCanonicalJson,
  encodePassthroughCanonicalJson,
  encodeProductStableJson,
  encodeReceiptCanonicalJson,
  encodeThrowingCanonicalJson,
} from '../../../src/modules/canonical-json.js';
import { stableJson as conflictJson } from '../../../src/infrastructure/sync/sync-conflict-json.js';

const nested = {
  Z: 1,
  a: 2,
  nested: { B: true, a: 'é' },
  list: [1, '键', null],
  n: 1.5,
};

test('utf16 and locale profiles keep distinct historical bytes for mixed-case keys', () => {
  const value = { Z: 1, a: 2 };
  assert.equal(
    encodeThrowingCanonicalJson(value, { keyOrder: 'utf16', onInvalid: () => { throw new Error('invalid'); } }),
    '{"Z":1,"a":2}',
  );
  assert.equal(
    encodeThrowingCanonicalJson(value, { keyOrder: 'locale', onInvalid: () => { throw new Error('invalid'); } }),
    '{"a":2,"Z":1}',
  );
  assert.equal(encodePassthroughCanonicalJson(value, 'utf16'), '{"Z":1,"a":2}');
  assert.equal(encodePassthroughCanonicalJson(value, 'locale'), '{"a":2,"Z":1}');
  assert.equal(encodeProductStableJson(value), '{"Z":1,"a":2}');
  assert.equal(encodeReceiptCanonicalJson(value), '{"Z":1,"a":2}');
});

test('nested unicode, arrays, and decimals stay profile-stable', () => {
  assert.equal(
    encodeThrowingCanonicalJson(nested, { keyOrder: 'utf16', onInvalid: () => { throw new Error('invalid'); } }),
    '{"Z":1,"a":2,"list":[1,"键",null],"n":1.5,"nested":{"B":true,"a":"é"}}',
  );
  assert.equal(
    encodeThrowingCanonicalJson(nested, { keyOrder: 'locale', onInvalid: () => { throw new Error('invalid'); } }),
    '{"a":2,"list":[1,"键",null],"n":1.5,"nested":{"a":"é","B":true},"Z":1}',
  );
});

test('ack result digests locale-sort only the top level and keep nested insertion order', () => {
  const encoded = encodeAckResultDigestJson({ Z: { b: 1, a: 2 }, a: 1 });
  assert.equal(encoded, '{"a":1,"Z":{"b":1,"a":2}}');
  assert.notEqual(
    encoded,
    encodeThrowingCanonicalJson({ Z: { b: 1, a: 2 }, a: 1 }, {
      keyOrder: 'locale',
      onInvalid: () => { throw new Error('invalid'); },
    }),
  );
});

test('each caller keeps its own illegal-value policy', () => {
  assert.equal(encodePassthroughCanonicalJson({ a: undefined }, 'utf16'), '{"a":undefined}');
  assert.equal(encodePassthroughCanonicalJson([1, undefined, 3], 'utf16'), '[1,,3]');
  assert.equal(encodeLiteralUndefinedCanonicalJson({ a: undefined }, 'utf16'), '{"a":undefined}');
  assert.equal(encodeLiteralUndefinedCanonicalJson([1, undefined, 3], 'utf16'), '[1,undefined,3]');
  assert.equal(encodeProductStableJson({ a: undefined, list: [1, undefined] }), '{"list":[1,null]}');
  assert.throws(() => encodeProductStableJson({ a: undefined }, 'reject'), /cannot encode undefined/u);
  assert.equal(encodeReceiptCanonicalJson({ a: undefined, Z: 1 }), '{"Z":1}');
  assert.throws(() => encodeReceiptCanonicalJson(Number.NaN), /non-finite numbers/u);
  assert.throws(() => encodeReceiptCanonicalJson(Number.MAX_SAFE_INTEGER + 2), /safe integers/u);
  assert.throws(() => encodeReceiptCanonicalJson('\uD800'), /valid Unicode/u);
  assert.throws(
    () => encodeThrowingCanonicalJson({ a: undefined }, {
      keyOrder: 'utf16',
      onInvalid: () => { throw new TypeError('rejected'); },
    }),
    /rejected/u,
  );
  assert.throws(() => conflictJson({ a: undefined }, () => { throw new TypeError('conflict'); }), /conflict/u);
  assert.equal(receiptJson({ Z: 1, a: 2, skip: undefined }), '{"Z":1,"a":2}');
});
