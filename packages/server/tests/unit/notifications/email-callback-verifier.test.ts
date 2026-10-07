import assert from 'node:assert/strict';
import {
  createHmac,
  generateKeyPairSync,
} from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { afterAll, describe, test } from 'vitest';
import {
  AliyunDirectMailAdapter,
  MNS_CERTIFICATE_MAX_BYTES,
  assertMnsCertificateUrlPrefix,
  buildMnsStringToSign,
  createDefaultMnsCertificateFetcher,
  type MnsCertificateFetcher,
} from '../../../src/infrastructure/email/aliyun-directmail-adapter.js';
import {
  startScriptedTlsServer,
  streamBodyWithBackpressure,
  waitForServerResponseSettle,
} from '../../support/scripted-tls-server.js';
import { EmailCallbackRejectedError } from '../../../src/modules/notifications/index.js';
import {
  MNS_TEST_CERT_URL,
  buildMnsPushRequest,
  buildMnsStringToSignFixture,
  createSelfSignedTestCertificate,
} from '../../support/phase5-mns-push.js';
import { readEmailEntryFixtureTls } from '../../../scripts/evidence/phase5-email-entry-fixture.js';

const CALLBACK_SECRET = 'p528-callback-secret';

function adapterWithCallback(overrides: {
  readonly callbackHmacSecret?: string | null;
  readonly callbackTimestampReplayWindowMs?: number;
  readonly mnsCertificateFetcher?: MnsCertificateFetcher;
} = {}): AliyunDirectMailAdapter {
  return new AliyunDirectMailAdapter({
    endpoint: 'https://dm.aliyuncs.com/',
    regionId: 'cn-hangzhou',
    accountName: 'sender@example.invalid',
    accessKeyId: 'P528FIXTUREAKID',
    accessKeySecret: 'p528-fixture-key',
    timeoutMs: 1_000,
    tagPrefix: 'known-delivery-',
    maxTagChars: 128,
    callbackHmacSecret: 'callbackHmacSecret' in overrides ? overrides.callbackHmacSecret : CALLBACK_SECRET,
    callbackTimestampReplayWindowMs: overrides.callbackTimestampReplayWindowMs ?? 300_000,
    mnsCertificateFetcher: overrides.mnsCertificateFetcher,
  });
}

function assertRejected(promise: Promise<unknown>, reason: string): Promise<void> {
  return promise.then(
    () => { throw new Error(`expected EmailCallbackRejectedError(${reason})`); },
    (error: unknown) => {
      assert.ok(error instanceof EmailCallbackRejectedError, `expected rejection, got ${String(error)}`);
      assert.equal(error.reason, reason);
    },
  );
}

function eventBridgeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixture-event-deliver-success-1',
    source: 'acs.dm',
    specversion: '1.0',
    type: 'dm:Deliver:Succeed',
    data: {
      header: { 'X-Notify-Message-ID': 'fixture-notify-1' },
      env_id: '60000success',
      msg_id: 'fixture-msg-1@example.invalid',
      rcpt: 'recipient@example.invalid',
      status: '0',
      tag: 'p528-delivery-success',
      deliver_time: '2026-08-02T00:00:12',
    },
    ...overrides,
  };
}

function hmacEnvelopeHeaders(body: string, overrides: Record<string, string> = {}): Record<string, string> {
  const timestamp = overrides['x-known-dm-timestamp'] ?? new Date(Date.now() - 60_000).toISOString();
  const nonce = overrides['x-known-dm-nonce'] ?? 'nonce-1';
  const signature = createHmac('sha256', CALLBACK_SECRET)
    .update(`${body}\n${timestamp}\n${nonce}`)
    .digest('base64');
  return {
    'x-known-dm-signature': overrides['x-known-dm-signature'] ?? signature,
    'x-known-dm-timestamp': timestamp,
    'x-known-dm-nonce': nonce,
    'content-type': 'application/json',
  };
}

