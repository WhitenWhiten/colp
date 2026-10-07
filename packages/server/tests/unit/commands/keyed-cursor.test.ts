/**
 * Focused contract for the shared keyed cursor codec (HMAC-SHA256 product
 * variant, prefixed HMAC, and AES-256-GCM). Domain cursor files stay thin
 * wrappers; this suite pins sign/verify/rotate/expiry/wrong-key and
 * seal/decrypt/tamper without changing wire formats.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createKeyedCursorCodec,
  recordWithExactKeys,
} from '../../../src/modules/commands/index.js';

class TestCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() {
    super('invalid cursor');
    this.name = 'TestCursorError';
  }
}

const TTL_MS = 15 * 60 * 1000;
const NOW = new Date('2026-08-24T09:00:00.000Z');
const ISSUED = NOW.toISOString();
const EXPIRES = new Date(NOW.getTime() + TTL_MS).toISOString();
const HMAC_CURRENT = { id: 'hmac-v1', key: 'hmac-current-key-16' };
const HMAC_PREVIOUS = { id: 'hmac-v0', key: 'hmac-previous-key-16' };
const AES_CURRENT = { id: 'aes-v1', secret: Buffer.alloc(32, 11).toString('base64') };
const AES_OTHER = { id: 'aes-v2', secret: Buffer.alloc(32, 22).toString('base64') };

interface TestPayload {
  readonly purpose: 'test.cursor.v1';
  readonly n: number;
  readonly keyVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const PAYLOAD_KEYS = ['expiresAt', 'issuedAt', 'keyVersion', 'n', 'purpose'] as const;

function validate(value: unknown): TestPayload {
  if (
    !recordWithExactKeys(value, PAYLOAD_KEYS)
    || value.purpose !== 'test.cursor.v1'
    || !Number.isInteger(value.n)
    || typeof value.keyVersion !== 'string'
    || typeof value.issuedAt !== 'string'
    || typeof value.expiresAt !== 'string'
  ) {
    throw new Error();
  }
  return value as TestPayload;
}

function unsigned(n = 1): Omit<TestPayload, 'keyVersion'> {
  return {
    purpose: 'test.cursor.v1',
    n,
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
  };
}

function hmacCodec(keys: {
  readonly current: { readonly id: string; readonly key: string };
  readonly previous?: readonly {
    readonly id: string;
    readonly key: string;
    readonly lastIssuedAt: string;
    readonly retainUntil: string;
  }[];
}) {
  return createKeyedCursorCodec<TestPayload>({
    mode: 'hmac-sha256',
    hmac: { variant: 'product' },
    ttlMs: TTL_MS,
    keys,
    invalid: () => new TestCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid test cursor key',
      tooManyKeys: 'test cursor supports at most 8 previous keys',
      uniqueKeys: 'test cursor keys must be unique',
      retention: 'test previous key retention must cover cursor TTL',
    },
  });
}

function aesCodec(keys: {
  readonly current: { readonly id: string; readonly secret: string };
  readonly previous?: readonly {
    readonly id: string;
    readonly secret: string;
    readonly lastIssuedAt: string;
    readonly retainUntil: string;
  }[];
}) {
  return createKeyedCursorCodec<TestPayload>({
    mode: 'aes-256-gcm',
    purpose: 'test.cursor.v1',
    prefix: 'tcur1',
    hkdfSalt: 'known/test/cursor/v1',
    ttlMs: TTL_MS,
    keys,
    invalid: () => new TestCursorError(),
    validate,
    messages: {
      invalidKey: 'invalid test AES cursor key',
      canonicalSecret: 'test AES cursor key must be canonical base64 and at least 32 bytes',
      tooManyKeys: 'test AES cursor supports at most 8 retained keys',
      uniqueKeys: 'test AES cursor key ids and material must be unique',
      retention: 'test AES cursor retained key lifetime must cover cursor TTL',
    },
  });
}

test('HMAC-SHA256 product signs and verifies the current key', () => {
  const codec = hmacCodec({ current: HMAC_CURRENT });
  try {
    const token = codec.sign(unsigned());
    const parts = token.split('.');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], HMAC_CURRENT.id);
    const payload = codec.verify(token, new Date(NOW.getTime() + 1_000));
    assert.equal(payload.keyVersion, HMAC_CURRENT.id);
    assert.equal(payload.n, 1);
    assert.equal(payload.purpose, 'test.cursor.v1');
  } finally {
    codec.destroy();
  }
});

test('HMAC-SHA256 product verifies a rotated previous key and rejects the wrong key', () => {
  const old = hmacCodec({ current: HMAC_PREVIOUS });
  const token = old.sign(unsigned(2));
  old.destroy();

  const rotated = hmacCodec({
    current: HMAC_CURRENT,
    previous: [{
      ...HMAC_PREVIOUS,
      lastIssuedAt: ISSUED,
      retainUntil: EXPIRES,
    }],
  });
  try {
    const payload = rotated.verify(token, new Date(NOW.getTime() + 1_000));
    assert.equal(payload.keyVersion, HMAC_PREVIOUS.id);
    assert.equal(payload.n, 2);

    const other = hmacCodec({ current: { id: 'hmac-v9', key: 'hmac-other-key-16xx' } });
    try {
      assert.throws(() => other.verify(token, new Date(NOW.getTime() + 1_000)), {
        name: 'TestCursorError',
        code: 'invalid_cursor',
      });
    } finally {
      other.destroy();
    }
  } finally {
    rotated.destroy();
  }
});

test('HMAC-SHA256 product rejects an expired token', () => {
  const codec = hmacCodec({ current: HMAC_CURRENT });
  try {
    const token = codec.sign(unsigned());
    assert.throws(() => codec.verify(token, new Date(NOW.getTime() + TTL_MS)), {
      name: 'TestCursorError',
      code: 'invalid_cursor',
    });
  } finally {
    codec.destroy();
  }
});

test('HMAC-SHA256 prefixed signs ppc1.keyId.body.mac and verifies a rotated key', () => {
  const currentSecret = Buffer.alloc(32, 47).toString('base64');
  const previousSecret = Buffer.alloc(32, 31).toString('base64');
  const payload = { limit: 100, nextPosition: 'next' };
  const codec = createKeyedCursorCodec<typeof payload>({
    mode: 'hmac-sha256',
    hmac: {
      variant: 'prefixed',
      prefix: 'ppc1',
      encoding: 'ascii',
      hkdfSalt: 'known/publication/cursor/v1',
      purpose: 'product-public-page',
    },
    keys: { current: { id: 'current', secret: currentSecret } },
    invalid: () => new TestCursorError(),
    validate: (value) => {
      if (
        !recordWithExactKeys(value, ['limit', 'nextPosition'])
        || value.limit !== 100
        || typeof value.nextPosition !== 'string'
      ) throw new Error();
      return value as typeof payload;
    },
    messages: {
      invalidKey: 'invalid prefixed cursor key',
      canonicalSecret: 'prefixed cursor key must be canonical base64 and at least 32 bytes',
      uniqueKeys: 'prefixed cursor keys must be unique',
    },
  });
  try {
    const token = codec.sign(payload);
    const parts = token.split('.');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'ppc1');
    assert.equal(parts[1], 'current');
    const derived = Buffer.from(hkdfSync(
      'sha256',
      Buffer.from(currentSecret, 'base64'),
      Buffer.from('known/publication/cursor/v1'),
      Buffer.from('product-public-page'),
      32,
    ));
    const signed = `${parts[0]}.${parts[1]}.${parts[2]}`;
    assert.equal(parts[3], createHmac('sha256', derived).update(signed, 'ascii').digest('base64url'));
    assert.deepEqual(codec.verify(token, NOW), payload);
  } finally {
    codec.destroy();
  }

  const old = createKeyedCursorCodec<typeof payload>({
    mode: 'hmac-sha256',
    hmac: {
      variant: 'prefixed',
      prefix: 'ppc1',
      encoding: 'ascii',
      hkdfSalt: 'known/publication/cursor/v1',
      purpose: 'product-public-page',
    },
    keys: { current: { id: 'old', secret: previousSecret } },
    invalid: () => new TestCursorError(),
    validate: (value) => value as typeof payload,
    messages: {
      invalidKey: 'invalid prefixed cursor key',
      canonicalSecret: 'prefixed cursor key must be canonical base64 and at least 32 bytes',
      uniqueKeys: 'prefixed cursor keys must be unique',
    },
  });
  const previousToken = old.sign(payload);
  old.destroy();
  const rotated = createKeyedCursorCodec<typeof payload>({
    mode: 'hmac-sha256',
    hmac: {
      variant: 'prefixed',
      prefix: 'ppc1',
      encoding: 'ascii',
      hkdfSalt: 'known/publication/cursor/v1',
      purpose: 'product-public-page',
    },
    keys: {
      current: { id: 'current', secret: currentSecret },
      previous: [{ id: 'old', secret: previousSecret }],
    },
    invalid: () => new TestCursorError(),
    validate: (value) => value as typeof payload,
    messages: {
      invalidKey: 'invalid prefixed cursor key',
      canonicalSecret: 'prefixed cursor key must be canonical base64 and at least 32 bytes',
      uniqueKeys: 'prefixed cursor keys must be unique',
    },
  });
  try {
    assert.deepEqual(rotated.verify(previousToken, NOW), payload);
  } finally {
    rotated.destroy();
  }
});

test('AES-256-GCM seals and verifies; tamper and wrong key stay invalid', () => {
  const codec = aesCodec({ current: AES_CURRENT });
  try {
    const token = codec.seal(unsigned(3));
    const parts = token.split('.');
    assert.equal(parts.length, 5);
    assert.equal(parts[0], 'tcur1');
    assert.equal(parts[1], AES_CURRENT.id);
    const payload = codec.verify(token, new Date(NOW.getTime() + 1_000));
    assert.equal(payload.n, 3);
    assert.equal(payload.keyVersion, AES_CURRENT.id);

    const ciphertext = parts[3]!;
    const flipped = ciphertext[0] === 'A' ? 'B' : 'A';
    const tampered = [parts[0], parts[1], parts[2], `${flipped}${ciphertext.slice(1)}`, parts[4]].join('.');
    assert.throws(() => codec.verify(tampered, new Date(NOW.getTime() + 1_000)), {
      name: 'TestCursorError',
      code: 'invalid_cursor',
    });

    const other = aesCodec({ current: AES_OTHER });
    try {
      assert.throws(() => other.verify(token, new Date(NOW.getTime() + 1_000)), {
        name: 'TestCursorError',
        code: 'invalid_cursor',
      });
    } finally {
      other.destroy();
    }
  } finally {
    codec.destroy();
  }
});
