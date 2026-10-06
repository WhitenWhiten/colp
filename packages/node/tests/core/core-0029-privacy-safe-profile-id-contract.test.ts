import { createHash, createHmac } from 'node:crypto';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as adapterApi from '../../src/adapters/index.js';
import * as rootApi from '../../src/adapters/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import * as serverApi from '../../src/server/index.js';
import {
  createHmacProfileId,
  createProfileIdHmacKey,
  createRandomProfileId,
  type HmacProfileIdOptions,
  type ProfileIdHmacKey,
  type ProfileIdRandomBytes,
  type RandomProfileIdOptions,
} from '../../src/server/index.js';

const evidence = '[evidence:core.privacy-safe-profile-id]';
const randomProfileIdPattern = /^prf\.r1\.[A-Za-z0-9_-]{43}$/u;
const hmacProfileIdPattern = /^prf\.h1\.[A-Za-z0-9._~-]+\.[A-Za-z0-9_-]{43}$/u;
const utf8 = new TextEncoder();

function bytes(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function randomSource(...outputs: readonly Uint8Array[]): {
  readonly randomBytes: ProfileIdRandomBytes;
  readonly requestedLengths: number[];
} {
  const requestedLengths: number[] = [];
  let index = 0;
  return {
    requestedLengths,
    randomBytes: (length) => {
      requestedLengths.push(length);
      const output = outputs[index];
      index += 1;
      if (output === undefined) throw new Error('unexpected entropy request');
      return output;
    },
  };
}

type TestHmacProfileIdOptions = HmacProfileIdOptions & {
  readonly key: ProfileIdHmacKey;
  readonly keyMaterial: Uint8Array;
};

function hmacOptions(
  overrides: Partial<Omit<TestHmacProfileIdOptions, 'key'>> = {},
): TestHmacProfileIdOptions {
  const keyMaterial = overrides.keyMaterial ?? bytes(0xa5);
  return {
    key: createProfileIdHmacKey(keyMaterial),
    keyMaterial,
    keyVersion: 'v1',
    serverScope: 'server.example',
    tenantScope: 'account-42',
    ...overrides,
  };
}

function uint32(value: number): Uint8Array {
  const encoded = new Uint8Array(4);
  new DataView(encoded.buffer).setUint32(0, value, false);
  return encoded;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function frame(value: Uint8Array): readonly Uint8Array[] {
  return [uint32(value.length), value];
}

/** Independent oracle: ordered, unsigned 32-bit byte-length-prefixed fields and a typed local ID. */
function framedInput(localId: string | Uint8Array, options: TestHmacProfileIdOptions): Uint8Array {
  const localKind = typeof localId === 'string' ? 0x01 : 0x02;
  const localBytes =
    typeof localId === 'string' ? utf8.encode(localId.normalize('NFC')) : new Uint8Array(localId);
  return concatenate([
    ...frame(utf8.encode('collection-protocol/profile-id/hmac-sha-256/v1')),
    ...frame(utf8.encode(options.keyVersion)),
    ...frame(utf8.encode(options.serverScope)),
    ...frame(utf8.encode(options.tenantScope)),
    Uint8Array.of(localKind),
    ...frame(localBytes),
  ]);
}

function independentlyDerivedProfileId(
  localId: string | Uint8Array,
  options: TestHmacProfileIdOptions,
): string {
  const digest = createHmac('sha256', options.keyMaterial)
    .update(framedInput(localId, options))
    .digest('base64url');
  return `prf.h1.${options.keyVersion}.${digest}`;
}

function expectWireProfileId(value: string, pattern: RegExp): void {
  expect(value).toMatch(pattern);
  expect(value.length).toBeLessThanOrEqual(128);
  expect(createValidatorRegistry().validate('opaqueId', value)).toEqual({ valid: true, errors: [] });
}

describe(`CORE-0029 privacy-safe profile IDs ${evidence}`, () => {
  describe('random profile IDs', () => {
    it('uses exactly 256 bits from the injectable entropy boundary', () => {
      const source = randomSource(bytes(0x11));

      const profileId = createRandomProfileId({ randomBytes: source.randomBytes });

      expect(source.requestedLengths).toEqual([32]);
      expect(profileId).toBe(`prf.r1.${Buffer.from(bytes(0x11)).toString('base64url')}`);
      expectWireProfileId(profileId, randomProfileIdPattern);
    });

    it('produces distinct wire-valid IDs for two known-distinct entropy blocks', () => {
      const source = randomSource(bytes(0x01), bytes(0x02));

      const first = createRandomProfileId({ randomBytes: source.randomBytes });
      const second = createRandomProfileId({ randomBytes: source.randomBytes });

      expect(first).not.toBe(second);
      expectWireProfileId(first, randomProfileIdPattern);
      expectWireProfileId(second, randomProfileIdPattern);
    });

    it('has no local identifier input that could leak into random mode', () => {
      expectTypeOf(createRandomProfileId).parameter(0).toEqualTypeOf<RandomProfileIdOptions | undefined>();
      expect(createRandomProfileId.length).toBeLessThanOrEqual(1);
      expect(serverApi).not.toHaveProperty('createRandomProfileIdFromLocalId');
    });

    it.each([
      ['31 bytes', new Uint8Array(31)],
      ['33 bytes', new Uint8Array(33)],
      ['ordinary array', Array.from(bytes(0))],
      ['missing result', undefined],
    ])('rejects a malformed entropy-provider result: %s', (_label, output) => {
      const randomBytes = (() => output) as ProfileIdRandomBytes;
      expect(() => createRandomProfileId({ randomBytes })).toThrow(TypeError);
    });

    it('does not mutate the entropy buffer returned by its provider', () => {
      const entropy = Uint8Array.from({ length: 32 }, (_, index) => index);
      const before = entropy.slice();

      createRandomProfileId({ randomBytes: () => entropy });

      expect(entropy).toEqual(before);
    });
  });

  describe('server-keyed HMAC profile IDs', () => {
    it('is deterministic and matches an independently framed HMAC computation', () => {
      const options = hmacOptions();

      expect(createHmacProfileId('Default', options)).toBe(
        independentlyDerivedProfileId('Default', options),
      );
      expect(createHmacProfileId('Default', options)).toBe(createHmacProfileId('Default', options));
      expectWireProfileId(createHmacProfileId('Default', options), hmacProfileIdPattern);

      let reads = 0;
      const changingVersion = {
        ...options,
        get keyVersion() {
          reads += 1;
          return reads === 1 ? 'v1' : 'v2';
        },
      };
      expect(createHmacProfileId('Default', changingVersion)).toBe(
        independentlyDerivedProfileId('Default', options),
      );
      expect(reads).toBe(1);
    });

    it.each([
      ['key', 'Default', hmacOptions({ keyMaterial: bytes(0xa4) })],
      ['server', 'Default', hmacOptions({ serverScope: 'other.example' })],
      ['domain', 'Default', hmacOptions({ tenantScope: 'account-43' })],
      ['version', 'Default', hmacOptions({ keyVersion: 'v2' })],
      ['local input', 'Profile-1', hmacOptions()],
    ])('changes when only the %s changes', (_field, localId, changedOptions) => {
      const baseline = createHmacProfileId('Default', hmacOptions());
      expect(createHmacProfileId(localId, changedOptions)).not.toBe(baseline);
    });

    it.each([
      [hmacOptions({ keyVersion: 'ab', serverScope: 'c' }), hmacOptions({ keyVersion: 'a', serverScope: 'bc' })],
      [hmacOptions({ serverScope: 'ab', tenantScope: 'c' }), hmacOptions({ serverScope: 'a', tenantScope: 'bc' })],
    ])('prevents prefix ambiguity between adjacent scoped fields', (left, right) => {
      const leftRaw = concatenate([
        utf8.encode(left.keyVersion),
        utf8.encode(left.serverScope),
        utf8.encode(left.tenantScope),
      ]);
      const rightRaw = concatenate([
        utf8.encode(right.keyVersion),
        utf8.encode(right.serverScope),
        utf8.encode(right.tenantScope),
      ]);

      expect(leftRaw).toEqual(rightRaw);
      expect(framedInput('Default', left)).not.toEqual(framedInput('Default', right));
      expect(createHmacProfileId('Default', left)).not.toBe(createHmacProfileId('Default', right));
    });

    it('prevents ambiguity between a scope suffix and the local ID prefix', () => {
      const left = hmacOptions({ tenantScope: 'ab' });
      const right = hmacOptions({ tenantScope: 'a' });
      expect(concatenate([utf8.encode(left.tenantScope), utf8.encode('c')])).toEqual(
        concatenate([utf8.encode(right.tenantScope), utf8.encode('bc')]),
      );

      expect(framedInput('c', left)).not.toEqual(framedInput('bc', right));
      expect(createHmacProfileId('c', left)).not.toBe(createHmacProfileId('bc', right));
    });

    it('defines string local IDs as NFC-normalized UTF-8', () => {
      const composed = '\u00e9/\u7528\u6237';
      const decomposed = 'e\u0301/\u7528\u6237';
      const options = hmacOptions();

      expect(createHmacProfileId(composed, options)).toBe(independentlyDerivedProfileId(composed, options));
      expect(createHmacProfileId(decomposed, options)).toBe(independentlyDerivedProfileId(decomposed, options));
      expect(createHmacProfileId(composed, options)).toBe(createHmacProfileId(decomposed, options));
    });

    it('treats byte local IDs exactly and domain-separates them from strings', () => {
      const localBytes = utf8.encode('\u00e9/\u7528\u6237');
      const before = localBytes.slice();
      const options = hmacOptions();

      expect(createHmacProfileId(localBytes, options)).toBe(
        independentlyDerivedProfileId(localBytes, options),
      );
      expect(createHmacProfileId(localBytes, options)).not.toBe(
        createHmacProfileId('\u00e9/\u7528\u6237', options),
      );
      expect(localBytes).toEqual(before);
    });

    it.each(['keyVersion', 'serverScope', 'tenantScope'] as const)(
      'rejects an empty %s',
      (field) => {
        expect(() => createHmacProfileId('Default', hmacOptions({ [field]: '' }))).toThrow();
      },
    );

    it.each(['keyVersion', 'serverScope', 'tenantScope'] as const)(
      'rejects malformed non-string %s input',
      (field) => {
        const options = hmacOptions({
          [field]: new Uint8Array([0x61]),
        } as unknown as Partial<HmacProfileIdOptions>);
        expect(() => createHmacProfileId('Default', options)).toThrow(TypeError);
      },
    );

    it.each([
      ['keyVersion', 'bad/version'],
      ['serverScope', 'server scope'],
      ['tenantScope', '\u7528\u6237'],
      ['serverScope', '\u0000server'],
      ['tenantScope', 'x'.repeat(129)],
    ] as const)('rejects malformed scoped string %s=%j', (field, value) => {
      expect(() => createHmacProfileId('Default', hmacOptions({ [field]: value }))).toThrow();
    });

    it.each([
      ['empty bytes', new Uint8Array()],
      ['31 bytes', new Uint8Array(31)],
      ['oversized bytes', new Uint8Array(1025)],
      ['string', 'server-secret'],
      ['ordinary array', [1, 2, 3]],
      ['missing key', undefined],
    ])('rejects invalid, empty, or undersized key material: %s', (_label, key) => {
      expect(() => createProfileIdHmacKey(key as unknown as Uint8Array)).toThrow();
    });

    it.each([
      ['empty string', ''],
      ['empty bytes', new Uint8Array()],
      ['control character', 'Default\u0000'],
      ['number', 1],
      ['ordinary array', [0x61]],
      ['missing local ID', undefined],
    ])('rejects malformed local input: %s', (_label, localId) => {
      expect(() =>
        createHmacProfileId(localId as unknown as string | Uint8Array, hmacOptions()),
      ).toThrow();
    });

    it.each(['\ud800', '\udfff', 'Default\ud800'])('rejects malformed Unicode input %j', (localId) => {
      expect(() => createHmacProfileId(localId, hmacOptions())).toThrow();
    });

    it('keeps the longest accepted version label within opaqueId limits', () => {
      const maximumWireVersion = 'v'.repeat(77);
      expectWireProfileId(
        createHmacProfileId('Default', hmacOptions({ keyVersion: maximumWireVersion })),
        hmacProfileIdPattern,
      );
      expect(() =>
        createHmacProfileId('Default', hmacOptions({ keyVersion: 'v'.repeat(78) })),
      ).toThrow();
    });

    it('does not mutate the caller-owned key buffer or options object', () => {
      const options = hmacOptions({ keyMaterial: Uint8Array.from({ length: 32 }, (_, index) => index) });
      const beforeKey = options.keyMaterial.slice();
      const beforeFields = { ...options, key: undefined, keyMaterial: undefined };

      createHmacProfileId('Default', options);

      expect(options.keyMaterial).toEqual(beforeKey);
      expect({ ...options, key: undefined, keyMaterial: undefined }).toEqual(beforeFields);
    });

    it('does not equal common raw SHA-256 forms of a low-entropy local ID', () => {
      const localId = 'Default';
      const digest = createHash('sha256').update(localId, 'utf8').digest();
      const profileId = createHmacProfileId(localId, hmacOptions());

      expect(profileId).not.toBe(digest.toString('hex'));
      expect(profileId).not.toBe(digest.toString('base64'));
      expect(profileId).not.toBe(digest.toString('base64url'));
      expect(profileId).not.toContain(digest.toString('base64url'));
      expect(profileId).not.toContain(localId);
    });

    it('exposes no unkeyed profile-hash public API', () => {
      for (const api of [rootApi, adapterApi, serverApi]) {
        expect(api).not.toHaveProperty('hashProfileId');
        expect(api).not.toHaveProperty('createProfileIdHash');
        expect(api).not.toHaveProperty('createHashedProfileId');
      }
    });
  });

  it('publishes real root and server exports with exact callable types', () => {
    expect(serverApi.createRandomProfileId).toBe(createRandomProfileId);
    expect(serverApi.createHmacProfileId).toBe(createHmacProfileId);
    expect(rootApi.createRandomProfileId).toBe(createRandomProfileId);
    expect(rootApi).not.toHaveProperty('createHmacProfileId');
    expect(rootApi).not.toHaveProperty('createProfileIdHmacKey');
    expect(adapterApi.createRandomProfileId).toBe(createRandomProfileId);
    expect(adapterApi).not.toHaveProperty('createHmacProfileId');
    expectTypeOf(createRandomProfileId).returns.toEqualTypeOf<string>();
    expectTypeOf(createHmacProfileId).parameter(0).toEqualTypeOf<string | Uint8Array>();
    expectTypeOf(createHmacProfileId).parameter(1).toEqualTypeOf<HmacProfileIdOptions>();
    expectTypeOf(createHmacProfileId).returns.toEqualTypeOf<string>();
  });
});