describe('MNS HTTP push RSA-SHA1 verification', () => {
  const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = createSelfSignedTestCertificate(keypair);

  test('valid MNS push with a real RSA keypair is accepted and returns only stable facts', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const { body, headers, url } = buildMnsPushRequest(keypair);
      const fact = await adapter.verifyCallback({ method: 'POST', url, headers, body });
      assert.equal(fact.kind, 'bounced');
      assert.equal(fact.providerMessageId, '12625010655');
      assert.equal(fact.recipient, 'recipient@example.invalid');
      assert.equal(fact.tag, undefined);
      assert.equal(fact.occurredAt, '2026-08-02T00:00:01');
      assert.deepEqual(Object.keys(fact).sort(), ['kind', 'occurredAt', 'providerMessageId', 'recipient']);
    } finally {
      await adapter.close();
    }
  });

  test('the adapter string-to-sign builder matches the documented independent builder (absolute and relative)', () => {
    for (const url of [
      'https://mns.example/notifications?code=200',
      '/api/v1/email/callbacks/delivery',
      '/api/v1/email/callbacks/delivery?code=200&x=%2F',
    ]) {
      const { headers } = buildMnsPushRequest(keypair, { url });
      const expected = buildMnsStringToSignFixture({ method: 'POST', url, headers });
      const actual = buildMnsStringToSign({
        method: 'POST',
        url,
        headers,
        contentMd5: headers['content-md5'] ?? '',
        contentType: headers['content-type'] ?? '',
        date: headers.date ?? '',
      });
      assert.equal(actual, expected, url);
    }
  });

  test('valid MNS push over the real relative request target is accepted (real ingress contract)', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const { body, headers } = buildMnsPushRequest(keypair, { url: '/api/v1/email/callbacks/delivery' });
      const fact = await adapter.verifyCallback({
        method: 'POST', url: '/api/v1/email/callbacks/delivery', headers, body,
      });
      assert.equal(fact.kind, 'bounced');
      assert.equal(fact.providerMessageId, '12625010655');
      assert.equal(fact.recipient, 'recipient@example.invalid');
      assert.equal(fact.occurredAt, '2026-08-02T00:00:01');
    } finally {
      await adapter.close();
    }
  });

  test('tampered body and expired Date are still rejected on the relative request target', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const tampered = buildMnsPushRequest(keypair, {
        url: '/api/v1/email/callbacks/delivery', tamperBodyAfterSigning: true,
      });
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: '/api/v1/email/callbacks/delivery',
        headers: tampered.headers, body: tampered.body,
      }), 'signature_mismatch');

      const stale = new Date(Date.now() - 16 * 60 * 1_000).toUTCString();
      const expired = buildMnsPushRequest(keypair, {
        url: '/api/v1/email/callbacks/delivery', date: stale,
      });
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: '/api/v1/email/callbacks/delivery',
        headers: expired.headers, body: expired.body,
      }), 'expired_timestamp');
    } finally {
      await adapter.close();
    }
  });

  test('malformed relative request targets fail closed with EmailCallbackRejectedError, never a TypeError', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      for (const malformed of ['?', '', 'relative-without-leading-slash']) {
        const { body, headers } = buildMnsPushRequest(keypair);
        await assertRejected(adapter.verifyCallback({
          method: 'POST', url: malformed, headers, body,
        }), 'signature_mismatch');
      }
    } finally {
      await adapter.close();
    }
  });

  test('tampered body is rejected (Content-MD5 integrity check)', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const { body, headers, url } = buildMnsPushRequest(keypair, { tamperBodyAfterSigning: true });
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'signature_mismatch');
    } finally {
      await adapter.close();
    }
  });

  test('MNS push WITHOUT Content-MD5 is rejected even with a valid RSA signature (fail closed)', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      // Signed exactly as a real MD5-less push: the string-to-sign carries an
      // empty Content-MD5 slot and the RSA signature verifies, but the body is
      // outside the signature - the verifier must fail closed, never parse it.
      const { body, headers, url } = buildMnsPushRequest(keypair, { omitContentMd5: true });
      assert.equal(headers['content-md5'], undefined, 'fixture must not emit a Content-MD5 header');
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'missing_content_md5');
    } finally {
      await adapter.close();
    }
  });

  test('MNS push with a WRONG Content-MD5 header is rejected (integrity check preserved)', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      // The RSA signature is valid over the true MD5; only the on-the-wire
      // header is wrong, so only the Content-MD5 integrity check can catch it.
      const { body, headers, url } = buildMnsPushRequest(keypair, {
        contentMd5: Buffer.alloc(16).toString('base64'),
      });
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'signature_mismatch');
    } finally {
      await adapter.close();
    }
  });

  test('valid MNS push with the correct Content-MD5 is accepted (regression)', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const { body, headers, url } = buildMnsPushRequest(keypair);
      assert.ok(headers['content-md5'], 'fixture must emit a Content-MD5 header by default');
      const fact = await adapter.verifyCallback({ method: 'POST', url, headers, body });
      assert.equal(fact.kind, 'bounced');
      assert.equal(fact.providerMessageId, '12625010655');
    } finally {
      await adapter.close();
    }
  });

  test('expired Date outside the 15-minute window is rejected', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const stale = new Date(Date.now() - 16 * 60 * 1_000).toUTCString();
      const { body, headers, url } = buildMnsPushRequest(keypair, { date: stale });
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'expired_timestamp');
    } finally {
      await adapter.close();
    }
  });

  test('m3/A3: MNS Date within the bounded future skew is accepted; beyond it or past the window is rejected', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const now = new Date('2026-08-02T12:00:00.000Z');
      // Future within the 60s clock-skew tolerance: accepted.
      const within = buildMnsPushRequest(keypair,
        { date: new Date(now.getTime() + 30_000).toUTCString() });
      const fact = await adapter.verifyCallback({ method: 'POST', url: within.url,
        headers: within.headers, body: within.body, now });
      assert.equal(fact.kind, 'bounced');
      // Future beyond the skew: rejected (official 'received after sent' semantics).
      const beyond = buildMnsPushRequest(keypair,
        { date: new Date(now.getTime() + 2 * 60_000).toUTCString() });
      await assertRejected(adapter.verifyCallback({ method: 'POST', url: beyond.url,
        headers: beyond.headers, body: beyond.body, now }), 'expired_timestamp');
      // Past beyond the 15-minute window with the same exact clock: rejected.
      const stale = buildMnsPushRequest(keypair,
        { date: new Date(now.getTime() - 16 * 60_000).toUTCString() });
      await assertRejected(adapter.verifyCallback({ method: 'POST', url: stale.url,
        headers: stale.headers, body: stale.body, now }), 'expired_timestamp');
    } finally {
      await adapter.close();
    }
  });

  test('wrong certificate URL prefix is rejected without fetching', async () => {
    let fetched = false;
    const adapter = adapterWithCallback({
      callbackHmacSecret: null,
      mnsCertificateFetcher: {
        async fetchCertificate() { fetched = true; return certPem; },
      },
    });
    try {
      const { body, headers, url } = buildMnsPushRequest(keypair, { certUrl: 'https://evil.example/x509_public_certificate.pem' });
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'invalid_certificate_url');
      assert.equal(fetched, false, 'certificate must not be fetched for a disallowed prefix');
    } finally {
      await adapter.close();
    }
  });

  test('FIX-L-061: a wrong certificate PATH under a whitelisted host is rejected without fetching (exact allowlist)', async () => {
    let fetched = false;
    const adapter = adapterWithCallback({
      callbackHmacSecret: null,
      mnsCertificateFetcher: {
        async fetchCertificate() { fetched = true; return certPem; },
      },
    });
    try {
      // The exact-path policy closes the FIX-L-061 amplification: an
      // unauthenticated flood that rotates paths under the whitelisted host
      // (cache misses -> outbound fetches) is rejected before any fetch.
      for (const certUrl of [
        'https://mns-cert.oss-cn-hangzhou.aliyuncs.com/x509.pem',
        'https://mns-cert.oss-cn-hangzhou.aliyuncs.com/certs/x509_public_certificate.pem',
        'https://mns-cert.oss-cn-hangzhou.aliyuncs.com/x509_public_certificate.pem/extra',
      ]) {
        const { body, headers, url } = buildMnsPushRequest(keypair, { certUrl });
        await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }),
          'invalid_certificate_url');
      }
      assert.equal(fetched, false, 'no path variant may reach the certificate fetcher');
    } finally {
      await adapter.close();
    }
  });

  test('FIX-L-061: a WRONG Content-MD5 is rejected BEFORE the certificate is fetched', async () => {
    let fetched = false;
    const adapter = adapterWithCallback({
      callbackHmacSecret: null,
      mnsCertificateFetcher: {
        async fetchCertificate() { fetched = true; return certPem; },
      },
    });
    try {
      // The RSA signature is valid over the true MD5; only the on-the-wire
      // header is wrong. The integrity check is a pure-local cheap check and
      // must run before the outbound certificate fetch (FIX-L-061).
      const { body, headers, url } = buildMnsPushRequest(keypair, {
        contentMd5: Buffer.alloc(16).toString('base64'),
      });
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'signature_mismatch');
      assert.equal(fetched, false, 'an MD5-mismatched push must never fetch the certificate');
    } finally {
      await adapter.close();
    }
  });

  test('FIX-L-061: a push WITHOUT Content-MD5 is rejected BEFORE the certificate is fetched', async () => {
    let fetched = false;
    const adapter = adapterWithCallback({
      callbackHmacSecret: null,
      mnsCertificateFetcher: {
        async fetchCertificate() { fetched = true; return certPem; },
      },
    });
    try {
      const { body, headers, url } = buildMnsPushRequest(keypair, { omitContentMd5: true });
      assert.equal(headers['content-md5'], undefined, 'fixture must not emit a Content-MD5 header');
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'missing_content_md5');
      assert.equal(fetched, false, 'an MD5-less push must never fetch the certificate');
    } finally {
      await adapter.close();
    }
  });

  test('non-base64 certificate URL header is rejected', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const { body, headers, url } = buildMnsPushRequest(keypair);
      headers['x-mns-signing-cert-url'] = '!!!not-a-certificate-url!!!';
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'invalid_certificate_url');
    } finally {
      await adapter.close();
    }
  });

  test('missing signature headers are rejected', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      await assertRejected(adapter.verifyCallback({
        method: 'POST',
        url: 'https://mns.example/notifications',
        headers: { 'content-type': 'text/plain' },
        body: 'a=1&b=2',
      }), 'missing_signature_headers');
    } finally {
      await adapter.close();
    }
  });

  test('signature made by a different keypair is rejected', async () => {
    const otherKeypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const { body, headers, url } = buildMnsPushRequest(otherKeypair);
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'signature_mismatch');
    } finally {
      await adapter.close();
    }
  });

  test('certificate fetch failure is rejected as invalid certificate', async () => {
    const adapter = adapterWithCallback({
      callbackHmacSecret: null,
      mnsCertificateFetcher: {
        async fetchCertificate() { throw new Error('certificate endpoint unreachable'); },
      },
    });
    try {
      const { body, headers, url } = buildMnsPushRequest(keypair);
      await assertRejected(adapter.verifyCallback({ method: 'POST', url, headers, body }), 'invalid_certificate_url');
    } finally {
      await adapter.close();
    }
  });

  test('certificate URL prefix validator accepts only the exact documented Aliyun certificate URLs', () => {
    // FIX-L-061: the allowlist is EXACT — the whitelisted hosts plus the
    // single documented certificate filename. Any other path (the previous
    // loose prefix match) would let an unauthenticated flood rotate paths to
    // force cache misses and outbound fetches.
    assert.equal(assertMnsCertificateUrlPrefix(
      'https://mnstest.oss-cn-hangzhou.aliyuncs.com/x509_public_certificate.pem'), true);
    assert.equal(assertMnsCertificateUrlPrefix(MNS_TEST_CERT_URL), true);
    assert.equal(assertMnsCertificateUrlPrefix(
      'https://mns-cert.oss-cn-beijing.aliyuncs.com/x509_public_certificate.pem'), true);
    for (const url of [
      'https://mnstest.oss-cn-hangzhou.aliyuncs.com/x509.pem',
      'https://mns-cert.oss-cn-hangzhou.aliyuncs.com/x509.pem',
      'https://mns-cert.oss-cn-hangzhou.aliyuncs.com/other/x509_public_certificate.pem',
      'https://evil.example/x509_public_certificate.pem',
      'http://mns-cert.oss-cn-hangzhou.aliyuncs.com/x509_public_certificate.pem',
      'https://mns-cert.oss-cn-hangzhou.evil.com/x509_public_certificate.pem',
      'https://mns-cert.oss-cn-hangzhou.aliyuncs.com.evil/x509_public_certificate.pem',
      'ftp://mns-cert.oss-cn-hangzhou.aliyuncs.com/x509_public_certificate.pem',
      'https://notmns.aliyuncs.com/x509_public_certificate.pem',
      'https://mns-cert.oss-cn-hangzhou.aliyuncs.com/x509_public_certificate.pem?x=1',
    ]) {
      assert.equal(assertMnsCertificateUrlPrefix(url), false, url);
    }
  });

  test('FIX-L-059: legacy MNS unsubscribe/subscribe events verify WITHOUT a status field (event-first)', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const base = [
        'X-Notify-Message-ID=3121639760461824',
        'env_id=12625010655',
        'msg_id=ac349efc-0d79-489b-affa-f178dce3e49e@example.com',
        'from=sender@example.invalid',
        'rcpt=recipient@example.invalid',
        'recv_time=2026-08-02T00:00:00',
        'end_time=2026-08-02T00:00:01',
      ];
      // The legacy unsubscribe event carries NO status field: the previous
      // adapter forced status to exist and the classifier ignored the event,
      // so this push could not be verified as unsubscribed. The event must be
      // authoritative now.
      const unsubscribe = buildMnsPushRequest(keypair, { body: [...base, 'event=unsubscribe'].join('&') });
      const fact = await adapter.verifyCallback({
        method: 'POST', url: unsubscribe.url, headers: unsubscribe.headers, body: unsubscribe.body,
      });
      assert.equal(fact.kind, 'unsubscribed');
      assert.equal(fact.providerMessageId, '12625010655');
      assert.equal(fact.recipient, 'recipient@example.invalid');

      const subscribe = buildMnsPushRequest(keypair, { body: [...base, 'event=subscribe'].join('&') });
      const subscribed = await adapter.verifyCallback({
        method: 'POST', url: subscribe.url, headers: subscribe.headers, body: subscribe.body,
      });
      assert.equal(subscribed.kind, 'subscribed');
      assert.equal(subscribed.providerMessageId, '12625010655');
    } finally {
      await adapter.close();
    }
  });

  test('FIX-L-059: legacy MNS deliver event without status or with an undocumented status value fails closed', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const base = 'X-Notify-Message-ID=1&env_id=12625010655&msg_id=m@example.com'
        + '&rcpt=recipient@example.invalid&event=deliver';
      // The old classifier defaulted a status-less deliver to BOUNCED; it must
      // now be rejected as an unprovable combination (never delivered/bounced).
      const noStatus = buildMnsPushRequest(keypair, { body: base });
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: noStatus.url, headers: noStatus.headers, body: noStatus.body,
      }), 'unknown_event_type');
      // Undocumented status value on deliver.
      const badStatus = buildMnsPushRequest(keypair, { body: `${base}&status=9` });
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: badStatus.url, headers: badStatus.headers, body: badStatus.body,
      }), 'unknown_event_type');
    } finally {
      await adapter.close();
    }
  });

  test('FIX-L-059: legacy MNS conflicting and unknown event/status combinations fail closed', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const base = 'X-Notify-Message-ID=1&env_id=12625010655&msg_id=m@example.com'
        + '&rcpt=recipient@example.invalid';
      // A status field on a non-deliver event is an undocumented combination
      // (status only exists for deliver): conflict -> fail closed.
      const conflict = buildMnsPushRequest(keypair, { body: `${base}&event=unsubscribe&status=0` });
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: conflict.url, headers: conflict.headers, body: conflict.body,
      }), 'unknown_event_type');
      // Unknown event with a plausible status value.
      const unknown = buildMnsPushRequest(keypair, { body: `${base}&event=dm:Future:Event&status=0` });
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: unknown.url, headers: unknown.headers, body: unknown.body,
      }), 'unknown_event_type');
      // Missing event discriminator: malformed, never status-defaulted to delivered.
      const noEvent = buildMnsPushRequest(keypair, { body: `${base}&status=0` });
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: noEvent.url, headers: noEvent.headers, body: noEvent.body,
      }), 'malformed_callback_body');
    } finally {
      await adapter.close();
    }
  });

  test('FIX-L-059: legacy MNS deliver status still resolves delivered/complaint over the verified path', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null, mnsCertificateFetcher: { async fetchCertificate() { return certPem; } } });
    try {
      const base = 'X-Notify-Message-ID=1&env_id=12625010655&msg_id=m@example.com'
        + '&rcpt=recipient@example.invalid&event=deliver&err_code=250&failed_type=SendOk';
      const ok = buildMnsPushRequest(keypair, { body: `${base}&status=0` });
      const delivered = await adapter.verifyCallback({
        method: 'POST', url: ok.url, headers: ok.headers, body: ok.body,
      });
      assert.equal(delivered.kind, 'delivered');
      const spam = buildMnsPushRequest(keypair, { body: `${base}&status=3` });
      const complaint = await adapter.verifyCallback({
        method: 'POST', url: spam.url, headers: spam.headers, body: spam.body,
      });
      assert.equal(complaint.kind, 'complaint');
    } finally {
      await adapter.close();
    }
  });

  test('a valid MNS push is not admitted when the deployment HMAC secret is configured', async () => {
    const adapter = adapterWithCallback({
      mnsCertificateFetcher: { async fetchCertificate() { return certPem; } },
    });
    try {
      const unsubscribe = buildMnsPushRequest(keypair, {
        body: [
          'X-Notify-Message-ID=3121639760461824',
          'env_id=12625010655',
          'msg_id=ac349efc-0d79-489b-affa-f178dce3e49e@example.com',
          'from=sender@example.invalid',
          'rcpt=dummy-nv03@example.invalid',
          'recv_time=2026-08-02T00:00:00',
          'end_time=2026-08-02T00:00:01',
          'event=unsubscribe',
        ].join('&'),
      });
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: unsubscribe.url, headers: unsubscribe.headers, body: unsubscribe.body,
      }), 'missing_signature_headers');
    } finally {
      await adapter.close();
    }
  });
});

