import { createHmac } from 'node:crypto';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as adapterApi from '../../src/adapters/index.js';
import * as rootApi from '../../src/index.js';
import * as serverApi from '../../src/server/index.js';
import {
  createHmacProfileId,
  createProfileIdHmacKey,
  type HmacProfileIdOptions,
  type ProfileIdHmacKey,
} from '../../src/server/index.js';

const evidence = '[evidence:core.hmac-deterministic-framing]';
const contextText = 'collection-protocol/profile-id/hmac-sha-256/v1';
const wirePattern = /^prf\.h1\.([A-Za-z0-9._~-]{1,77})\.([A-Za-z0-9_-]{43})$/u;
const utf8 = new TextEncoder();

function key(length = 32, seed = 0x41): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed + index * 29) & 0xff);
}

type TestHmacProfileIdOptions = HmacProfileIdOptions & {
  readonly key: ProfileIdHmacKey;
  readonly keyMaterial: Uint8Array;
};

function options(
  overrides: Partial<Omit<TestHmacProfileIdOptions, 'key'>> = {},
): TestHmacProfileIdOptions {
  const keyMaterial = overrides.keyMaterial ?? key();
  return {
    key: createProfileIdHmacKey(keyMaterial),
    keyMaterial,
    keyVersion: 'rotation-7',
    serverScope: 'sync.example.test',
    tenantScope: 'tenant_42',
    ...overrides,
  };
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function unsigned32BigEndian(value: number): Uint8Array {
  return Uint8Array.of(
    Math.floor(value / 0x1_00_00_00) & 0xff,
    Math.floor(value / 0x1_00_00) & 0xff,
    Math.floor(value / 0x1_00) & 0xff,
    value & 0xff,
  );
}

function frame(value: Uint8Array): Uint8Array {
  return join([unsigned32BigEndian(value.byteLength), value]);
}

function localEncoding(localId: string | Uint8Array): {
  readonly tag: number;
  readonly bytes: Uint8Array;
} {
  return typeof localId === 'string'
    ? { tag: 0x01, bytes: utf8.encode(localId.normalize('NFC')) }
    : { tag: 0x02, bytes: localId.slice() };
}

/** Oracle built only from the correction's ordered field and byte rules. */
function oracleTranscript(localId: string | Uint8Array, value: TestHmacProfileIdOptions): Uint8Array {
  const local = localEncoding(localId);
  return join([
    frame(utf8.encode(contextText)),
    frame(utf8.encode(value.keyVersion)),
    frame(utf8.encode(value.serverScope)),
    frame(utf8.encode(value.tenantScope)),
    Uint8Array.of(local.tag),
    frame(local.bytes),
  ]);
}

function oracleProfileId(localId: string | Uint8Array, value: TestHmacProfileIdOptions): string {
  const digest = createHmac('sha256', value.keyMaterial).update(oracleTranscript(localId, value)).digest();
  return `prf.h1.${value.keyVersion}.${digest.toString('base64url')}`;
}

function decodeFrame(
  transcript: Uint8Array,
  offset: number,
): { readonly bytes: Uint8Array; readonly nextOffset: number; readonly lengthPrefix: Uint8Array } {
  const lengthPrefix = transcript.slice(offset, offset + 4);
  const length =
    lengthPrefix[0]! * 0x1_00_00_00 +
    lengthPrefix[1]! * 0x1_00_00 +
    lengthPrefix[2]! * 0x1_00 +
    lengthPrefix[3]!;
  const start = offset + 4;
  return {
    bytes: transcript.slice(start, start + length),
    nextOffset: start + length,
    lengthPrefix,
  };
}

describe(`CORE-0046 deterministic HMAC input framing ${evidence}`, () => {
  it('preserves the published package golden vector', () => {
    const keyMaterial = Uint8Array.from({ length: 32 }, (_, index) => index);
    const keyHandle = createProfileIdHmacKey(keyMaterial);

    expect(createHmacProfileId('Profile/e\u0301/\u7528\u6237', {
      key: keyHandle,
      keyVersion: 'v1',
      serverScope: 'server.example',
      tenantScope: 'tenant-1',
    })).toBe('prf.h1.v1.jPlng8qXDyjhW30apPwPrim8J_5t5gH19VvKFe5KE4U');
  });

  it('matches an independent HMAC oracle over the exact canonical transcript', () => {
    const value = options();
    const localId = 'Profile/e\u0301/\u7528\u6237';

    expect(createHmacProfileId(localId, value)).toBe(oracleProfileId(localId, value));
  });

  it('frames context, version, server, tenant, tag, and local ID in exact order', () => {
    const value = options({ keyVersion: 'v9', serverScope: 'srv', tenantScope: 'acct' });
    const transcript = oracleTranscript(Uint8Array.of(0x00, 0x7f, 0xff), value);
    let offset = 0;
    const expectedFields = [contextText, 'v9', 'srv', 'acct'];

    for (const expected of expectedFields) {
      const decoded = decodeFrame(transcript, offset);
      const expectedBytes = utf8.encode(expected);
      expect(decoded.lengthPrefix).toEqual(unsigned32BigEndian(expectedBytes.byteLength));
      expect(decoded.bytes).toEqual(expectedBytes);
      offset = decoded.nextOffset;
    }
    expect(transcript[offset]).toBe(0x02);
    offset += 1;
    const local = decodeFrame(transcript, offset);
    expect(local.lengthPrefix).toEqual(Uint8Array.of(0x00, 0x00, 0x00, 0x03));
    expect(local.bytes).toEqual(Uint8Array.of(0x00, 0x7f, 0xff));
    expect(local.nextOffset).toBe(transcript.byteLength);
    expect(createHmacProfileId(Uint8Array.of(0x00, 0x7f, 0xff), value)).toBe(
      oracleProfileId(Uint8Array.of(0x00, 0x7f, 0xff), value),
    );
  });

  it('uses unsigned 32-bit big-endian byte lengths rather than code-unit or native-endian lengths', () => {
    expect(unsigned32BigEndian(0x01_02_03_04)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(frame(utf8.encode('\ud83d\ude00')).slice(0, 4)).toEqual(Uint8Array.of(0, 0, 0, 4));
    expect(frame(utf8.encode('\u7528\u6237')).slice(0, 4)).toEqual(Uint8Array.of(0, 0, 0, 6));
  });

  it.each([
    ['key', 'Default', options({ keyMaterial: key(32, 0x42) })],
    ['keyVersion', 'Default', options({ keyVersion: 'rotation-8' })],
    ['serverScope', 'Default', options({ serverScope: 'other.example.test' })],
    ['tenantScope', 'Default', options({ tenantScope: 'tenant_43' })],
    ['localId', 'Profile-1', options()],
  ])('changes the output when only %s changes', (_name, localId, changed) => {
    expect(createHmacProfileId(localId, changed)).not.toBe(
      createHmacProfileId('Default', options()),
    );
    expect(createHmacProfileId(localId, changed)).toBe(oracleProfileId(localId, changed));
  });

  it.each([
    [options({ keyVersion: 'ab', serverScope: 'c' }), options({ keyVersion: 'a', serverScope: 'bc' })],
    [options({ serverScope: 'ab', tenantScope: 'c' }), options({ serverScope: 'a', tenantScope: 'bc' })],
    [options({ tenantScope: 'ab' }), options({ tenantScope: 'a' })],
  ])('separates adjacent fields that have the same naive concatenation', (left, right) => {
    const leftLocal = left.tenantScope === 'ab' ? 'c' : 'Default';
    const rightLocal = right.tenantScope === 'a' ? 'bc' : 'Default';
    const naive = (localId: string, value: HmacProfileIdOptions) =>
      utf8.encode(`${value.keyVersion}${value.serverScope}${value.tenantScope}${localId}`);

    expect(naive(leftLocal, left)).toEqual(naive(rightLocal, right));
    expect(oracleTranscript(leftLocal, left)).not.toEqual(oracleTranscript(rightLocal, right));
    expect(createHmacProfileId(leftLocal, left)).not.toBe(createHmacProfileId(rightLocal, right));
  });

  it('preserves zero bytes without delimiter, truncation, or prefix ambiguity', () => {
    const value = options();
    const cases = [
      Uint8Array.of(0x00),
      Uint8Array.of(0x00, 0x00),
      Uint8Array.of(0x61, 0x00, 0x62),
      Uint8Array.of(0x61, 0x00, 0x62, 0x00),
    ];

    const results = cases.map((localId) => createHmacProfileId(localId, value));
    expect(new Set(results).size).toBe(cases.length);
    cases.forEach((localId, index) => {
      expect(results[index]).toBe(oracleProfileId(localId, value));
    });
  });

  it('uses different tags for identical string UTF-8 and byte payloads', () => {
    const value = options();
    const stringId = '\u00e9/profile';
    const byteId = utf8.encode(stringId);
    const stringTranscript = oracleTranscript(stringId, value);
    const byteTranscript = oracleTranscript(byteId, value);

    expect(stringTranscript.slice(0, -byteId.byteLength - 5)).toEqual(
      byteTranscript.slice(0, -byteId.byteLength - 5),
    );
    expect(stringTranscript[stringTranscript.byteLength - byteId.byteLength - 5]).toBe(0x01);
    expect(byteTranscript[byteTranscript.byteLength - byteId.byteLength - 5]).toBe(0x02);
    expect(createHmacProfileId(stringId, value)).not.toBe(createHmacProfileId(byteId, value));
    expect(createHmacProfileId(stringId, value)).toBe(oracleProfileId(stringId, value));
    expect(createHmacProfileId(byteId, value)).toBe(oracleProfileId(byteId, value));
  });

  it('NFC-normalizes strings before deterministic UTF-8 encoding', () => {
    const composed = '\u00e9/\u7528\u6237';
    const decomposed = 'e\u0301/\u7528\u6237';
    const value = options();

    expect(oracleTranscript(composed, value)).toEqual(oracleTranscript(decomposed, value));
    expect(createHmacProfileId(composed, value)).toBe(createHmacProfileId(decomposed, value));
    expect(createHmacProfileId(decomposed, value)).toBe(oracleProfileId(decomposed, value));
  });

  it.each(['\ud800', '\udfff', 'prefix\ud800', '\ud800suffix'])(
    'rejects malformed UTF-16 instead of replacement-byte encoding: %j',
    (localId) => {
      const replacementEncoding = utf8.encode(localId);
      expect(replacementEncoding).toContain(0xef);
      expect(() => createHmacProfileId(localId, options())).toThrow(TypeError);
    },
  );

  it.each([
    ['minimum key', 'x', options({ keyMaterial: key(32) })],
    ['maximum key', 'x', options({ keyMaterial: key(1024) })],
    ['maximum keyVersion', 'x', options({ keyVersion: 'v'.repeat(77) })],
    ['maximum serverScope', 'x', options({ serverScope: 's'.repeat(128) })],
    ['maximum tenantScope', 'x', options({ tenantScope: 't'.repeat(128) })],
    ['maximum byte local ID', new Uint8Array(4096).fill(0xa5), options()],
    ['maximum UTF-8 string local ID', '\u00e9'.repeat(2048), options()],
  ] as const)('accepts and independently derives the %s boundary', (_label, localId, value) => {
    const result = createHmacProfileId(localId, value);
    expect(result).toBe(oracleProfileId(localId, value));
    expect(result).toMatch(wirePattern);
    expect(result.length).toBeLessThanOrEqual(128);
  });

  it.each([
    ['31-byte key', 'x', () => createProfileIdHmacKey(key(31))],
    ['1025-byte key', 'x', () => createProfileIdHmacKey(key(1025))],
    ['78-byte keyVersion', 'x', options({ keyVersion: 'v'.repeat(78) })],
    ['129-byte serverScope', 'x', options({ serverScope: 's'.repeat(129) })],
    ['129-byte tenantScope', 'x', options({ tenantScope: 't'.repeat(129) })],
    ['4097-byte local ID', new Uint8Array(4097), options()],
    ['4098-byte UTF-8 local ID', '\u00e9'.repeat(2049), options()],
  ] as const)('rejects the first value beyond the %s boundary', (_label, localId, value) => {
    if (typeof value === 'function') expect(value).toThrow();
    else expect(() => createHmacProfileId(localId, value)).toThrow();
  });

  it('is repeatable across fresh keys, copied options, and process-like reconstructed inputs', () => {
    const original = options();
    const copied = {
      ...original,
      keyMaterial: original.keyMaterial.slice(),
      key: createProfileIdHmacKey(original.keyMaterial),
    };
    const reconstructed = options({
      keyMaterial: Uint8Array.from(Array.from(original.keyMaterial)),
      keyVersion: String(original.keyVersion),
      serverScope: String(original.serverScope),
      tenantScope: String(original.tenantScope),
    });

    const expected = oracleProfileId('Default', original);
    expect(createHmacProfileId('Default', original)).toBe(expected);
    expect(createHmacProfileId('Default', original)).toBe(expected);
    expect(createHmacProfileId('Default', copied)).toBe(expected);
    expect(createHmacProfileId('Default', reconstructed)).toBe(expected);
    expect(createHmacProfileId(Uint8Array.from(utf8.encode('Default')), reconstructed)).toBe(
      oracleProfileId(Uint8Array.from(utf8.encode('Default')), reconstructed),
    );
  });

  it('reads each stateful option getter once and keeps the wire and framed versions identical', () => {
    const reads = { key: 0, keyVersion: 0, serverScope: 0, tenantScope: 0 };
    const stable = options();
    const changing = {
      get key() {
        reads.key += 1;
        return reads.key === 1 ? stable.key : createProfileIdHmacKey(key(32, 0xfe));
      },
      get keyVersion() {
        reads.keyVersion += 1;
        return reads.keyVersion === 1 ? stable.keyVersion : 'rotation-999';
      },
      get serverScope() {
        reads.serverScope += 1;
        return reads.serverScope === 1 ? stable.serverScope : 'changed.example';
      },
      get tenantScope() {
        reads.tenantScope += 1;
        return reads.tenantScope === 1 ? stable.tenantScope : 'changed-tenant';
      },
    } satisfies HmacProfileIdOptions;

    const result = createHmacProfileId('Default', changing);
    const match = wirePattern.exec(result);
    expect(result).toBe(oracleProfileId('Default', stable));
    expect(match?.[1]).toBe(stable.keyVersion);
    expect(reads).toEqual({ key: 1, keyVersion: 1, serverScope: 1, tenantScope: 1 });
  });

  it('does not mutate caller-owned key/local buffers or the options object', () => {
    const backingKey = key(40, 0x31);
    const keyView = backingKey.subarray(4, 36);
    const localBacking = Uint8Array.of(9, 8, 0, 7, 6, 5);
    const localView = localBacking.subarray(1, 5);
    const keyBefore = backingKey.slice();
    const localBefore = localBacking.slice();
    const value = Object.freeze(options({ keyMaterial: keyView }));
    const fieldsBefore = { ...value, key: undefined, keyMaterial: undefined };

    expect(createHmacProfileId(localView, value)).toBe(oracleProfileId(localView, value));
    expect(backingKey).toEqual(keyBefore);
    expect(localBacking).toEqual(localBefore);
    expect({ ...value, key: undefined, keyMaterial: undefined }).toEqual(fieldsBefore);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it.each([
    ['empty keyVersion', { keyVersion: '' }],
    ['delimiter in keyVersion', { keyVersion: 'v/1' }],
    ['empty serverScope', { serverScope: '' }],
    ['space in serverScope', { serverScope: 'server one' }],
    ['empty tenantScope', { tenantScope: '' }],
    ['non-ASCII tenantScope', { tenantScope: '\u7528\u6237' }],
  ] as const)('rejects %s before reading later fields into an ambiguous transcript', (_label, override) => {
    let laterReads = 0;
    const baseline = options(override);
    const guarded = {
      get key() {
        laterReads += 1;
        return baseline.key;
      },
      get keyVersion() {
        return baseline.keyVersion;
      },
      get serverScope() {
        if ('keyVersion' in override) laterReads += 1;
        return baseline.serverScope;
      },
      get tenantScope() {
        if ('keyVersion' in override || 'serverScope' in override) laterReads += 1;
        return baseline.tenantScope;
      },
    } satisfies HmacProfileIdOptions;

    expect(() => createHmacProfileId('Default', guarded)).toThrow(TypeError);
    expect(laterReads).toBe(0);
  });

  it.each([
    ['empty string', ''],
    ['control-bearing string', 'a\u0000b'],
    ['empty bytes', new Uint8Array()],
    ['ordinary array', [0x61]],
    ['number', 1],
    ['missing', undefined],
  ])('rejects invalid local input before any ambiguous encoding: %s', (_label, localId) => {
    expect(() =>
      createHmacProfileId(localId as unknown as string | Uint8Array, options()),
    ).toThrow();
  });

  it.each([
    ['ordinary array key', [1, 2, 3]],
    ['string key', 'not-secret-bytes'],
    ['missing key', undefined],
    ['null key', null],
  ])('rejects non-byte key material: %s', (_label, invalidKey) => {
    expect(() => createProfileIdHmacKey(invalidKey as unknown as Uint8Array)).toThrow(TypeError);
  });

  it('embeds the same validated keyVersion that the oracle frames', () => {
    const value = options({ keyVersion: 'release~2026.07_17' });
    const result = createHmacProfileId('Default', value);
    const match = wirePattern.exec(result);
    const transcript = oracleTranscript('Default', value);
    const context = decodeFrame(transcript, 0);
    const version = decodeFrame(transcript, context.nextOffset);

    expect(match?.[1]).toBe(value.keyVersion);
    expect(version.bytes).toEqual(utf8.encode(match?.[1] ?? ''));
    expect(result).toBe(oracleProfileId('Default', value));
  });

  it('publishes the HMAC contract only from the server surface', () => {
    expect(rootApi).not.toHaveProperty('createHmacProfileId');
    expect(rootApi).not.toHaveProperty('createProfileIdHmacKey');
    expect(serverApi.createHmacProfileId).toBe(createHmacProfileId);
    expect(adapterApi).not.toHaveProperty('createHmacProfileId');
    expect(adapterApi).not.toHaveProperty('HmacProfileIdOptions');
    expectTypeOf(createHmacProfileId).parameters.toEqualTypeOf<
      [localId: string | Uint8Array, options: HmacProfileIdOptions]
    >();
    expectTypeOf(createHmacProfileId).returns.toEqualTypeOf<string>();
  });
});
