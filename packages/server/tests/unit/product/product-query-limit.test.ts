import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseProductLimit } from '../../../src/transport/product/query-limit.js';

test('product page limits accept one positive decimal and reject coercible alternatives', () => {
  assert.deepEqual(parseProductLimit(undefined, 100), { ok: true, value: undefined });
  assert.deepEqual(parseProductLimit('1', 100), { ok: true, value: 1 });
  assert.deepEqual(parseProductLimit('100', 100), { ok: true, value: 100 });
  for (const invalid of ['0', '01', '1.0', ' 1', '1 ', '1e2', '101', '-1', '', 1, null]) {
    assert.deepEqual(parseProductLimit(invalid, 100), { ok: false }, String(invalid));
  }
  assert.deepEqual(parseProductLimit('3', 2), { ok: false });
});
