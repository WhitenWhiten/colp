import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  defaultIdGenerator,
  UuidV7Generator,
  type Clock,
  type IdGenerator,
  type RandomBytes,
  uuidV7,
} from '../../src/server/index.js';

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumUuidTimestamp = 2 ** 48 - 1;

class MutableClock implements Clock {
  milliseconds: number;

  constructor(milliseconds: number) {
    this.milliseconds = milliseconds;
  }

  now(): Date {
    return new Date(this.milliseconds);
  }
}

function constantRandomBytes(byte = 0): RandomBytes {
  return (length) => new Uint8Array(length).fill(byte);
}

function decodeUnixMilliseconds(uuid: string): number {
  return Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16);
}

function expectUuidV7(uuid: string, milliseconds: number): void {
  expect(uuid).toMatch(uuidV7Pattern);
  expect(uuid).toBe(uuid.toLowerCase());
  expect(uuid[14]).toBe('7');
  expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
  expect(decodeUnixMilliseconds(uuid)).toBe(milliseconds);
}

describe('UUIDv7 IdGenerator contract [evidence:core.uuidv7-creation]', () => {
  it('is the public default production IdGenerator', () => {
    const generator: IdGenerator = defaultIdGenerator;
    const before = Date.now();
    const uuid = generator.uuidV7();
    const after = Date.now();

    expect(uuid).toMatch(uuidV7Pattern);
    expect(decodeUnixMilliseconds(uuid)).toBeGreaterThanOrEqual(before);
    expect(decodeUnixMilliseconds(uuid)).toBeLessThanOrEqual(after);
    expect(uuidV7()).toMatch(uuidV7Pattern);
  });

  it('encodes injected Unix-millisecond time and randomness deterministically', () => {
    const timestamp = 0x0123_4567_89ab;
    const randomBytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const generator = new UuidV7Generator({
      clock: new MutableClock(timestamp),
      randomBytes: (length) => {
        expect(length).toBe(10);
        return randomBytes;
      },
    });

    expect(generator.uuidV7()).toBe('01234567-89ab-7001-8203-040506070809');
  });

  it('maps exactly 74 random bits around the fixed version and variant bits', () => {
    const timestamp = 0x0123_4567_89ab;
    const minimum = new UuidV7Generator({
      clock: new MutableClock(timestamp),
      randomBytes: constantRandomBytes(0x00),
    });
    const maximum = new UuidV7Generator({
      clock: new MutableClock(timestamp),
      randomBytes: constantRandomBytes(0xff),
    });

    expect(minimum.uuidV7()).toBe('01234567-89ab-7000-8000-000000000000');
    expect(maximum.uuidV7()).toBe('01234567-89ab-7fff-bfff-ffffffffffff');
  });

  it('increments distinct UUIDs for repeated calls in one millisecond', () => {
    const timestamp = 1_721_234_567_890;
    const generator = new UuidV7Generator({
      clock: new MutableClock(timestamp),
      randomBytes: constantRandomBytes(),
    });
    const first = generator.uuidV7();
    const second = generator.uuidV7();

    expectUuidV7(first, timestamp);
    expectUuidV7(second, timestamp);
    expect(second > first).toBe(true);
  });

  it('carries the counter across rand_b into rand_a without changing fixed bits', () => {
    const generator = new UuidV7Generator({
      clock: new MutableClock(1_000),
      randomBytes: () => Uint8Array.from([0x00, 0x00, 0x3f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    });

    expect(generator.uuidV7()).toBe('00000000-03e8-7000-bfff-ffffffffffff');
    expect(generator.uuidV7()).toBe('00000000-03e8-7001-8000-000000000000');
  });

  it('is unique and lexically monotonic for a high-volume same-millisecond burst', () => {
    const timestamp = 1_721_234_567_890;
    const generator = new UuidV7Generator({
      clock: new MutableClock(timestamp),
      randomBytes: constantRandomBytes(),
    });
    const generated = Array.from({ length: 20_000 }, () => generator.uuidV7());

    expect(new Set(generated).size).toBe(generated.length);
    expect(generated).toEqual([...generated].sort());
    for (const uuid of generated) expectUuidV7(uuid, timestamp);
  });

  it('continues monotonically when the wall clock rolls back', () => {
    const clock = new MutableClock(2_000);
    const generator = new UuidV7Generator({ clock, randomBytes: constantRandomBytes(0x11) });
    const beforeRollback = generator.uuidV7();
    clock.milliseconds = 1_999;
    const afterRollback = generator.uuidV7();

    expect(afterRollback > beforeRollback).toBe(true);
    expectUuidV7(beforeRollback, 2_000);
    expectUuidV7(afterRollback, 2_000);
  });

  it('tracks adjacent millisecond boundaries and preserves lexical order', () => {
    const clock = new MutableClock(0x0000_ffff_ffff);
    const generator = new UuidV7Generator({ clock, randomBytes: constantRandomBytes(0xff) });
    const beforeBoundary = generator.uuidV7();
    clock.milliseconds += 1;
    const afterBoundary = generator.uuidV7();

    expectUuidV7(beforeBoundary, 0x0000_ffff_ffff);
    expectUuidV7(afterBoundary, 0x0001_0000_0000);
    expect(afterBoundary > beforeBoundary).toBe(true);
  });

  it('advances the logical millisecond when the 74-bit tail is exhausted', () => {
    const timestamp = 10_000;
    const generator = new UuidV7Generator({
      clock: new MutableClock(timestamp),
      randomBytes: constantRandomBytes(0xff),
    });
    const exhaustedTail = generator.uuidV7();
    const advanced = generator.uuidV7();

    expect(exhaustedTail).toBe('00000000-2710-7fff-bfff-ffffffffffff');
    expectUuidV7(advanced, timestamp + 1);
    expect(advanced > exhaustedTail).toBe(true);
  });

  it('throws rather than wrapping an exhausted tail at the maximum timestamp', () => {
    const generator = new UuidV7Generator({
      clock: new MutableClock(maximumUuidTimestamp),
      randomBytes: constantRandomBytes(0xff),
    });

    expectUuidV7(generator.uuidV7(), maximumUuidTimestamp);
    expect(() => generator.uuidV7()).toThrow(RangeError);
  });

  it('supports the maximum 48-bit timestamp and rejects timestamps outside the field', () => {
    const clock = new MutableClock(maximumUuidTimestamp);
    const generator = new UuidV7Generator({ clock, randomBytes: constantRandomBytes() });

    expectUuidV7(generator.uuidV7(), maximumUuidTimestamp);

    for (const invalidTimestamp of [-1, 2 ** 48]) {
      expect(() =>
        new UuidV7Generator({
          clock: new MutableClock(invalidTimestamp),
          randomBytes: constantRandomBytes(),
        }).uuidV7(),
      ).toThrow(RangeError);
    }
  });

  it('rejects invalid clock outputs instead of emitting a fallback ID', () => {
    const fractionalDate = new Date(1_000);
    fractionalDate.getTime = () => 1_000.5;
    for (const value of [new Date(Number.NaN), fractionalDate, 1_000, undefined]) {
      const clock = { now: () => value } as unknown as Clock;
      const generator = new UuidV7Generator({ clock, randomBytes: constantRandomBytes() });

      expect(() => generator.uuidV7()).toThrow();
    }
  });

  it('rejects malformed random dependency outputs instead of weakening UUID entropy', () => {
    const invalidOutputs: unknown[] = [
      new Uint8Array(9),
      new Uint8Array(11),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      undefined,
    ];

    for (const output of invalidOutputs) {
      const generator = new UuidV7Generator({
        clock: new MutableClock(1_000),
        randomBytes: (() => output) as RandomBytes,
      });
      expect(() => generator.uuidV7()).toThrow();
    }
  });

  it('does not corrupt generator state when fresh entropy acquisition fails', () => {
    const clock = new MutableClock(1_000);
    let calls = 0;
    const generator = new UuidV7Generator({
      clock,
      randomBytes: ((length: number) => {
        calls += 1;
        return calls === 2 ? new Uint8Array(length - 1) : new Uint8Array(length);
      }) as RandomBytes,
    });
    const first = generator.uuidV7();
    clock.milliseconds = 1_001;

    expect(() => generator.uuidV7()).toThrow(TypeError);
    expect(generator.uuidV7()).toBe('00000000-03e9-7000-8000-000000000000');
    expect(first).toBe('00000000-03e8-7000-8000-000000000000');
  });

  it('retries the same logical millisecond after entropy failure at tail exhaustion', () => {
    let calls = 0;
    const generator = new UuidV7Generator({
      clock: new MutableClock(2_000),
      randomBytes: ((length: number) => {
        calls += 1;
        if (calls === 1) return new Uint8Array(length).fill(0xff);
        if (calls === 2) return new Uint8Array(length - 1);
        return new Uint8Array(length);
      }) as RandomBytes,
    });
    const exhaustedTail = generator.uuidV7();

    expect(() => generator.uuidV7()).toThrow(TypeError);
    const retried = generator.uuidV7();
    expectUuidV7(retried, 2_001);
    expect(retried > exhaustedTail).toBe(true);
  });

  it('keeps generated UUIDv7 values compatible with the shared opaque wire-ID validator', () => {
    const uuid = new UuidV7Generator({
      clock: new MutableClock(1_721_234_567_890),
      randomBytes: constantRandomBytes(0x5a),
    }).uuidV7();
    const validators = createValidatorRegistry();

    expect(validators.validate('opaqueId', uuid)).toEqual({ valid: true, errors: [] });
    expect(validators.validate('opaqueId', 'legacy-id_1~local')).toEqual({ valid: true, errors: [] });
  });
});
