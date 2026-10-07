import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { test } from 'vitest';
import Fastify from 'fastify';
import {
  registerEmailCallbackRoutes,
  EMAIL_CALLBACK_PATH,
  EMAIL_CALLBACK_BODY_LIMIT_BYTES,
  mapEmailCallbackRejectionStatus,
} from '../../../src/transport/product/email-callback-routes.js';
import { AliyunDirectMailAdapter } from '../../../src/infrastructure/email/aliyun-directmail-adapter.js';
import {
  EmailCallbackRejectedError,
  type EmailCallbackFact,
  type EmailCallbackRateLimiter,
  type EmailCallbackRateLimitOutcome,
  type EmailCallbackReconciliationResult,
  type EmailCallbackVerifier,
  type EmailCallbackVerificationInput,
} from '../../../src/modules/notifications/index.js';
import {
  buildMnsPushRequest,
  createSelfSignedTestCertificate,
} from '../../support/phase5-mns-push.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { createMemoryEmailCallbackRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';

const CALLBACK_SECRET = 'p531_test_callback_secret';
const FACT: EmailCallbackFact = Object.freeze({
  kind: 'delivered',
  providerMessageId: 'env-delivery-1',
  occurredAt: '2026-08-02T00:00:00.000Z',
  tag: 'known-delivery-delivery-1',
});