describe('EventBridge/controlled-sink HMAC envelope verification', () => {
  test('valid envelope is accepted and returns only stable facts', async () => {
    const adapter = adapterWithCallback();
    try {
      const body = JSON.stringify(eventBridgeEvent());
      const headers = hmacEnvelopeHeaders(body);
      const fact = await adapter.verifyCallback({
        method: 'POST',
        url: 'https://dm.example/events',
        headers,
        body,
      });
      assert.equal(fact.kind, 'delivered');
      assert.equal(fact.providerMessageId, '60000success');
      assert.equal(fact.recipient, 'recipient@example.invalid');
      assert.equal(fact.tag, 'p528-delivery-success');
      assert.equal(fact.occurredAt, '2026-08-02T00:00:12');
    } finally {
      await adapter.close();
    }
  });

  test('real FblReport envelope is verified and maps block_email/message_id/block_time', async () => {
    const adapter = adapterWithCallback();
    try {
      const body = JSON.stringify({
        id: 'fixture-event-fbl-report-1',
        source: 'acs.dm',
        specversion: '1.0',
        type: 'dm:Feedback:FblReport',
        data: {
          send_time: '1726821644',
          send_email: 'sender@example.invalid',
          block_email: 'recipient@example.invalid',
          subject: 'P528-SUBJECT-MARKER',
          message_id: '<fixture-msg-3@example.invalid>',
          block_time: '1726821667',
          fbl_isp: 'outlook',
          fingerprint: 'SMTPD_fixture****',
        },
      });
      const headers = hmacEnvelopeHeaders(body);
      const fact = await adapter.verifyCallback({
        method: 'POST',
        url: 'https://dm.example/events',
        headers,
        body,
      });
      assert.equal(fact.kind, 'complaint');
      assert.equal(fact.recipient, 'recipient@example.invalid',
        'FblReport block_email must surface as the verified fact recipient');
      assert.equal(fact.providerMessageId, '<fixture-msg-3@example.invalid>',
        'FblReport message_id must surface as the provider message id');
      assert.equal(fact.occurredAt, '1726821667',
        'FblReport block_time must surface as the verified fact occurredAt');
      assert.deepEqual(Object.keys(fact).sort(), ['kind', 'occurredAt', 'providerMessageId', 'recipient']);
    } finally {
      await adapter.close();
    }
  });

  test('real UnSubscribe/Subscribe envelopes map envid/rcpt/operate_time (both spellings accepted)', async () => {
    const adapter = adapterWithCallback();
    try {
      const unsubscribeBody = JSON.stringify({
        id: 'fixture-event-unsubscribe-1',
        source: 'acs.dm',
        specversion: '1.0',
        type: 'dm:Feedback:UnSubscribe',
        data: {
          operate_time: '2024-04-29T11:25:48',
          envid: '60000unsub',
          from: 'sender@example.invalid',
          rcpt: 'recipient@example.invalid',
          client_ip: '102.**.**.1',
        },
      });
      const unsubscribe = await adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events',
        headers: hmacEnvelopeHeaders(unsubscribeBody), body: unsubscribeBody,
      });
      assert.equal(unsubscribe.kind, 'unsubscribed');
      assert.equal(unsubscribe.providerMessageId, '60000unsub',
        'UnSubscribe envid must surface as the verified fact providerMessageId');
      assert.equal(unsubscribe.recipient, 'recipient@example.invalid');
      assert.equal(unsubscribe.occurredAt, '2024-04-29T11:25:48',
        'UnSubscribe operate_time must surface as the verified fact occurredAt');
      assert.deepEqual(Object.keys(unsubscribe).sort(), ['kind', 'occurredAt', 'providerMessageId', 'recipient']);

      const subscribeBody = JSON.stringify({
        id: 'fixture-event-subscribe-1',
        source: 'acs.dm',
        specversion: '1.0',
        type: 'dm:Feedback:Subscribe',
        data: {
          operate_time: '2024-04-29T11:26:48',
          envid: '60000sub',
          from: 'sender@example.invalid',
          rcpt: 'recipient@example.invalid',
          client_ip: '102.**.**.1',
        },
      });
      const subscribe = await adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events',
        headers: hmacEnvelopeHeaders(subscribeBody), body: subscribeBody,
      });
      assert.equal(subscribe.kind, 'subscribed');
      assert.equal(subscribe.providerMessageId, '60000sub',
        'Subscribe envid must surface as the verified fact providerMessageId');

      // Documented fallback: the env_id spelling is accepted too, and envid
      // wins when both are present (first-field-wins precedence).
      const envIdSpellingBody = JSON.stringify({
        id: 'fixture-event-unsubscribe-env-id',
        source: 'acs.dm', specversion: '1.0', type: 'dm:Feedback:UnSubscribe',
        data: { operate_time: '2024-04-29T11:27:48', env_id: '60000unsub-env-id',
          rcpt: 'recipient@example.invalid' },
      });
      const envIdSpelling = await adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events',
        headers: hmacEnvelopeHeaders(envIdSpellingBody), body: envIdSpellingBody,
      });
      assert.equal(envIdSpelling.providerMessageId, '60000unsub-env-id',
        'the env_id spelling must still be verified to a providerMessageId');
    } finally {
      await adapter.close();
    }
  });

  test('tampered body is rejected', async () => {
    const adapter = adapterWithCallback();
    try {
      const body = JSON.stringify(eventBridgeEvent());
      const headers = hmacEnvelopeHeaders(body);
      const tampered = `${body.slice(0, -1)} }`;
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events', headers, body: tampered,
      }), 'signature_mismatch');
    } finally {
      await adapter.close();
    }
  });

  test('wrong secret is rejected', async () => {
    const adapter = adapterWithCallback();
    try {
      const body = JSON.stringify(eventBridgeEvent());
      const timestamp = '2026-08-02T00:00:00Z';
      const nonce = 'nonce-1';
      const wrong = createHmac('sha256', 'p528-other-secret')
        .update(`${body}\n${timestamp}\n${nonce}`).digest('base64');
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events',
        headers: hmacEnvelopeHeaders(body, { 'x-known-dm-signature': wrong }),
        body,
      }), 'signature_mismatch');
    } finally {
      await adapter.close();
    }
  });

  test('expired or invalid timestamps are rejected', async () => {
    const adapter = adapterWithCallback({ callbackTimestampReplayWindowMs: 300_000 });
    try {
      const body = JSON.stringify(eventBridgeEvent());
      const stale = new Date(Date.now() - 6 * 60 * 1_000).toISOString();
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events',
        headers: hmacEnvelopeHeaders(body, { 'x-known-dm-timestamp': stale }),
        body,
      }), 'expired_timestamp');

      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events',
        headers: hmacEnvelopeHeaders(body, { 'x-known-dm-timestamp': 'not-a-timestamp' }),
        body,
      }), 'expired_timestamp');
    } finally {
      await adapter.close();
    }
  });

  test('m3/A3: HMAC timestamp within the bounded future skew is accepted; beyond it or past the window is rejected', async () => {
    const adapter = adapterWithCallback({ callbackTimestampReplayWindowMs: 300_000 });
    try {
      const now = new Date('2026-08-02T12:00:00.000Z');
      const body = JSON.stringify(eventBridgeEvent());
      // Future within the 60s clock-skew tolerance: accepted.
      const within = hmacEnvelopeHeaders(body,
        { 'x-known-dm-timestamp': new Date(now.getTime() + 30_000).toISOString() });
      const fact = await adapter.verifyCallback({ method: 'POST', url: 'https://dm.example/events',
        headers: within, body, now });
      assert.equal(fact.kind, 'delivered');
      // Future beyond the skew: rejected.
      const beyond = hmacEnvelopeHeaders(body,
        { 'x-known-dm-timestamp': new Date(now.getTime() + 2 * 60_000).toISOString() });
      await assertRejected(adapter.verifyCallback({ method: 'POST', url: 'https://dm.example/events',
        headers: beyond, body, now }), 'expired_timestamp');
      // Past beyond the replay window with the same exact clock: rejected.
      const stale = hmacEnvelopeHeaders(body,
        { 'x-known-dm-timestamp': new Date(now.getTime() - 6 * 60_000).toISOString() });
      await assertRejected(adapter.verifyCallback({ method: 'POST', url: 'https://dm.example/events',
        headers: stale, body, now }), 'expired_timestamp');
    } finally {
      await adapter.close();
    }
  });

  test('missing envelope headers are rejected', async () => {
    const adapter = adapterWithCallback();
    try {
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(eventBridgeEvent()),
      }), 'missing_signature_headers');
    } finally {
      await adapter.close();
    }
  });

  test('unconfigured HMAC secret rejects with not_configured', async () => {
    const adapter = adapterWithCallback({ callbackHmacSecret: null });
    try {
      const body = JSON.stringify(eventBridgeEvent());
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events',
        headers: hmacEnvelopeHeaders(body), body,
      }), 'not_configured');
    } finally {
      await adapter.close();
    }
  });

  test('unknown event types are rejected (reserved for future versions)', async () => {
    const adapter = adapterWithCallback();
    try {
      const body = JSON.stringify(eventBridgeEvent({ type: 'dm:Future:Event' }));
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events', headers: hmacEnvelopeHeaders(body), body,
      }), 'unknown_event_type');
    } finally {
      await adapter.close();
    }
  });

  test('validly signed non-JSON body is rejected as malformed', async () => {
    const adapter = adapterWithCallback();
    try {
      const body = 'this is not json';
      await assertRejected(adapter.verifyCallback({
        method: 'POST', url: 'https://dm.example/events', headers: hmacEnvelopeHeaders(body), body,
      }), 'malformed_callback_body');
    } finally {
      await adapter.close();
    }
  });

  test('callback replay: the same event verified twice yields identical stable facts', async () => {
    const adapter = adapterWithCallback();
    try {
      const body = JSON.stringify(eventBridgeEvent());
      const headers = hmacEnvelopeHeaders(body);
      const first = await adapter.verifyCallback({ method: 'POST', url: 'https://dm.example/events', headers, body });
      const second = await adapter.verifyCallback({ method: 'POST', url: 'https://dm.example/events', headers, body });
      assert.deepEqual(first, second);
    } finally {
      await adapter.close();
    }
  });
});

