/**
 * P4A-I10 owner-private delivery capability contract (plan §6 I10).
 *
 * Pins the stateless signed capability: compact versioned token, HMAC-SHA256
 * signature over the exact payload bytes, audience bound to the isolated
 * delivery origin, method GET only, blob/generation binding, random nonce,
 * bounded TTL (1..120s, matching the I03 max-exposure window), and a verifier
 * that is the exact logic the I11 isolated-origin host will consume. Also
 * covers the bounded per-principal rate limiter (fixed window, bounded memory).
 *
 * Negative controls prove the capability is unusable for R2 write/list or any
 * other service: wrong secret, wrong audience (an R2 endpoint / any other
 * origin), a forged GET-only-violation (PUT), expired/not-yet-valid, wrong
 * kind, malformed tokens, and replay behaviour (stateless bearer: replay
 * within the TTL stays valid; after expiry it is rejected).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'vitest';
import {
  OWNER_DELIVERY_CAPABILITY_TTL_MAX_SECONDS,
  OWNER_DELIVERY_CAPABILITY_TTL_MIN_SECONDS,
  createDeliveryRateLimiter,
  createHmacOwnerDeliveryCapabilitySigner,
  verifyOwnerDeliveryCapability,
} from '../../../src/modules/attachments/index.js';
import {
  I10_DELIVERY_ORIGIN,
  I10_DELIVERY_SECRET,
  I10_SUBJECT_OWNER,
  I10_SUBJECT_OTHER_OWNER,
} from '../../support/phase4a-i10-test-helpers.js';

const R2_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
const BASE_TIME = new Date('2026-08-08T12:00:00.000Z');

function signerAt(clock: () => Date) {
  return createHmacOwnerDeliveryCapabilitySigner({
    secret: I10_DELIVERY_SECRET,
    audienceOrigin: I10_DELIVERY_ORIGIN,
    now: clock,
  });
}

/** Independent re-implementation of the canonical HMAC format for forged negatives. */
function forgeToken(payload: unknown, secret: string | Uint8Array): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = createHmac('sha256', secret)
    .update('owner-delivery-v1\n')
    .update(payloadBytes)
    .digest();
  return `v1.${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;
}

test('signer issues a compact versioned token carrying the full binding', () => {
  const now = BASE_TIME;
  const signer = signerAt(() => now);
  const capability = signer.sign({
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    ttlSeconds: 60,
    now,
  });
  const parts = capability.token.split('.');
  assert.equal(parts.length, 3, 'token must be version.payload.signature');
  assert.equal(parts[0], 'v1');
  const claims = capability.claims;
  assert.equal(claims.version, 1);
  assert.equal(claims.kind, 'owner_delivery');
  assert.equal(claims.blobId, 'blob-a');
  assert.equal(claims.generationId, 'gen-a1');
  assert.equal(claims.ownerSubject, I10_SUBJECT_OWNER);
  assert.equal(claims.audience, I10_DELIVERY_ORIGIN);
  assert.equal(claims.method, 'GET');
  assert.ok(claims.capabilityId.length > 0, 'nonce must be present');
  assert.equal(claims.issuedAtEpochMs, now.getTime());
  assert.equal(claims.expiresAtEpochMs, now.getTime() + 60_000);
});

test('the production verifier accepts a freshly issued token and round-trips claims', () => {
  const signer = signerAt(() => BASE_TIME);
  const capability = signer.sign({
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    ttlSeconds: 60,
  });
  const verification = verifyOwnerDeliveryCapability({
    token: capability.token,
    secret: I10_DELIVERY_SECRET,
    expectedAudience: I10_DELIVERY_ORIGIN,
    now: new Date(BASE_TIME.getTime() + 30_000),
  });
  assert.equal(verification.outcome, 'valid');
  if (verification.outcome === 'valid') {
    assert.deepEqual(verification.claims, capability.claims);
  }
});

test('a wrong secret never verifies (signature binding)', () => {
  const signer = signerAt(() => BASE_TIME);
  const capability = signer.sign({
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    ttlSeconds: 60,
  });
  const verification = verifyOwnerDeliveryCapability({
    token: capability.token,
    secret: Buffer.from('another-secret-that-is-not-the-key'),
    expectedAudience: I10_DELIVERY_ORIGIN,
    now: new Date(BASE_TIME.getTime() + 30_000),
  });
  assert.equal(verification.outcome, 'invalid');
  if (verification.outcome === 'invalid') assert.equal(verification.reason, 'signature');
});

test('the capability is unusable for R2 or any other service: wrong audience is rejected', () => {
  const signer = signerAt(() => BASE_TIME);
  const capability = signer.sign({
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    ttlSeconds: 60,
  });
  for (const audience of [R2_ENDPOINT, 'https://app.known.example', 'https://files.example.net']) {
    const verification = verifyOwnerDeliveryCapability({
      token: capability.token,
      secret: I10_DELIVERY_SECRET,
      expectedAudience: audience,
      now: new Date(BASE_TIME.getTime() + 30_000),
    });
    assert.equal(verification.outcome, 'invalid', `audience ${audience} must be rejected`);
    if (verification.outcome === 'invalid') assert.equal(verification.reason, 'audience_mismatch');
  }
});

test('a GET-only capability can never authorize an R2 write (forged PUT rejected)', () => {
  const payload = {
    version: 1,
    kind: 'owner_delivery',
    capabilityId: 'nonce-1',
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    audience: I10_DELIVERY_ORIGIN,
    method: 'PUT',
    issuedAtEpochMs: BASE_TIME.getTime(),
    expiresAtEpochMs: BASE_TIME.getTime() + 60_000,
  };
  const forged = forgeToken(payload, I10_DELIVERY_SECRET);
  const verification = verifyOwnerDeliveryCapability({
    token: forged,
    secret: I10_DELIVERY_SECRET,
    expectedAudience: I10_DELIVERY_ORIGIN,
    now: new Date(BASE_TIME.getTime() + 30_000),
  });
  assert.equal(verification.outcome, 'invalid');
  if (verification.outcome === 'invalid') assert.equal(verification.reason, 'method_mismatch');
});

test.each(['generationId', 'ownerSubject'] as const)('tampered %s fails the signed capability', (field) => {
  const signer = signerAt(() => BASE_TIME);
  const capability = signer.sign({
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    ttlSeconds: 60,
  });
  // Modify a legitimately signed token's claims but keep the ORIGINAL
  // signature segment: any byte change to the payload breaks the signature,
  // even though the attacker knows the key. (Re-signing with the same key is
  // minting a fresh capability, which is not a tamper.)
  const [version, payloadSegment, signatureSegment] = capability.token.split('.') as [string, string, string];
  const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as Record<string, unknown>;
  const tampered = Buffer.from(JSON.stringify({ ...claims, [field]: 'other-identity' }), 'utf8');
  const forged = `${version}.${tampered.toString('base64url')}.${signatureSegment}`;
  const verification = verifyOwnerDeliveryCapability({
    token: forged,
    secret: I10_DELIVERY_SECRET,
    expectedAudience: I10_DELIVERY_ORIGIN,
    now: new Date(BASE_TIME.getTime() + 30_000),
  });
  assert.equal(verification.outcome, 'invalid');
  if (verification.outcome === 'invalid') assert.equal(verification.reason, 'signature');
});

test('expired capability is rejected (natural short-TTL expiry is separate from authorization)', () => {
  const signer = signerAt(() => BASE_TIME);
  const capability = signer.sign({
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    ttlSeconds: 1,
  });
  const verification = verifyOwnerDeliveryCapability({
    token: capability.token,
    secret: I10_DELIVERY_SECRET,
    expectedAudience: I10_DELIVERY_ORIGIN,
    now: new Date(BASE_TIME.getTime() + 2_000),
  });
  assert.equal(verification.outcome, 'invalid');
  if (verification.outcome === 'invalid') assert.equal(verification.reason, 'expired');
});

test('a capability is not valid before its issuance time', () => {
  const mutable = { now: BASE_TIME.getTime() };
  const signer = signerAt(() => new Date(mutable.now));
  const capability = signer.sign({
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    ttlSeconds: 60,
  });
  const verification = verifyOwnerDeliveryCapability({
    token: capability.token,
    secret: I10_DELIVERY_SECRET,
    expectedAudience: I10_DELIVERY_ORIGIN,
    now: new Date(mutable.now - 1),
  });
  assert.equal(verification.outcome, 'invalid');
  if (verification.outcome === 'invalid') assert.equal(verification.reason, 'not_yet_valid');
});

test('every issuance carries a fresh random nonce (capability id)', () => {
  const signer = signerAt(() => BASE_TIME);
  const first = signer.sign({ blobId: 'blob-a', generationId: 'gen-a1', ownerSubject: I10_SUBJECT_OWNER, ttlSeconds: 60 });
  const second = signer.sign({ blobId: 'blob-a', generationId: 'gen-a1', ownerSubject: I10_SUBJECT_OWNER, ttlSeconds: 60 });
  assert.notEqual(first.claims.capabilityId, second.claims.capabilityId);
});

test('replay within the TTL stays valid (stateless short-lived bearer); the token never leaks secrets', () => {
  const signer = signerAt(() => BASE_TIME);
  const capability = signer.sign({
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    ttlSeconds: 60,
  });
  for (const offset of [0, 30_000, 59_000]) {
    const verification = verifyOwnerDeliveryCapability({
      token: capability.token,
      secret: I10_DELIVERY_SECRET,
      expectedAudience: I10_DELIVERY_ORIGIN,
      now: new Date(BASE_TIME.getTime() + offset),
    });
    assert.equal(verification.outcome, 'valid', `replay at +${offset}ms must stay valid within TTL`);
  }
  const tokenText = capability.token;
  const claimsText = JSON.stringify(capability.claims);
  assert.ok(!tokenText.includes(I10_DELIVERY_SECRET.toString('utf8')), 'token must not embed the HMAC secret');
  assert.ok(!tokenText.includes('secret'), 'token must not embed the word secret');
  assert.ok(!tokenText.includes('r2.cloudflarestorage.com'), 'token must not reference the R2 endpoint');
  for (const needle of ['key', 'credential', 'accessKey', 'digest', 'url']) {
    assert.ok(!claimsText.includes(needle), `claims must not carry ${needle}`);
  }
});

test('ttl is bounded to the I03 max exposure window (1..120 seconds)', () => {
  const signer = signerAt(() => BASE_TIME);
  assert.equal(OWNER_DELIVERY_CAPABILITY_TTL_MIN_SECONDS, 1);
  assert.equal(OWNER_DELIVERY_CAPABILITY_TTL_MAX_SECONDS, 120);
  for (const ttl of [0, -1, 121, 1.5, Number.NaN]) {
    assert.throws(
      () => signer.sign({ blobId: 'blob-a', generationId: 'gen-a1', ownerSubject: I10_SUBJECT_OWNER, ttlSeconds: ttl }),
      /delivery_capability_ttl_out_of_range/u,
      `ttl ${String(ttl)} must be rejected`,
    );
  }
  const maxCapability = signer.sign({ blobId: 'blob-a', generationId: 'gen-a1', ownerSubject: I10_SUBJECT_OWNER, ttlSeconds: 120 });
  assert.equal(maxCapability.claims.expiresAtEpochMs - maxCapability.claims.issuedAtEpochMs, 120_000);
});

test('malformed, unsupported-version and wrong-kind tokens are rejected', () => {
  const signer = signerAt(() => BASE_TIME);
  const capability = signer.sign({ blobId: 'blob-a', generationId: 'gen-a1', ownerSubject: I10_SUBJECT_OWNER, ttlSeconds: 60 });
  const verify = (token: string) => verifyOwnerDeliveryCapability({
    token,
    secret: I10_DELIVERY_SECRET,
    expectedAudience: I10_DELIVERY_ORIGIN,
    now: new Date(BASE_TIME.getTime() + 30_000),
  });
  assert.equal(verify('').outcome, 'invalid');
  assert.equal(verify('garbage').outcome, 'invalid');
  assert.equal(verify('v1.!!!.###').outcome, 'invalid');
  assert.equal(verify(`v2.${capability.token.split('.').slice(1).join('.')}`).outcome, 'invalid');
  const wrongKind = forgeToken({
    version: 1,
    kind: 'r2_write',
    capabilityId: 'nonce-1',
    blobId: 'blob-a',
    generationId: 'gen-a1',
    ownerSubject: I10_SUBJECT_OWNER,
    audience: I10_DELIVERY_ORIGIN,
    method: 'GET',
    issuedAtEpochMs: BASE_TIME.getTime(),
    expiresAtEpochMs: BASE_TIME.getTime() + 60_000,
  }, I10_DELIVERY_SECRET);
  const wrongKindVerification = verify(wrongKind);
  assert.equal(wrongKindVerification.outcome, 'invalid');
  if (wrongKindVerification.outcome === 'invalid') assert.equal(wrongKindVerification.reason, 'wrong_kind');
});

test('rate limiter: bounded per-principal fixed window, independent principals, window rollover', () => {
  const policy = { windowSeconds: 60, maxPerWindow: 2, maxTrackedPrincipals: 16 };
  const limiter = createDeliveryRateLimiter(policy);
  let nowMs = BASE_TIME.getTime();
  const check = (principalId: string) => limiter.check(principalId, new Date(nowMs));

  assert.equal(check('principal-a').allowed, true);
  assert.equal(check('principal-a').allowed, true);
  const third = check('principal-a');
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterSeconds > 0, 'denied attempts must carry a retry-after');
  // A different principal is independent.
  assert.equal(check('principal-b').allowed, true);
  assert.equal(check('principal-b').allowed, true);
  // The window rolls over deterministically by the injected clock.
  nowMs = BASE_TIME.getTime() + 61_000;
  assert.equal(check('principal-a').allowed, true, 'a fresh window resets the budget');
});

test('rate limiter memory is bounded and old windows are evicted', () => {
  const policy = { windowSeconds: 60, maxPerWindow: 5, maxTrackedPrincipals: 4 };
  const limiter = createDeliveryRateLimiter(policy);
  let now = BASE_TIME.getTime();
  for (let index = 0; index < 10; index += 1) {
    limiter.check(`principal-${index}`, new Date(now));
  }
  assert.ok(limiter.trackedCount() <= policy.maxTrackedPrincipals, 'tracked windows must stay bounded');
  // A previously evicted principal still gets a fresh window (no permanent state).
  assert.equal(limiter.check('principal-0', new Date(now)).allowed, true);
  // Advancing past the window evicts everything and resets all budgets.
  now += 61_000;
  assert.equal(limiter.check('principal-0', new Date(now)).allowed, true);
  assert.equal(limiter.check('principal-1', new Date(now)).allowed, true);
});

test('ownerSubject is bound into the capability and travels with the claims', () => {
  const signer = signerAt(() => BASE_TIME);
  const capability = signer.sign({
    blobId: 'blob-b',
    generationId: 'gen-b1',
    ownerSubject: I10_SUBJECT_OTHER_OWNER,
    ttlSeconds: 60,
  });
  const verification = verifyOwnerDeliveryCapability({
    token: capability.token,
    secret: I10_DELIVERY_SECRET,
    expectedAudience: I10_DELIVERY_ORIGIN,
    now: new Date(BASE_TIME.getTime() + 30_000),
  });
  assert.equal(verification.outcome, 'valid');
  if (verification.outcome === 'valid') assert.equal(verification.claims.ownerSubject, I10_SUBJECT_OTHER_OWNER);
});
