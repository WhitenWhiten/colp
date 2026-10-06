import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decodeCanonicalBase64Url,
  updateFrame,
  updateInteger,
  updateOptionalFrame,
  updateOptionalInteger,
} from '../../src/server/cursor-hmac-primitives.js';

/** Hermetic test key material only — not a production secret. */
const TEST_KEY = Buffer.from('cursor-hmac-primitives-test-key-32b', 'utf8');

function digestWith(build: (mac: ReturnType<typeof createHmac>) => void): Buffer {
  const mac = createHmac('sha256', TEST_KEY);
  build(mac);
  return mac.digest();
}

describe('cursor HMAC framing primitives', () => {
  describe('decodeCanonicalBase64Url', () => {
    it('accepts canonical base64url and round-trips bytes', () => {
      const payload = Buffer.from('hello-cursor', 'utf8');
      const encoded = payload.toString('base64url');
      expect(encoded).not.toContain('=');
      expect(encoded).not.toMatch(/[+\/]/u);

      const decoded = decodeCanonicalBase64Url(encoded);
      expect(decoded).toBeInstanceOf(Buffer);
      expect(decoded!.equals(payload)).toBe(true);
      expect(decoded!.toString('base64url')).toBe(encoded);
    });

    it('accepts empty canonical base64url', () => {
      const decoded = decodeCanonicalBase64Url('');
      expect(decoded).toBeInstanceOf(Buffer);
      expect(decoded!.length).toBe(0);
    });

    it('rejects non-canonical base64url with padding', () => {
      // Node base64url decode accepts padding, but re-encode drops it → non-canonical.
      const padded = Buffer.from('hello', 'utf8').toString('base64url') + '=';
      expect(padded.endsWith('=')).toBe(true);
      expect(decodeCanonicalBase64Url(padded)).toBeUndefined();
    });

    it('rejects non-canonical standard base64 alphabet (+/)', () => {
      // 0xff 0xef encodes as "/+8" in standard base64; base64url uses "_-".
      const standard = Buffer.from([0xff, 0xef]).toString('base64');
      expect(standard).toMatch(/[+\/]/u);
      expect(decodeCanonicalBase64Url(standard)).toBeUndefined();
    });

    it('rejects wrong expectedBytes length', () => {
      const encoded = Buffer.alloc(32, 0xab).toString('base64url');
      expect(decodeCanonicalBase64Url(encoded, 32)).toBeInstanceOf(Buffer);
      expect(decodeCanonicalBase64Url(encoded, 31)).toBeUndefined();
      expect(decodeCanonicalBase64Url(encoded, 33)).toBeUndefined();
      expect(decodeCanonicalBase64Url(encoded, 0)).toBeUndefined();
    });

    it('returns undefined rather than throwing on garbage', () => {
      const garbage = [
        '!!!not-base64!!!',
        'abc\ndef',
        'with space',
        '\u0000',
        '===',
        'a', // incomplete group that may still decode; non-canonical if re-encode differs
      ] as const;

      for (const value of garbage) {
        expect(() => decodeCanonicalBase64Url(value)).not.toThrow();
        // Either undefined or a successful canonical decode — never throw.
        const result = decodeCanonicalBase64Url(value);
        if (result !== undefined) {
          expect(result.toString('base64url')).toBe(value);
        }
      }

      // Clearly non-canonical / invalid inputs must be undefined.
      expect(decodeCanonicalBase64Url('!!!not-base64!!!')).toBeUndefined();
      expect(decodeCanonicalBase64Url('with space')).toBeUndefined();
    });
  });

  describe('updateFrame + updateInteger domain separation', () => {
    it('length-prefix framing separates same concatenated frame payloads', () => {
      // Concatenated content is "abc" in both cases; framing boundaries differ.
      const left = digestWith((mac) => {
        updateFrame(mac, Buffer.from('ab', 'utf8'));
        updateFrame(mac, Buffer.from('c', 'utf8'));
      });
      const right = digestWith((mac) => {
        updateFrame(mac, Buffer.from('a', 'utf8'));
        updateFrame(mac, Buffer.from('bc', 'utf8'));
      });

      expect(left.equals(right)).toBe(false);
    });

    it('length-prefix framing separates empty vs non-empty frames with same suffix', () => {
      const emptyThenX = digestWith((mac) => {
        updateFrame(mac, Buffer.alloc(0));
        updateFrame(mac, Buffer.from('x', 'utf8'));
      });
      const justX = digestWith((mac) => {
        updateFrame(mac, Buffer.from('x', 'utf8'));
      });

      expect(emptyThenX.equals(justX)).toBe(false);
    });

    it('updateInteger contributes fixed-width big-endian framing into the MAC', () => {
      const zero = digestWith((mac) => {
        updateInteger(mac, 0);
      });
      const one = digestWith((mac) => {
        updateInteger(mac, 1);
      });
      const large = digestWith((mac) => {
        updateInteger(mac, Number.MAX_SAFE_INTEGER);
      });

      expect(zero.equals(one)).toBe(false);
      expect(one.equals(large)).toBe(false);
      expect(zero.equals(large)).toBe(false);
    });

    it('frame then integer vs integer then frame differ even when byte streams collide without prefixes', () => {
      // Without length prefixes, int(0x61626364) and frame("abcd") could collide on payload
      // bytes alone; framing + integer width keep domains separate.
      const frameThenInt = digestWith((mac) => {
        updateFrame(mac, Buffer.from([0x00, 0x00, 0x00, 0x01]));
        updateInteger(mac, 1);
      });
      const intThenFrame = digestWith((mac) => {
        updateInteger(mac, 1);
        updateFrame(mac, Buffer.from([0x00, 0x00, 0x00, 0x01]));
      });

      expect(frameThenInt.equals(intThenFrame)).toBe(false);
    });
  });

  describe('updateOptionalFrame / updateOptionalInteger', () => {
    it('undefined vs present frame changes the MAC', () => {
      const absent = digestWith((mac) => {
        updateOptionalFrame(mac, undefined);
      });
      const present = digestWith((mac) => {
        updateOptionalFrame(mac, Buffer.from('root', 'utf8'));
      });
      const presentEmpty = digestWith((mac) => {
        updateOptionalFrame(mac, Buffer.alloc(0));
      });

      expect(absent.equals(present)).toBe(false);
      expect(absent.equals(presentEmpty)).toBe(false);
      expect(present.equals(presentEmpty)).toBe(false);
    });

    it('undefined vs present integer changes the MAC', () => {
      const absent = digestWith((mac) => {
        updateOptionalInteger(mac, undefined);
      });
      const presentZero = digestWith((mac) => {
        updateOptionalInteger(mac, 0);
      });
      const presentOne = digestWith((mac) => {
        updateOptionalInteger(mac, 1);
      });

      expect(absent.equals(presentZero)).toBe(false);
      expect(absent.equals(presentOne)).toBe(false);
      expect(presentZero.equals(presentOne)).toBe(false);
    });

    it('optional presence bit is domain-separated from a bare frame of the same payload', () => {
      const optional = digestWith((mac) => {
        updateOptionalFrame(mac, Buffer.from('x', 'utf8'));
      });
      const bare = digestWith((mac) => {
        updateFrame(mac, Buffer.from('x', 'utf8'));
      });

      expect(optional.equals(bare)).toBe(false);
    });
  });
});
