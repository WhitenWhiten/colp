import { describe, expect, it } from 'vitest';

import { hasWellFormedUtf16 } from '../../src/shared/utf16.js';

describe('hasWellFormedUtf16', () => {
  describe('accepts well-formed strings', () => {
    it.each([
      ['empty string', ''],
      ['ASCII', 'hello'],
      ['BMP text', 'café — 中文'],
      ['emoji via literal', 'a😀b'],
      ['emoji via surrogate pair escapes', 'a\uD83D\uDE00b'],
      ['lone supplementary pair', '\uD83D\uDE00'],
      ['mixed BMP + non-BMP', 'A\uD83D\uDE00\uD801\uDC37Z notes'],
      ['multiple valid pairs', '\uD83D\uDE00\uD83D\uDE01'],
    ] as const)('%s', (_label, value) => {
      expect(hasWellFormedUtf16(value)).toBe(true);
    });
  });

  describe('rejects lone and unpaired surrogates', () => {
    it.each([
      // high surrogate alone
      ['high alone', '\uD800'],
      ['high after text', 'a\uD800'],
      ['high before text', '\uD800b'],
      ['high in middle', 'a\uD800b'],
      // low surrogate alone
      ['low alone', '\uDC00'],
      ['low after text', 'a\uDC00'],
      ['low before text', '\uDC00b'],
      ['low in middle', 'a\uDC00b'],
      // high not followed by low
      ['two highs', '\uD800\uD800'],
      ['high then BMP', '\uD800a'],
      ['high then high mid-string', 'x\uD800\uD800y'],
      // truncated pair at end
      ['truncated high at end', 'hello\uD800'],
      ['truncated max high at end', 'ok\uDBFF'],
      // unpaired low after valid pair / other edges
      ['valid pair then lone low', '\uD83D\uDE00\uDC00'],
      ['lone high then valid pair', '\uD800\uD83D\uDE00'],
      ['max low alone', '\uDFFF'],
      ['max high alone', '\uDBFF'],
    ] as const)('%s: %j', (_label, value) => {
      expect(hasWellFormedUtf16(value)).toBe(false);
    });
  });
});