function hmacEnvelope(body: string, secret: string, timestamp = '2026-08-02T00:00:00.000Z', nonce = 'nonce-1') {
  const signature = createHmac('sha256', secret)
    .update(`${body}\n${timestamp}\n${nonce}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-known-dm-signature': signature,
    'x-known-dm-timestamp': timestamp,
    'x-known-dm-nonce': nonce,
  };
}

function makeVerifier(overrides: {
  readonly fail?: (input: EmailCallbackVerificationInput) => EmailCallbackRejectedError;
} = {}): EmailCallbackVerifier {
  return {
    async verifyCallback(input: EmailCallbackVerificationInput): Promise<EmailCallbackFact> {
      if (overrides.fail) throw overrides.fail(input);
      return FACT;
    },
  };
}

async function buildApp(options: {
  enabled: boolean;
  verifier?: EmailCallbackVerifier;
  reconcile?: (fact: EmailCallbackFact) => Promise<EmailCallbackReconciliationResult>;
  now?: () => Date;
  metrics?: InMemoryMetrics;
  bodyLimitBytes?: number;
  rateLimiter?: EmailCallbackRateLimiter;
}) {
  const app = Fastify({ logger: false });
  registerEmailCallbackRoutes(app, {
    enabled: options.enabled,
    verifier: options.verifier,
    reconcile: options.reconcile,
    now: options.now ?? (() => new Date('2026-08-02T00:00:00.000Z')),
    metrics: options.metrics,
    bodyLimitBytes: options.bodyLimitBytes,
    rateLimiter: options.rateLimiter,
  });
  return app;
}

/** Real adapter whose MNS signing certificate is served from the injected seam. */
function mnsAdapter(): {
  readonly adapter: AliyunDirectMailAdapter;
  readonly keypair: { readonly privateKey: KeyObject };
} {
  const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = createSelfSignedTestCertificate(keypair);
  const adapter = new AliyunDirectMailAdapter({
    endpoint: 'https://dm.aliyuncs.com/',
    regionId: 'cn-hangzhou',
    accountName: 'sender@example.invalid',
    accessKeyId: 'P531FIXTUREAKID',
    accessKeySecret: 'p531-fixture-key',
    timeoutMs: 1_000,
    tagPrefix: 'known-delivery-',
    maxTagChars: 128,
    callbackHmacSecret: null,
    mnsCertificateFetcher: { async fetchCertificate() { return certPem; } },
  });
  return { adapter, keypair };
}

const reconciliation: EmailCallbackReconciliationResult = Object.freeze({
  disposition: 'delivered',
  deliveryId: 'delivery-1',
  suppressionRecorded: false,
  deliveryTransitioned: true,
});

test('P5-31 callback rejection status mapping is 401/403 only (no side-effect statuses)', () => {
  assert.equal(mapEmailCallbackRejectionStatus('not_configured'), 401);
  assert.equal(mapEmailCallbackRejectionStatus('missing_signature_headers'), 401);
  assert.equal(mapEmailCallbackRejectionStatus('invalid_certificate_url'), 403);
  assert.equal(mapEmailCallbackRejectionStatus('expired_timestamp'), 403);
  assert.equal(mapEmailCallbackRejectionStatus('signature_mismatch'), 403);
  assert.equal(mapEmailCallbackRejectionStatus('missing_content_md5'), 403);
  assert.equal(mapEmailCallbackRejectionStatus('malformed_callback_body'), 403);
  assert.equal(mapEmailCallbackRejectionStatus('unknown_event_type'), 403);
});

test('n1: not_configured stays a documented defense-in-depth 401 (never 403/500) with zero side effects', async () => {
  // Production composition disables the surface (404) when the HMAC secret is
  // null, so this rejection is unreachable there; the mapping is kept so a
  // mis-configured composition that enables the surface without a secret
  // still fails closed with 401 instead of silently accepting callbacks.
  assert.equal(mapEmailCallbackRejectionStatus('not_configured'), 401);
  let reconciled = false;
  const app = await buildApp({
    enabled: true,
    verifier: makeVerifier({
      fail: () => new EmailCallbackRejectedError('not_configured', 'hmac secret unset'),
    }),
    reconcile: async () => { reconciled = true; return reconciliation; },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 401,
      'a not_configured verifier rejection must fail closed with 401 (n1)');
    assert.equal(reconciled, false, 'rejection must never reach reconciliation');
  } finally { await app.close(); }
});

test('P5-31 verified callback returns a stable 202 and reconciles exactly once', async () => {
  const calls: EmailCallbackFact[] = [];
  const app = await buildApp({
    enabled: true,
    verifier: makeVerifier(),
    reconcile: async (fact) => { calls.push(fact); return reconciliation; },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const body = JSON.stringify({ eventType: 'dm:Deliver:Succeed', data: { env_id: 'env-delivery-1', tag: 'known-delivery-delivery-1' } });
    const headers = hmacEnvelope(body, CALLBACK_SECRET);
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, {
      method: 'POST', headers, body,
    });
    assert.equal(response.status, 202);
    assert.deepEqual(JSON.parse(await response.text()), { accepted: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], FACT);
  } finally { await app.close(); }
});

test('A6: reconcile failure returns a stable 503, increments callback.reconcile_error, and never retries or 500s', async () => {
  let reconcileCalls = 0;
  const metrics = new InMemoryMetrics();
  const providerText = 'provider exploded accessKeySecret=RAW-PROVIDER-SECRET';
  const app = await buildApp({
    enabled: true,
    verifier: makeVerifier(),
    reconcile: async () => { reconcileCalls += 1; throw new Error(providerText); },
    metrics,
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const body = JSON.stringify({ eventType: 'dm:Deliver:Succeed' });
    const headers = hmacEnvelope(body, CALLBACK_SECRET, '2026-08-02T00:00:00.000Z', 'nonce-a6');
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
    assert.equal(response.status, 503, 'a reconcile failure must be a stable 503, never a 500');
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: 'callback_reconcile_error' },
      'the 503 body must be a fixed redacted code');
    assert.equal(text.includes('RAW-PROVIDER-SECRET'), false,
      'raw provider/secret text must never reach the response');
    assert.equal(text.includes('accessKeySecret'), false,
      'the camelCase secret key must not leak into the response');
    assert.equal(reconcileCalls, 1, 'reconciliation must run exactly once (no retry)');
    assert.equal(metrics.get('notifications.email_delivery.callback.reconcile_error'), 1);
    assert.equal(metrics.get('notifications.email_delivery.callback.rejected'), 0,
      'a reconcile failure is not a verification rejection (A6)');
    assert.equal(metrics.get('notifications.email_delivery.callback.accepted'), 0);
  } finally { await app.close(); }
});

test('P5-31 callback replay is idempotent (202 again; reconcile called again but terminal result)', async () => {
  const calls: EmailCallbackFact[] = [];
  const app = await buildApp({
    enabled: true,
    verifier: makeVerifier(),
    reconcile: async (fact) => { calls.push(fact); return { ...reconciliation, deliveryTransitioned: false }; },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const body = JSON.stringify({ eventType: 'dm:Deliver:Succeed' });
    const headers = hmacEnvelope(body, CALLBACK_SECRET, '2026-08-02T00:00:00.000Z', 'nonce-replay');
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
      assert.equal(response.status, 202);
    }
    assert.equal(calls.length, 2);
  } finally { await app.close(); }
});

test('P5-31 tampered signature is rejected 403 with no reconciliation side effect', async () => {
  let reconciled = false;
  const app = await buildApp({
    enabled: true,
    verifier: makeVerifier({
      fail: () => new EmailCallbackRejectedError('signature_mismatch', 'tampered envelope'),
    }),
    reconcile: async () => { reconciled = true; return reconciliation; },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const body = JSON.stringify({ eventType: 'dm:Deliver:Succeed' });
    const headers = hmacEnvelope(body, 'wrong-secret');
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
    assert.equal(response.status, 403);
    assert.equal(reconciled, false);
  } finally { await app.close(); }
});

test('P5-31 expired timestamp is rejected 403 with no side effect', async () => {
  let reconciled = false;
  const app = await buildApp({
    enabled: true,
    verifier: makeVerifier({
      fail: () => new EmailCallbackRejectedError('expired_timestamp', 'replay window exceeded'),
    }),
    reconcile: async () => { reconciled = true; return reconciliation; },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-known-dm-signature': 'a'.repeat(64) },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(reconciled, false);
  } finally { await app.close(); }
});

test('P5-31 missing signature headers are rejected 401 with no side effect', async () => {
  let reconciled = false;
  const app = await buildApp({
    enabled: true,
    verifier: makeVerifier({
      fail: () => new EmailCallbackRejectedError('missing_signature_headers', 'no envelope'),
    }),
    reconcile: async () => { reconciled = true; return reconciliation; },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 401);
    assert.equal(reconciled, false);
  } finally { await app.close(); }
});

test('P5-31 callback surface is disabled (404) when the email feature is not configured', async () => {
  const app = await buildApp({ enabled: false });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404);
  } finally { await app.close(); }
});

test('P5-31 real MNS push over the relative request target is accepted (202), reconciles, and never 500s', async () => {
  const { adapter, keypair } = mnsAdapter();
  const calls: EmailCallbackFact[] = [];
  const app = await buildApp({
    enabled: true,
    verifier: adapter,
    reconcile: async (fact) => { calls.push(fact); return reconciliation; },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const { body, headers } = buildMnsPushRequest(keypair, {
      url: EMAIL_CALLBACK_PATH,
      date: 'Sun, 02 Aug 2026 00:00:00 GMT',
    });
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
    assert.equal(response.status, 202, 'the relative-URL MNS path must not 500');
    assert.deepEqual(JSON.parse(await response.text()), { accepted: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.kind, 'bounced');
    assert.equal(calls[0]!.providerMessageId, '12625010655');
    assert.equal(calls[0]!.recipient, 'recipient@example.invalid');
  } finally {
    await app.close();
    await adapter.close();
  }
});

test('P5-31 HMAC-configured ingress rejects a valid MNS push (401) with zero side effects', async () => {
  const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = createSelfSignedTestCertificate(keypair);
  const adapter = new AliyunDirectMailAdapter({
    endpoint: 'https://dm.aliyuncs.com/',
    regionId: 'cn-hangzhou',
    accountName: 'sender@example.invalid',
    accessKeyId: 'P531FIXTUREAKID',
    accessKeySecret: 'p531-fixture-key',
    timeoutMs: 1_000,
    tagPrefix: 'known-delivery-',
    maxTagChars: 128,
    callbackHmacSecret: CALLBACK_SECRET,
    mnsCertificateFetcher: { async fetchCertificate() { return certPem; } },
  });
  let reconciled = false;
  const app = await buildApp({
    enabled: true,
    verifier: adapter,
    reconcile: async () => { reconciled = true; return reconciliation; },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const { body, headers } = buildMnsPushRequest(keypair, {
      url: EMAIL_CALLBACK_PATH,
      date: 'Sun, 02 Aug 2026 00:00:00 GMT',
    });
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
    assert.equal(response.status, 401);
    assert.equal(reconciled, false);
  } finally {
    await app.close();
    await adapter.close();
  }
});

test('P5-31 tampered MNS push over the relative request target is rejected 403 with zero side effects', async () => {
  const { adapter, keypair } = mnsAdapter();
  let reconciled = false;
  const app = await buildApp({
    enabled: true,
    verifier: adapter,
    reconcile: async () => { reconciled = true; return reconciliation; },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const { body, headers } = buildMnsPushRequest(keypair, {
      url: EMAIL_CALLBACK_PATH,
      date: 'Sun, 02 Aug 2026 00:00:00 GMT',
      tamperBodyAfterSigning: true,
    });
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
    assert.equal(response.status, 403, 'a tampered relative-URL MNS push must be rejected, not 500');
    assert.equal(reconciled, false);
  } finally {
    await app.close();
    await adapter.close();
  }
});

test('P5-31 MNS push WITHOUT Content-MD5 is rejected 403 with zero side effects and counts as rejected', async () => {
  const { adapter, keypair } = mnsAdapter();
  let reconciled = false;
  const metrics = new InMemoryMetrics();
  const app = await buildApp({
    enabled: true,
    verifier: adapter,
    reconcile: async () => { reconciled = true; return reconciliation; },
    metrics,
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const { body, headers } = buildMnsPushRequest(keypair, {
      url: EMAIL_CALLBACK_PATH,
      date: 'Sun, 02 Aug 2026 00:00:00 GMT',
      omitContentMd5: true,
    });
    assert.equal(headers['content-md5'], undefined, 'fixture must not emit a Content-MD5 header');
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, { method: 'POST', headers, body });
    assert.equal(response.status, 403, 'an MD5-less MNS push must be rejected, not 500');
    assert.equal(reconciled, false, 'rejection must never reach reconciliation (zero side effects)');
    assert.equal(metrics.get('notifications.email_delivery.callback.rejected'), 1,
      'a missing-Content-MD5 rejection must increment callback.rejected');
  } finally {
    await app.close();
    await adapter.close();
  }
});

test('P5-31 bodyLimit boundary: limit-1 and exact limit accepted, limit+1 rejected 413 with zero side effects', async () => {
  let verifyCalls = 0;
  let reconcileCalls = 0;
  const receivedBodies: string[] = [];
  const metrics = new InMemoryMetrics();
  const app = await buildApp({
    enabled: true,
    verifier: {
      async verifyCallback(input: EmailCallbackVerificationInput): Promise<EmailCallbackFact> {
        verifyCalls += 1;
        receivedBodies.push(input.body);
        return FACT;
      },
    },
    reconcile: async () => { reconcileCalls += 1; return reconciliation; },
    metrics,
  });
  try {
    // Sign the EXACT bytes that are sent and assert the verifier receives those
    // same bytes: the envelope is computed over the canonical body, so any
    // re-encoding/transformation between the parser and the verifier must fail
    // this assertion (the same contract a real verifier enforces via the HMAC).
    for (const size of [EMAIL_CALLBACK_BODY_LIMIT_BYTES - 1, EMAIL_CALLBACK_BODY_LIMIT_BYTES]) {
      const body = 'a'.repeat(size);
      const response = await app.inject({
        method: 'POST',
        url: EMAIL_CALLBACK_PATH,
        headers: hmacEnvelope(body, CALLBACK_SECRET),
        body,
      });
      assert.equal(response.statusCode, 202, `a ${size}-byte body must be accepted`);
      assert.deepEqual(JSON.parse(response.body), { accepted: true });
    }
    assert.equal(verifyCalls, 2, 'both within-limit bodies must reach the verifier');
    assert.deepEqual(receivedBodies, [
      'a'.repeat(EMAIL_CALLBACK_BODY_LIMIT_BYTES - 1),
      'a'.repeat(EMAIL_CALLBACK_BODY_LIMIT_BYTES),
    ], 'the verifier must see the exact original bytes (signature contract)');
    assert.equal(reconcileCalls, 2, 'both within-limit bodies must reach reconciliation');

    const oversized = await app.inject({
      method: 'POST',
      url: EMAIL_CALLBACK_PATH,
      headers: { 'content-type': 'application/json' },
      body: 'a'.repeat(EMAIL_CALLBACK_BODY_LIMIT_BYTES + 1),
    });
    assert.equal(oversized.statusCode, 413, 'a limit+1 body must be rejected with 413 Payload Too Large');
    assert.equal(verifyCalls, 2, 'an oversized body must never reach the verifier');
    assert.equal(reconcileCalls, 2, 'an oversized body must never reach reconciliation');
    assert.equal(metrics.get('notifications.email_delivery.callback.accepted'), 2);
    assert.equal(metrics.get('notifications.email_delivery.callback.rejected'), 0,
      'a transport-level 413 is not a verification rejection');
  } finally {
    await app.close();
  }
});

test('P5-31 a custom configured bodyLimit is enforced by the parser (limit accepted, limit+1 rejected 413)', async () => {
  const customLimit = 4096;
  let verifyCalls = 0;
  let reconcileCalls = 0;
  const app = await buildApp({
    enabled: true,
    verifier: {
      async verifyCallback(): Promise<EmailCallbackFact> { verifyCalls += 1; return FACT; },
    },
    reconcile: async () => { reconcileCalls += 1; return reconciliation; },
    bodyLimitBytes: customLimit,
  });
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: EMAIL_CALLBACK_PATH,
      headers: { 'content-type': 'application/json' },
      body: 'a'.repeat(customLimit),
    });
    assert.equal(accepted.statusCode, 202, 'the custom limit itself must be accepted');
    assert.equal(verifyCalls, 1, 'the within-limit body must reach the verifier');

    const oversized = await app.inject({
      method: 'POST',
      url: EMAIL_CALLBACK_PATH,
      headers: { 'content-type': 'application/json' },
      body: 'a'.repeat(customLimit + 1),
    });
    assert.equal(oversized.statusCode, 413, 'custom limit+1 must be rejected with 413');
    assert.equal(verifyCalls, 1, 'an oversized body must never reach the verifier');
    assert.equal(reconcileCalls, 1, 'an oversized body must never reach reconciliation');
  } finally {
    await app.close();
  }
});

test('P5-31 registration rejects bodyLimit configs outside 1..8MiB and accepts the inclusive boundaries', () => {
  const registerWith = (bodyLimitBytes: number) => () =>
    registerEmailCallbackRoutes(Fastify({ logger: false }), { enabled: true, bodyLimitBytes });
  assert.throws(registerWith(0), TypeError, '0 bytes must be rejected at registration');
  assert.throws(registerWith(8 * 1024 * 1024 + 1), TypeError, '8MiB+1 must be rejected at registration');
  assert.doesNotThrow(registerWith(1), '1 byte is the inclusive lower bound');
  assert.doesNotThrow(registerWith(8 * 1024 * 1024), '8MiB is the inclusive upper bound');
});

test('P5-31 non-Buffer guard: a request without a parsed body fails closed with 500 and no side effects', async () => {
  let verifyCalls = 0;
  let reconcileCalls = 0;
  const metrics = new InMemoryMetrics();
  const app = await buildApp({
    enabled: true,
    verifier: {
      async verifyCallback(): Promise<EmailCallbackFact> { verifyCalls += 1; return FACT; },
    },
    reconcile: async () => { reconcileCalls += 1; return reconciliation; },
    metrics,
  });
  try {
    // A bodyless POST (no content-type, no payload) skips the body parser, so
    // request.body stays undefined: the Buffer.isBuffer guard must fail closed
    // before verification/decoding/reconciliation can run.
    const response = await app.inject({ method: 'POST', url: EMAIL_CALLBACK_PATH });
    assert.equal(response.statusCode, 500, 'a non-Buffer body must fail closed, never verify');
    assert.equal(verifyCalls, 0, 'the guard must stop the request before verification');
    assert.equal(reconcileCalls, 0, 'the guard must stop the request before reconciliation');
    assert.equal(metrics.get('notifications.email_delivery.callback.rejected'), 0);
    assert.equal(metrics.get('notifications.email_delivery.callback.accepted'), 0);
  } finally {
    await app.close();
  }
});

test('FIX-L-061: over-budget IP flood is rejected 429 before verification and fetch/verifier calls stop increasing', async () => {
  // The trusted-IP budget is the low-cost flood stopper: it is consumed BEFORE
  // signature verification / certificate fetching, so once the budget is
  // exhausted the verifier (and therefore any certificate fetch) must never
  // run again, no matter how valid the signed pushes are.
  const limiter = createMemoryEmailCallbackRateLimiter({
    ip: { maxRequests: 2, windowMs: 60_000 },
  });
  let verifyCalls = 0;
  let reconcileCalls = 0;
  const metrics = new InMemoryMetrics();
  const app = await buildApp({
    enabled: true,
    verifier: {
      async verifyCallback(): Promise<EmailCallbackFact> { verifyCalls += 1; return FACT; },
    },
    reconcile: async () => { reconcileCalls += 1; return reconciliation; },
    metrics,
    rateLimiter: limiter,
  });
  try {
    const body = JSON.stringify({ eventType: 'dm:Deliver:Succeed' });
    const headers = hmacEnvelope(body, CALLBACK_SECRET, '2026-08-02T00:00:00.000Z', 'nonce-l061-a');
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({ method: 'POST', url: EMAIL_CALLBACK_PATH, headers, body });
      assert.equal(response.statusCode, 202, `attempt ${index + 1} must be verified while under the budget`);
    }
    assert.equal(verifyCalls, 2, 'both within-budget requests must reach the verifier');
    assert.equal(reconcileCalls, 2);

    const overBudget = await app.inject({ method: 'POST', url: EMAIL_CALLBACK_PATH, headers, body });
    assert.equal(overBudget.statusCode, 429, 'an over-budget request is a fixed 429, never 202/500');
    assert.deepEqual(JSON.parse(overBudget.body), { error: 'rate_limited' },
      'the 429 body must be the fixed rate_limited code (no signature/body PII)');
    assert.equal(overBudget.body.includes(headers['x-known-dm-signature']), false,
      'the signature must never appear in the 429 body');
    assert.equal(overBudget.body.includes(body), false, 'the body must never appear in the 429 body');
    assert.ok(overBudget.headers['retry-after'] !== undefined, 'the 429 carries the standard Retry-After hint');
    // The over-limit request must never reach verification or reconciliation.
    assert.equal(verifyCalls, 2, 'verifier calls must not increase after over-budget');
    assert.equal(reconcileCalls, 2, 'reconcile calls must not increase after over-budget');
    assert.equal(metrics.get('notifications.email_delivery.callback.rate_limited'), 1);
    assert.equal(metrics.get('notifications.email_delivery.callback.accepted'), 2);
    assert.equal(metrics.get('notifications.email_delivery.callback.rejected'), 0,
      'an ingress 429 is not a verification rejection');
  } finally {
    await app.close();
  }
});

test('FIX-L-061: a limiter outage fails closed with 503 and never reaches verification', async () => {
  let verifyCalls = 0;
  const failingLimiter: EmailCallbackRateLimiter = {
    async consume(): Promise<EmailCallbackRateLimitOutcome> {
      return { kind: 'failed', failure: { class: 'unavailable', code: 'rate_limit_unavailable' } };
    },
    readiness() {
      return { status: 'degraded', reason: 'last_command_failed', lastCheckedAtEpochMs: Date.now() };
    },
    async close(): Promise<void> {},
  };
  const metrics = new InMemoryMetrics();
  const app = await buildApp({
    enabled: true,
    verifier: {
      async verifyCallback(): Promise<EmailCallbackFact> { verifyCalls += 1; return FACT; },
    },
    reconcile: async () => reconciliation,
    metrics,
    rateLimiter: failingLimiter,
  });
  try {
    const body = JSON.stringify({ eventType: 'dm:Deliver:Succeed' });
    const response = await app.inject({
      method: 'POST',
      url: EMAIL_CALLBACK_PATH,
      headers: hmacEnvelope(body, CALLBACK_SECRET),
      body,
    });
    assert.equal(response.statusCode, 503, 'a limiter outage must fail closed with 503, never admit unlimited traffic');
    assert.deepEqual(JSON.parse(response.body), { error: 'rate_limit_unavailable' });
    assert.equal(verifyCalls, 0, 'the outage must stop the request before verification');
    assert.equal(metrics.get('notifications.email_delivery.callback.rate_limit_failure'), 1);
    assert.equal(metrics.get('notifications.email_delivery.callback.rejected'), 0);
    assert.equal(metrics.get('notifications.email_delivery.callback.accepted'), 0);
  } finally {
    await app.close();
  }
});

test('FIX-L-061: a disabled surface keeps answering 404 and never consumes limiter capacity', async () => {
  let consumeCalls = 0;
  const countingLimiter: EmailCallbackRateLimiter = {
    async consume(): Promise<EmailCallbackRateLimitOutcome> {
      consumeCalls += 1;
      return { kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } };
    },
    readiness() {
      return { status: 'healthy', reason: 'none', lastCheckedAtEpochMs: Date.now() };
    },
    async close(): Promise<void> {},
  };
  const app = await buildApp({ enabled: false, rateLimiter: countingLimiter });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${address}${EMAIL_CALLBACK_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404);
    assert.equal(consumeCalls, 0, 'a disabled surface must never burn limiter capacity');
  } finally { await app.close(); }
});
