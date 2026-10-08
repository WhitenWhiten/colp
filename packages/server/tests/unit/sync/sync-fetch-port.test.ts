import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { isFetchForbiddenPort } from '../../support/fetch-port.js';

describe('Fetch forbidden-port test support', () => {
  test('matches the Fetch bad-port denylist used by black-box HTTP fixtures', () => {
    const forbidden = [
      1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
      87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
      139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
      548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1_719, 1_720, 1_723,
      2_049, 3_659, 4_045, 5_060, 5_061, 6_000, 6_565, 6_566, 6_567, 6_568, 6_569,
      6_697, 10_080,
    ];
    assert.equal(forbidden.every(isFetchForbiddenPort), true);
  });

  test('does not reject neighboring ephemeral ports', () => {
    for (const port of [0, 2, 6_564, 6_570, 10_079, 10_081, 49_152, 65_535]) {
      assert.equal(isFetchForbiddenPort(port), false, `port ${port}`);
    }
  });
});
