import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, test } from 'vitest';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import {
  IdentityError,
  assertAvatarImage,
  avatarUploadBodyFingerprint,
  readAvatarBodyCapped,
  uploadAvatar as commitAvatarUpload,
  prepareAvatarUpload,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
  createTestSessionRotationSecrets,
  type AvatarObjectStore,
  type IdentityPorts,
} from '../../../src/modules/identity/index.js';
import type { Account, AccountIdentity, Profile, ProfileHandle } from '../../../src/modules/identity/index.js';
import {
  createMemoryProductCommandReceiptPort,
  productCommandReceiptKey,
  type MemoryProductCommandReceiptRow,
} from '../../support/product-http-harness.js';

async function uploadAvatar(ports: IdentityPorts & { avatars: AvatarObjectStore }, input: Omit<Parameters<typeof commitAvatarUpload>[1], 'preparedAvatarId'>) {
  const preparedAvatarId = await prepareAvatarUpload(ports.avatars, input);
  return commitAvatarUpload(ports, { ...input, preparedAvatarId });
}

const COMMAND_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_COMMAND_ID = '223e4567-e89b-42d3-a456-426614174001';
const THIRD_COMMAND_ID = '323e4567-e89b-42d3-a456-426614174002';
const AVATAR_UPLOAD_COMMAND_SCOPE = 'avatar:upload';
const AVATAR_UPLOAD_ROUTE = '/api/v1/me/avatar';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);
const JPEG = Buffer.from('ffd8ffdb004300ffff', 'hex');
const WEBP = Buffer.from('52494646' + '00000000' + '57454250' + '00000000', 'hex');