describe('default MNS certificate fetcher caches per URL', () => {
  let server: Server | undefined;
  let served = 0;
  const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = createSelfSignedTestCertificate(keypair);
  const tls = readEmailEntryFixtureTls();

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
  });

  test('fetching the same certificate URL twice performs one network fetch', async () => {
    const port = await new Promise<number>((resolveListen, reject) => {
      server = createServer({ cert: tls.cert, key: tls.key }, (_request, response) => {
        served += 1;
        response.writeHead(200, { 'Content-Type': 'application/x-pem-file' });
        response.end(certPem);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (address && typeof address === 'object') resolveListen(address.port);
        else reject(new Error('failed to bind'));
      });
    });
    const fetcher = createDefaultMnsCertificateFetcher({ rejectUnauthorized: false, timeoutMs: 2_000 });
    const url = `https://127.0.0.1:${port}/x509_public_certificate.pem`;
    const first = await fetcher.fetchCertificate(url);
    const second = await fetcher.fetchCertificate(url);
    assert.equal(first, certPem);
    assert.equal(second, certPem);
    assert.equal(served, 1);
  });

  test('FIX-L-061: semantically-equivalent certificate URLs share ONE cache entry (query/port variants never re-fetch)', async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
    const port = await new Promise<number>((resolveListen, reject) => {
      server = createServer({ cert: tls.cert, key: tls.key }, (_request, response) => {
        served += 1;
        response.writeHead(200, { 'Content-Type': 'application/x-pem-file' });
        response.end(certPem);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (address && typeof address === 'object') resolveListen(address.port);
        else reject(new Error('failed to bind'));
      });
    });
    const fetcher = createDefaultMnsCertificateFetcher({ rejectUnauthorized: false, timeoutMs: 2_000 });
    const base = `https://127.0.0.1:${port}/x509_public_certificate.pem`;
    const servedBefore = served;
    // Query and fragment variants normalize to the same cache key: the second
    // and third fetches are served from cache, so the network saw ONE request.
    const first = await fetcher.fetchCertificate(base);
    const second = await fetcher.fetchCertificate(`${base}?x=1`);
    const third = await fetcher.fetchCertificate(`${base}#frag`);
    assert.equal(first, certPem);
    assert.equal(second, certPem);
    assert.equal(third, certPem);
    assert.equal(served - servedBefore, 1, 'query/fragment variants must not force additional network fetches');
  });

  test('FIX-L-061: the default fetcher fails closed on non-https certificate URLs', async () => {
    const fetcher = createDefaultMnsCertificateFetcher({ rejectUnauthorized: false, timeoutMs: 2_000 });
    await assert.rejects(fetcher.fetchCertificate('http://127.0.0.1/x509_public_certificate.pem'),
      /https/u, 'a non-https certificate URL must never be fetched');
  });
});

