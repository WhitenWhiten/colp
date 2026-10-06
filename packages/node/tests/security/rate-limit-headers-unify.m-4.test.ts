import { describe, expect, it } from 'vitest';

import { serializeRateLimitFields } from '../../src/security/index.js';
import type { RateLimitFields } from '../../src/security/index.js';

/**
 * `serializeRateLimitFields` is strict: it rejects negative, non-integer, and
 * out-of-range values instead of clamping them into a plausible header.
 */

const evidence = '[evidence:security.rate-limit-headers-unify]';

type HeaderInput = RateLimitFields;

const serialize = serializeRateLimitFields;

describe(`${evidence} strict RFC 9651 RateLimit field serialization`, () => {
  describe('valid inputs', () => {
    const cases: readonly { readonly label: string; readonly input: HeaderInput; readonly expected: Readonly<Record<string, string>> }[] = [
      {
        label: 'plain policy',
        input: { policy: 'feed', limit: 120, remaining: 83, resetSeconds: 27, windowSeconds: 60 },
        expected: {
          RateLimit: '"feed";r=83;t=27',
          'RateLimit-Policy': '"feed";q=120;w=60',
        },
      },
      {
        label: 'quote and backslash escape',
        input: {
          policy: 'quoted"policy\\tier',
          limit: 10,
          remaining: 8,
          resetSeconds: 2,
          windowSeconds: 60,
        },
        expected: {
          RateLimit: '"quoted\\"policy\\\\tier";r=8;t=2',
          'RateLimit-Policy': '"quoted\\"policy\\\\tier";q=10;w=60',
        },
      },
      {
        label: 'colon-separated policy id',
        input: {
          policy: 'publisher:authenticated-read',
          limit: 10,
          remaining: 4,
          resetSeconds: 9,
          windowSeconds: 60,
        },
        expected: {
          RateLimit: '"publisher:authenticated-read";r=4;t=9',
          'RateLimit-Policy': '"publisher:authenticated-read";q=10;w=60',
        },
      },
      {
        label: 'zero remaining and zero resetSeconds',
        input: { policy: 'p', limit: 1, remaining: 0, resetSeconds: 0, windowSeconds: 1 },
        expected: {
          RateLimit: '"p";r=0;t=0',
          'RateLimit-Policy': '"p";q=1;w=1',
        },
      },
      {
        label: 'remaining equals limit',
        input: { policy: 'full', limit: 5, remaining: 5, resetSeconds: 30, windowSeconds: 60 },
        expected: {
          RateLimit: '"full";r=5;t=30',
          'RateLimit-Policy': '"full";q=5;w=60',
        },
      },
    ];

    it.each(cases)(`${evidence} serializes $label`, ({ input, expected }) => {
      expect(serialize(input)).toEqual(expected);
    });
  });

  describe('negative remaining throws (no clamp to r=0)', () => {
    const input: HeaderInput = {
      policy: 'feed',
      limit: 10,
      remaining: -1,
      resetSeconds: 5,
      windowSeconds: 60,
    };

    it(`${evidence} rejects remaining=-1 with TypeError`, () => {
      expect(() => serialize(input)).toThrow(TypeError);
    });

  });

  describe('negative resetSeconds throws (no clamp to t=0)', () => {
    const input: HeaderInput = {
      policy: 'feed',
      limit: 10,
      remaining: 3,
      resetSeconds: -2,
      windowSeconds: 60,
    };

    it(`${evidence} rejects resetSeconds=-2 with TypeError`, () => {
      expect(() => serialize(input)).toThrow(TypeError);
    });
  });

  describe('remaining > limit throws', () => {
    const input: HeaderInput = {
      policy: 'feed',
      limit: 1,
      remaining: 2,
      resetSeconds: 0,
      windowSeconds: 1,
    };

    it(`${evidence} rejects remaining > limit`, () => {
      expect(() => serialize(input)).toThrow(TypeError);
    });
  });

  describe('non-integer / unsafe integer rejected', () => {
    const valid: HeaderInput = {
      policy: 'p',
      limit: 10,
      remaining: 5,
      resetSeconds: 3,
      windowSeconds: 60,
    };

    const invalidNumeric: readonly { readonly field: keyof HeaderInput; readonly value: number }[] = [
      { field: 'remaining', value: 1.5 },
      { field: 'remaining', value: Number.NaN },
      { field: 'remaining', value: Infinity },
      { field: 'remaining', value: -Infinity },
      { field: 'remaining', value: Number.MAX_SAFE_INTEGER + 1 },
      { field: 'resetSeconds', value: 0.5 },
      { field: 'resetSeconds', value: Number.NaN },
      { field: 'resetSeconds', value: Infinity },
      { field: 'resetSeconds', value: Number.MAX_SAFE_INTEGER + 1 },
      { field: 'limit', value: 0 },
      { field: 'limit', value: -1 },
      { field: 'limit', value: 1.5 },
      { field: 'limit', value: Number.NaN },
      { field: 'limit', value: Number.MAX_SAFE_INTEGER + 1 },
      { field: 'windowSeconds', value: 0 },
      { field: 'windowSeconds', value: 1.5 },
      { field: 'windowSeconds', value: Number.NaN },
      { field: 'windowSeconds', value: Number.MAX_SAFE_INTEGER + 1 },
    ];

    it(`${evidence} rejects non-integer and unsafe numeric fields`, () => {
      for (const { field, value } of invalidNumeric) {
        expect(() => serialize({ ...valid, [field]: value })).toThrow(TypeError);
      }
    });
  });

  describe('valid zero remaining and zero resetSeconds accepted', () => {
    const input: HeaderInput = {
      policy: 'boundary',
      limit: 1,
      remaining: 0,
      resetSeconds: 0,
      windowSeconds: 1,
    };

    it(`${evidence} accepts non-negative zeros`, () => {
      expect(serialize(input)).toEqual({
        RateLimit: '"boundary";r=0;t=0',
        'RateLimit-Policy': '"boundary";q=1;w=1',
      });
    });

  });
});