function makePorts(overrides: Partial<IdentityPorts> = {}): IdentityPorts {
  const account: Account = {
    id: 'account-avatar', subjectId: 'subject-avatar', status: 'active', email: 'a@example.test',
    securityEpoch: 0n, createdAt: new Date('2026-01-01T00:00:00.000Z'), deletedAt: null,
  };
  const profile: Profile = {
    accountId: account.id, displayName: 'Avatar User', avatarUrl: null, about: '', updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const handle: ProfileHandle = { handle: 'avatar_user', accountId: account.id, createdAt: new Date('2026-01-01T00:00:00.000Z') };
  const identity: AccountIdentity = { id: 'identity-avatar', accountId: account.id, issuer: 'issuer', subject: 'subject-avatar', createdAt: new Date('2026-01-01T00:00:00.000Z') };
  return {
    clock: { now: async () => new Date('2026-02-01T00:00:00.000Z') },
    accounts: {
      async findById() { return account; },
      async findBySubjectId() { return account; },
      async findByEmail() { return null; },
      async insert() {},
      async bumpSecurityEpoch() { return 1n; },
      async updateEmail() {},
      async markDeleted() {},
    },
    accountIdentities: {
      async findByIssuerSubject() { return identity; },
      async findByAccountId() { return identity; },
      async insert() {},
      async insertIfAbsent() { return identity; },
    },
    profiles: {
      async findByAccountId() { return profile; },
      async insert() {},
      async update(next) {
        profile.avatarUrl = next.avatarUrl;
        profile.displayName = next.displayName;
        profile.updatedAt = next.updatedAt;
      },
    },
    handles: {
      async findByHandle() { return handle; },
      async findByAccountId() { return handle; },
      async insert() {},
      async tryInsert() { return true; },
      async deleteByAccountId() { return true; },
      async deleteByHandle() { return true; },
    },
    sessions: {
      async findById() { return null; },
      async findByTokenHash() { return null; },
      async findLiveSuccessorByRotatedFrom() { return null; },
      async insert() {},
      async revoke() { return true; },
      async touch() { return true; },
      async revokeAllForAccount() { return 0; },
    },
    oidcLoginTransactions: {
      async insert() {},
      async consume() { return null; },
      async findByState() { return null; },
      async deleteByState() { return false; },
    },
    oidcTransactionSecrets: {
      digestState: (value: string) => value,
      decryptPkceVerifier: () => Buffer.alloc(0),
      encryptPkceVerifier: () => ({ ciphertext: Buffer.alloc(0), encryptionKeyId: 'key', encryptionKeyVersion: 1 }),
    },
    sessionRotationSecrets: createTestSessionRotationSecrets(),
    receipts: createMemoryProductCommandReceiptPort(new Map<string, MemoryProductCommandReceiptRow>()),
    ...overrides,
  } as IdentityPorts;
}

function makeAvatarStore(): AvatarObjectStore & { objects: Map<string, { contentType: string; body: Buffer }>; deletedIds: string[] } {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  const deletedIds: string[] = [];
  return {
    objects,
    deletedIds,
    async put(avatarId, body, contentType) { objects.set(avatarId, { contentType, body: Buffer.from(body) }); },
    async get(avatarId) { return objects.get(avatarId) ?? null; },
    async delete(avatarId) {
      objects.delete(avatarId);
      deletedIds.push(avatarId);
    },
  };
}

describe('avatar image validation', () => {
  test('accepts PNG, JPEG, and WebP magic bytes', () => {
    assert.doesNotThrow(() => assertAvatarImage(PNG, 'image/png'));
    assert.doesNotThrow(() => assertAvatarImage(JPEG, 'image/jpeg'));
    assert.doesNotThrow(() => assertAvatarImage(WEBP, 'image/webp'));
  });

  test('rejects unsupported content types, empty bodies, wrong magic, and oversized images', () => {
    assert.throws(() => assertAvatarImage(PNG, 'image/gif'), /content type/);
    assert.throws(() => assertAvatarImage(Buffer.alloc(0), 'image/png'), /cannot be empty/);
    assert.throws(() => assertAvatarImage(Buffer.from('not png'), 'image/png'), /does not match/);
    assert.throws(() => assertAvatarImage(Buffer.alloc(AVATAR_MAX_BYTES + 1), 'image/png'), /at most/);
  });

  test('rejects image headers whose decoded dimensions exceed the pixel budget', () => {
    const huge = Buffer.from(PNG);
    huge.writeUInt32BE(AVATAR_MAX_DIMENSION + 1, 16);
    assert.throws(() => assertAvatarImage(huge, 'image/png'), /dimensions/);
  });

  test('applies the dimension budget to lossless WebP headers', () => {
    const huge = Buffer.alloc(25);
    huge.write('RIFF', 0, 'ascii');
    huge.write('WEBP', 8, 'ascii');
    huge.write('VP8L', 12, 'ascii');
    huge.writeUInt32LE(5, 16);
    huge[20] = 0x2f;
    huge.writeUInt32LE(AVATAR_MAX_DIMENSION, 21);
    assert.throws(() => assertAvatarImage(huge, 'image/webp'), /dimensions/);
  });
});

describe('avatarUploadBodyFingerprint', () => {
  test('is a SHA-256 digest of the raw bytes, not the hex-encoded body', () => {
    const digest = avatarUploadBodyFingerprint(PNG);
    assert.equal(digest, createHash('sha256').update(PNG).digest('hex'));
    assert.match(digest, /^[0-9a-f]{64}$/u);
    assert.notEqual(digest, PNG.toString('hex'));
  });
});

describe('readAvatarBodyCapped', () => {
  test('returns the exact bytes of a small body under the cap', async () => {
    const result = await readAvatarBodyCapped(Readable.from([PNG]), AVATAR_MAX_BYTES);
    assert.ok(result);
    assert.ok(result.equals(PNG));
  });

  test('returns null for an empty stream', async () => {
    assert.equal(await readAvatarBodyCapped(Readable.from([]), AVATAR_MAX_BYTES), null);
  });

  test('returns a body of exactly maxBytes and null for maxBytes+1', async () => {
    const cap = 128;
    const exact = await readAvatarBodyCapped(Readable.from([Buffer.alloc(cap, 0x41)]), cap);
    assert.ok(exact);
    assert.equal(exact.byteLength, cap);
    assert.equal(
      await readAvatarBodyCapped(Readable.from([Buffer.alloc(cap + 1, 0x41)]), cap),
      null,
    );
  });

  test('caps an unbounded source at maxBytes + one chunk without pulling object-sized input', async () => {
    const cap = 256;
    const chunkSize = 64;
    // Conceptual object size only: the source can keep emitting; the test
    // process never allocates an object-sized Buffer.
    const objectSize = 50 * 1024 * 1024;
    let pulled = 0;
    const stream = new Readable({
      highWaterMark: chunkSize,
      read() {
        if (pulled >= objectSize) {
          this.push(null);
          return;
        }
        pulled += chunkSize;
        this.push(Buffer.alloc(chunkSize, 0x61));
      },
    });
    const result = await readAvatarBodyCapped(stream, cap);
    assert.equal(result, null, 'a stream that exceeds the cap must be treated as missing');
    assert.ok(
      pulled <= cap + chunkSize * 3,
      `bytes pulled from the source must stay O(cap + one chunk), pulled=${pulled} cap=${cap} chunk=${chunkSize}`,
    );
    assert.ok(pulled < objectSize / 10, 'must not drain an object-sized source');
    assert.equal(stream.destroyed, true, 'overflow must destroy the source stream');
  });
});

describe('uploadAvatar', () => {
  test('stores bytes and replaces the profile avatarUrl with a public URL', async () => {
    const avatars = makeAvatarStore();
    const ports = makePorts();
    const result = await uploadAvatar(
      { ...ports, avatars },
      { accountId: 'account-avatar', body: PNG, contentType: 'image/png', productOrigin: 'https://app.example.test/', commandId: COMMAND_ID },
    );
    assert.ok(result.profile.avatarUrl);
    assert.match(result.profile.avatarUrl!, /^https:\/\/app\.example\.test\/api\/v1\/avatar\/[a-f0-9-]{36}$/u);
    const avatarId = result.profile.avatarUrl!.split('/').pop()!;
    const stored = avatars.objects.get(avatarId);
    assert.ok(stored);
    assert.deepEqual(stored.body, PNG);
    assert.equal(stored.contentType, 'image/png');
    assert.equal(result.handle?.handle, 'avatar_user');
    assert.deepEqual(avatars.deletedIds, [], 'a first upload with no previous avatar must not delete anything');
  });

  test('re-upload retains old bytes until committed references are collected', async () => {
    const avatars = makeAvatarStore();
    const ports = makePorts();
    const first = await uploadAvatar(
      { ...ports, avatars },
      { accountId: 'account-avatar', body: PNG, contentType: 'image/png', productOrigin: 'https://app.example.test', commandId: COMMAND_ID },
    );
    const firstId = first.profile.avatarUrl!.split('/').pop()!;
    assert.ok(avatars.objects.has(firstId), 'the first upload must be stored');
    assert.deepEqual(avatars.deletedIds, [], 'no previous avatar existed yet');

    const second = await uploadAvatar(
      { ...ports, avatars },
      { accountId: 'account-avatar', body: JPEG, contentType: 'image/jpeg', productOrigin: 'https://app.example.test', commandId: OTHER_COMMAND_ID },
    );
    const secondId = second.profile.avatarUrl!.split('/').pop()!;
    assert.notEqual(secondId, firstId, 'every upload must mint a fresh object id');
    assert.deepEqual(avatars.deletedIds, [], 'the command cannot delete objects inside its transaction');
    assert.equal(avatars.objects.has(firstId), true, 'old bytes remain until committed-reference GC');
    assert.ok(avatars.objects.has(secondId), 'the new object must be stored');
    assert.equal(avatars.objects.get(secondId)!.contentType, 'image/jpeg');
    assert.equal(second.profile.avatarUrl, `https://app.example.test/api/v1/avatar/${secondId}`);
  });

  test('an external or non-avatar same-origin previous avatarUrl is never deleted', async () => {
    // External CDN URL: must not be treated as a deletable same-origin object.
    {
      const avatars = makeAvatarStore();
      const base = makePorts();
      const ports = {
        ...base,
        profiles: {
          ...base.profiles,
          async findByAccountId() {
            const profile = await base.profiles.findByAccountId('account-avatar');
            if (!profile) return null;
            return { ...profile, avatarUrl: 'https://cdn.example.test/avatar.png' };
          },
        },
      };
      const result = await uploadAvatar(
        { ...ports, avatars },
        { accountId: 'account-avatar', body: PNG, contentType: 'image/png', productOrigin: 'https://app.example.test', commandId: COMMAND_ID },
      );
      assert.ok(result.profile.avatarUrl);
      assert.deepEqual(avatars.deletedIds, [], 'an external previous avatarUrl must never be deleted');
    }

    // Same-origin URL that is not an avatar object path: still no delete.
    {
      const avatars = makeAvatarStore();
      const base = makePorts();
      const ports = {
        ...base,
        profiles: {
          ...base.profiles,
          async findByAccountId() {
            const profile = await base.profiles.findByAccountId('account-avatar');
            if (!profile) return null;
            return { ...profile, avatarUrl: 'https://app.example.test/some/other/path' };
          },
        },
      };
      const result = await uploadAvatar(
        { ...ports, avatars },
        { accountId: 'account-avatar', body: PNG, contentType: 'image/png', productOrigin: 'https://app.example.test', commandId: COMMAND_ID },
      );
      assert.ok(result.profile.avatarUrl);
      assert.deepEqual(avatars.deletedIds, [], 'a same-origin non-avatar path must never be deleted');
    }
  });
});

describe('uploadAvatar Known-Command-Id idempotency', () => {
  test('same command id replays the stored result while unused preparation awaits GC', async () => {
    const avatars = makeAvatarStore();
    const ports = makePorts();
    const input = {
      accountId: 'account-avatar', body: PNG, contentType: 'image/png',
      productOrigin: 'https://app.example.test', commandId: COMMAND_ID,
    };
    const first = await uploadAvatar({ ...ports, avatars }, input);
    assert.equal(first.kind, 'created');
    if (first.kind !== 'created') return;
    const firstUrl = first.profile.avatarUrl!;
    assert.equal(avatars.objects.size, 1);

    // Retry of the same command (response lost after R2 write): must replay
    // the stored result, never write a second object or touch the profile.
    const replay = await uploadAvatar({ ...ports, avatars }, input);
    assert.equal(replay.kind, 'replay');
    if (replay.kind !== 'replay') return;
    assert.equal(replay.result.status, 200);
    assert.equal(replay.result.mediaType, 'application/json');
    assert.equal(avatars.objects.size, 2, 'replay preparation is unreferenced and eligible for persistent GC');
    assert.deepEqual(avatars.deletedIds, [], 'a replay must not delete anything');
    const storedProfile = await ports.profiles.findByAccountId('account-avatar');
    assert.equal(storedProfile?.avatarUrl, firstUrl, 'a replay must not update the profile');
    const view = JSON.parse(Buffer.from(replay.result.body).toString('utf8')) as {
      account: { id: string };
      profile: { avatarUrl: string; handle: string };
    };
    assert.equal(view.account.id, 'account-avatar');
    assert.equal(view.profile.avatarUrl, firstUrl, 'the replayed body must match the original response');
    assert.equal(view.profile.handle, 'avatar_user');
  });

  test('a different command id uploads again as a fresh command', async () => {
    const avatars = makeAvatarStore();
    const ports = makePorts();
    const base = {
      accountId: 'account-avatar', body: PNG, contentType: 'image/png',
      productOrigin: 'https://app.example.test',
    };
    const first = await uploadAvatar({ ...ports, avatars }, { ...base, commandId: COMMAND_ID });
    assert.equal(first.kind, 'created');
    if (first.kind !== 'created') return;
    const firstUrl = first.profile.avatarUrl!;
    const firstId = firstUrl.split('/').pop()!;

    const second = await uploadAvatar({ ...ports, avatars }, { ...base, commandId: OTHER_COMMAND_ID });
    assert.equal(second.kind, 'created');
    if (second.kind !== 'created') return;
    assert.notEqual(second.profile.avatarUrl, firstUrl, 'a fresh command must mint a new object');
    assert.ok(avatars.objects.has(firstId), 'the replaced object awaits committed-reference GC');
    assert.deepEqual(avatars.deletedIds, []);
  });

  test('same command id with a different image is rejected as reused', async () => {
    const avatars = makeAvatarStore();
    const ports = makePorts();
    const base = { accountId: 'account-avatar', productOrigin: 'https://app.example.test', commandId: COMMAND_ID };
    const first = await uploadAvatar({ ...ports, avatars }, { ...base, body: PNG, contentType: 'image/png' });
    assert.equal(first.kind, 'created');
    if (first.kind !== 'created') return;
    const firstUrl = first.profile.avatarUrl!;

    const reused = await uploadAvatar({ ...ports, avatars }, { ...base, body: JPEG, contentType: 'image/jpeg' });
    assert.equal(reused.kind, 'reused');
    assert.equal(avatars.objects.size, 2, 'uncommitted prepared bytes are left for orphan GC');
    assert.deepEqual(avatars.deletedIds, []);
    const storedProfile = await ports.profiles.findByAccountId('account-avatar');
    assert.equal(storedProfile?.avatarUrl, firstUrl, 'a reused command must not change the profile');
  });

  test('a claim that is still in progress leaves preparation for GC', async () => {
    const receipts = new Map<string, MemoryProductCommandReceiptRow>();
    const avatars = makeAvatarStore();
    const ports = makePorts({ receipts: createMemoryProductCommandReceiptPort(receipts) });
    // Simulate a concurrent first request that claimed the command and has not
    // completed it yet: the fingerprint must match what uploadAvatar computes.
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route: AVATAR_UPLOAD_ROUTE, mediaType: 'image/png', body: avatarUploadBodyFingerprint(PNG),
    });
    await createMemoryProductCommandReceiptPort(receipts).claim(
      { principalId: 'account-avatar', commandScope: AVATAR_UPLOAD_COMMAND_SCOPE, commandId: COMMAND_ID },
      fingerprint,
    );

    const result = await uploadAvatar(
      { ...ports, avatars },
      { accountId: 'account-avatar', body: PNG, contentType: 'image/png', productOrigin: 'https://app.example.test', commandId: COMMAND_ID },
    );
    assert.equal(result.kind, 'in_progress');
    if (result.kind !== 'in_progress') return;
    assert.equal(result.retryAfterSeconds, 1);
    assert.equal(avatars.objects.size, 1, 'prepared bytes are recoverable if the receipt is already in progress');
    assert.deepEqual(avatars.deletedIds, []);
  });
});