describe('default MNS certificate fetcher bounds response bytes (FIX-L-060)', () => {
  const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = createSelfSignedTestCertificate(keypair);

  function fetcher(): ReturnType<typeof createDefaultMnsCertificateFetcher> {
    return createDefaultMnsCertificateFetcher({ rejectUnauthorized: false, timeoutMs: 2_000 });
  }

  test('a fake oversized Content-Length is rejected before the body is read', async () => {
    const server = await startScriptedTlsServer(async (response) => {
      response.writeHead(200, {
        'Content-Type': 'application/x-pem-file',
        'Content-Length': String(MNS_CERTIFICATE_MAX_BYTES + 1),
      });
      response.end(certPem);
    });
    try {
      await assert.rejects(fetcher().fetchCertificate(`${server.origin}/cert.pem`),
        /MNS certificate response exceeded \d+ bytes/u);
    } finally {
      await server.close();
    }
  });

  test('a chunked response without Content-Length is destroyed at the byte limit', async () => {
    // 64 MiB: far larger than loopback socket buffers (~10 MiB worst case), so
    // the server is forced into backpressure and cannot complete the body
    // before the client aborts at the byte limit (deterministic early close).
    const oversized = 'z'.repeat(MNS_CERTIFICATE_MAX_BYTES * 1024);
    const server = await startScriptedTlsServer(async (response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-pem-file' });
      await streamBodyWithBackpressure(response, oversized);
    });
    try {
      await assert.rejects(fetcher().fetchCertificate(`${server.origin}/cert.pem`),
        /MNS certificate response exceeded \d+ bytes/u);
      // The 64 MiB body cannot fit in socket buffers, so the server is still
      // mid-write when the client aborts at the byte limit: it must never
      // complete the body. Waiting lets a regression (no destroy) surface as
      // the server finishing the full oversized body instead.
      await waitForServerResponseSettle(server);
      assert.equal(server.stats.finished, false, 'the server must not complete the oversized body');
    } finally {
      await server.close();
    }
    // The client released the connection at the byte limit; the server-side
    // 'close' event follows asynchronously (loopback round trip), so wait for
    // it before asserting.
    await waitForServerResponseSettle(server);
    assert.equal(server.stats.closedBeforeFinish, true, 'the connection must be released before the body completes');
  });

  test('a response body of exactly the byte limit succeeds', async () => {
    const body = 'p'.repeat(MNS_CERTIFICATE_MAX_BYTES);
    const server = await startScriptedTlsServer(async (response) => {
      response.writeHead(200, {
        'Content-Type': 'application/x-pem-file',
        'Content-Length': String(MNS_CERTIFICATE_MAX_BYTES),
      });
      response.end(body);
    });
    try {
      const pem = await fetcher().fetchCertificate(`${server.origin}/cert.pem`);
      assert.equal(pem, body);
    } finally {
      await server.close();
    }
  });

  test('a chunked body one byte over the limit is rejected', async () => {
    const body = 'q'.repeat(MNS_CERTIFICATE_MAX_BYTES + 1);
    const server = await startScriptedTlsServer(async (response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-pem-file' });
      await streamBodyWithBackpressure(response, body);
    });
    try {
      await assert.rejects(fetcher().fetchCertificate(`${server.origin}/cert.pem`),
        /MNS certificate response exceeded \d+ bytes/u);
    } finally {
      await server.close();
    }
  });
});