describe('uploadAvatar failure paths', () => {
  test('a non-HTTPS productOrigin is rejected before any object is written', async () => {
    for (const productOrigin of ['http://app.example.test', 'not-a-url']) {
      const avatars = makeAvatarStore();
      const ports = makePorts();
      await assert.rejects(
        uploadAvatar(
          { ...ports, avatars },
          { accountId: 'account-avatar', body: PNG, contentType: 'image/png', productOrigin, commandId: COMMAND_ID },
        ),
        (error: unknown) => {
          assert.ok(error instanceof IdentityError);
          assert.equal(error.code, 'invalid_identity_input');
          return true;
        },
      );
      assert.equal(avatars.objects.size, 0, `an invalid origin (${productOrigin}) must fail before any object is written`);
      assert.deepEqual(avatars.deletedIds, [], `an invalid origin (${productOrigin}) must never delete anything`);
    }
  });

  test('a failed profile update leaves prepared bytes for recovery without completing the receipt', async () => {
    const receipts = new Map<string, MemoryProductCommandReceiptRow>();
    const avatars = makeAvatarStore();
    const base = makePorts({ receipts: createMemoryProductCommandReceiptPort(receipts) });
    const updateError = new Error('db failure');
    const ports = {
      ...base,
      profiles: {
        ...base.profiles,
        async update() { throw updateError; },
      },
    };
    await assert.rejects(
      uploadAvatar(
        { ...ports, avatars },
        { accountId: 'account-avatar', body: PNG, contentType: 'image/png', productOrigin: 'https://app.example.test', commandId: OTHER_COMMAND_ID },
      ),
      (error: unknown) => error === updateError,
    );
    assert.equal(avatars.objects.size, 1, 'an error must not guess the commit outcome and delete prepared bytes');
    assert.equal(avatars.deletedIds.length, 0, 'only persistent GC may delete an unreferenced object');
    const receipt = receipts.get(productCommandReceiptKey({
      principalId: 'account-avatar', commandScope: AVATAR_UPLOAD_COMMAND_SCOPE, commandId: OTHER_COMMAND_ID,
    }));
    assert.ok(receipt, 'the failed command must still hold a receipt row');
    assert.equal(receipt.status, 'in_progress', 'a failed upload must not complete the receipt');
    assert.equal(receipt.result, undefined, 'a failed upload must not store a result');
  });

  test('control: a valid origin with a successful update keeps the stored object', async () => {
    const avatars = makeAvatarStore();
    const ports = makePorts();
    const result = await uploadAvatar(
      { ...ports, avatars },
      { accountId: 'account-avatar', body: PNG, contentType: 'image/png', productOrigin: 'https://app.example.test', commandId: THIRD_COMMAND_ID },
    );
    assert.equal(result.kind, 'created');
    if (result.kind !== 'created') return;
    const avatarId = result.profile.avatarUrl!.split('/').pop()!;
    assert.ok(avatars.objects.has(avatarId), 'the uploaded object must be retained on success');
    assert.equal(avatars.objects.size, 1);
    assert.deepEqual(avatars.deletedIds, [], 'no previous avatar existed, so nothing must be deleted');
  });
});
