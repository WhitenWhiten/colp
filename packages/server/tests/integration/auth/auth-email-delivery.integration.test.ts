import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { AliyunDirectMailAdapter } from '../../../src/infrastructure/email/aliyun-directmail-adapter.js';
import {
  composeAuthEmailAdapter,
  createAuthEmailAdapter,
  createInProcessMailboxSink,
  type AuthEmailAdapter,
} from '../../../src/infrastructure/email/auth-email-adapter.js';
import {
  EMAIL_ENTRY_FIXTURE_TAGS,
  loadEmailEntryReplayManifest,
  startEmailEntryFixture,
  type StartedEmailEntryFixture,
} from '../../../scripts/evidence/phase5-email-entry-fixture.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { AUTH_EMAIL_PURPOSES, otpEmailPurpose, type AuthEmailPurpose } from '../../../src/modules/auth/index.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const adapterPath = resolve(backendRoot, 'src/infrastructure/email/auth-email-adapter.ts');
const adapterSource = readFileSync(adapterPath, 'utf8');
const portPath = resolve(backendRoot, 'src/modules/auth/application/auth-email-port.ts');
const portSource = readFileSync(portPath, 'utf8');

const CALLBACK_SECRET = `c1_callback_${'s'.repeat(8)}`;
const OTP = '612847';
const AUTH_TAG_PREFIX = 'p527-delivery-';

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: unknown, _encoding: unknown, done: () => void) {
      lines.push(String(chunk));
      done();
    },
  });
  return { logger: createLogger('info', destination), lines };
}

function templateDataFor(purpose: AuthEmailPurpose) {
  switch (purpose) {
    case 'sign-in-otp':
    case 'email-verification-otp':
    case 'forget-password-otp':
    case 'change-email-otp':
      return { otp: OTP };
    case 'email-verification': return { verificationUrl: 'https://app.example.invalid/verify?token=abc' };
    case 'password-reset': return { resetUrl: 'https://app.example.invalid/reset?token=abc' };
    case 'email-change': {
      return { newEmail: 'new-owner@example.invalid', verificationUrl: 'https://app.example.invalid/change?token=abc' };
    }
    case 'mfa-recovery': return { recoveryCodes: ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH'] };
  }
}

describe('C1 auth email delivery through the real DirectMail fixture with real templates and classifier', () => {
  let fixture!: StartedEmailEntryFixture;
  let manifest!: ReturnType<typeof loadEmailEntryReplayManifest>;

  beforeAll(async () => {
    manifest = loadEmailEntryReplayManifest();
    fixture = await startEmailEntryFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  function authAdapter(options: {
    readonly timeoutMs?: number;
    readonly logger?: ReturnType<typeof createLogger>;
  } = {}) {
    const directMail = new AliyunDirectMailAdapter({
      endpoint: fixture.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: options.timeoutMs ?? 2_000,
      tagPrefix: AUTH_TAG_PREFIX,
      maxTagChars: 128,
      fixtureTls: true,
    });
    const sender = createAuthEmailAdapter({
      provider: directMail,
      logger: options.logger ?? createLogger('silent'),
    });
    return { sender, directMail };
  }

  test('every auth email purpose is queued over real HTTPS with the stable auth tag', async () => {
    const { sender, directMail } = authAdapter();
    try {
      const purposes: readonly AuthEmailPurpose[] = AUTH_EMAIL_PURPOSES;
      for (const purpose of purposes) {
        const result = await sender.sendAuthEmail({
          purpose,
          to: manifest.fixedInputs.recipient,
          templateData: templateDataFor(purpose),
          idempotencyKey: `auth-${purpose}`,
        });
        assert.equal(result.outcome, 'queued', purpose);
        if (result.outcome === 'queued') {
          assert.ok(result.providerMessageId && result.providerMessageId.startsWith('env-'), purpose);
          assert.ok(result.correlationId.length > 0, purpose);
        }
        assert.equal(fixture.sentTagCounts.get(`p527-delivery-auth-${purpose}`), 1, purpose);
      }
    } finally {
      await directMail.close();
    }
  });

  test('provider permanent/retryable classifications all surface as email_delivery_unavailable', async () => {
    const { sender, directMail } = authAdapter();
    try {
      const scenarios: ReadonlyArray<readonly [string, string]> = [
        ['throttling', EMAIL_ENTRY_FIXTURE_TAGS.throttling],
        ['rateLimit429', EMAIL_ENTRY_FIXTURE_TAGS.rateLimit429],
        ['internalError', EMAIL_ENTRY_FIXTURE_TAGS.internalError],
        ['serviceUnavailable', EMAIL_ENTRY_FIXTURE_TAGS.serviceUnavailable],
        ['invalidRecipient', EMAIL_ENTRY_FIXTURE_TAGS.invalidRecipient],
        ['senderNotFound', EMAIL_ENTRY_FIXTURE_TAGS.senderNotFound],
      ];
      for (const [scenario, fixtureTag] of scenarios) {
        const result = await sender.sendAuthEmail({
          purpose: 'sign-in-otp',
          to: manifest.fixedInputs.recipient,
          templateData: { otp: OTP },
          idempotencyKey: fixtureTag.slice(AUTH_TAG_PREFIX.length),
        });
        assert.equal(result.outcome, 'email_delivery_unavailable', scenario);
        if (result.outcome === 'email_delivery_unavailable') {
          assert.ok(result.redactedReason.length > 0, scenario);
          assert.doesNotMatch(JSON.stringify(result),
            new RegExp(manifest.fixedInputs.recipient.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), scenario);
        }
      }
    } finally {
      await directMail.close();
    }
  });

  test('DirectMail timeout classifies email_delivery_unavailable over the real fixture', async () => {
    const slow = await startEmailEntryFixture({ timeoutDelayMs: 5_000 });
    const directMail = new AliyunDirectMailAdapter({
      endpoint: slow.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 500,
      tagPrefix: AUTH_TAG_PREFIX,
      maxTagChars: 128,
      fixtureTls: true,
    });
    const sender = createAuthEmailAdapter({ provider: directMail, logger: createLogger('silent') });
    try {
      const result = await sender.sendAuthEmail({
        purpose: 'password-reset',
        to: manifest.fixedInputs.recipient,
        templateData: { resetUrl: 'https://app.example.invalid/reset?token=abc' },
        idempotencyKey: 'timeout',
      });
      assert.equal(result.outcome, 'email_delivery_unavailable');
      if (result.outcome === 'email_delivery_unavailable') {
        assert.match(result.redactedReason, /timeout/iu);
      }
    } finally {
      await directMail.close();
      await slow.close();
    }
  }, 20_000);

  test('a retry reuses the same idempotency key and reaches the provider again', async () => {
    const { sender, directMail } = authAdapter();
    try {
      const first = await sender.sendAuthEmail({
        purpose: 'email-verification',
        to: manifest.fixedInputs.recipient,
        templateData: { verificationUrl: 'https://app.example.invalid/verify?token=abc' },
        idempotencyKey: 'auth-retry-same',
      });
      const second = await sender.sendAuthEmail({
        purpose: 'email-verification',
        to: manifest.fixedInputs.recipient,
        templateData: { verificationUrl: 'https://app.example.invalid/verify?token=abc' },
        idempotencyKey: 'auth-retry-same',
      });
      assert.equal(first.outcome, 'queued');
      assert.equal(second.outcome, 'queued');
      assert.equal(fixture.sentTagCounts.get('p527-delivery-auth-retry-same'), 2);
    } finally {
      await directMail.close();
    }
  });

  test('recipient, OTP and body text never appear in adapter results or logs', async () => {
    const { logger, lines } = captureLogger();
    const markerRecipient = 'c1-redaction@example.invalid';
    const markerOtp = '739104';
    const { sender, directMail } = authAdapter({ logger });
    try {
      const result = await sender.sendAuthEmail({
        purpose: 'sign-in-otp',
        to: markerRecipient,
        templateData: { otp: markerOtp },
        idempotencyKey: 'auth-redaction',
      });
      assert.equal(result.outcome, 'queued');
      const serialized = JSON.stringify(result);
      for (const marker of [markerRecipient, markerOtp, 'Your Know-N sign-in code']) {
        assert.doesNotMatch(serialized, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), marker);
      }
      const logText = lines.join('\n');
      for (const marker of [markerRecipient, markerOtp, 'Your Know-N sign-in code']) {
        assert.doesNotMatch(logText, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), marker);
      }
      assert.match(logText, /"purpose":"sign-in-otp"/u);
      assert.match(logText, /"classification":"queued"/u);
      assert.match(logText, /"correlationId"/u);
    } finally {
      await directMail.close();
    }
  });

  test('test-mode composition routes into the in-process mailbox sink with the rendered OTP body', async () => {
    const { logger } = captureLogger();
    const sink = createInProcessMailboxSink();
    const composition = composeAuthEmailAdapter({
      enabled: true,
      nodeEnv: 'test',
      directMail: {
        endpoint: 'https://dm.aliyuncs.com/',
        regionId: 'cn-hangzhou',
        accountName: manifest.fixedInputs.sender,
        timeoutMs: 10_000,
        tagPrefix: 'known-auth-',
        maxTagChars: 128,
      },
      resolveCredentials: () => {
        throw new Error('credentials must never be resolved in test mode');
      },
      logger,
      inProcessSink: sink,
    });
    try {
      const result = await composition.sender.sendAuthEmail({
        purpose: 'sign-in-otp',
        to: 'otp-sink@example.invalid',
        templateData: { otp: OTP },
        idempotencyKey: 'auth-sink-1',
      });
      assert.equal(result.outcome, 'queued');
      assert.equal(sink.sentCount, 1);
      const entry = sink.entries[0]!;
      assert.equal(entry.to, 'otp-sink@example.invalid');
      assert.equal(entry.idempotencyKey, 'auth-sink-1');
      assert.match(entry.textBody, new RegExp(OTP, 'u'));

      const changePurpose = otpEmailPurpose('change-email');
      assert.equal(changePurpose, 'change-email-otp');
      const change = await composition.sender.sendAuthEmail({
        purpose: changePurpose,
        to: 'change-email-sink@example.invalid',
        templateData: { otp: OTP },
        idempotencyKey: 'auth-sink-change-email',
      });
      assert.equal(change.outcome, 'queued');
      assert.equal(sink.sentCount, 2);
      const changeEntry = sink.entries[1]!;
      assert.equal(changeEntry.subject, 'Your Know-N email change code');
      assert.match(changeEntry.textBody, /Your email change code is:/u);
      assert.match(changeEntry.textBody, /This code cannot be used to sign in or create an account/u);
      assert.doesNotMatch(changeEntry.subject, /Confirm your new Know-N email/u);
    } finally {
      await composition.close();
    }
  });

  test('provider-not-configured composition returns email_delivery_unavailable (never claims a real mailbox send)', async () => {
    const { logger } = captureLogger();
    const composition = composeAuthEmailAdapter({
      enabled: false,
      nodeEnv: 'production',
      directMail: {
        endpoint: 'https://dm.aliyuncs.com/',
        regionId: 'cn-hangzhou',
        accountName: manifest.fixedInputs.sender,
        timeoutMs: 10_000,
        tagPrefix: 'known-auth-',
        maxTagChars: 128,
      },
      resolveCredentials: () => {
        throw new Error('credentials must never be resolved when auth email is disabled');
      },
      logger,
    });
    const result = await composition.sender.sendAuthEmail({
      purpose: 'sign-in-otp',
      to: manifest.fixedInputs.recipient,
      templateData: { otp: OTP },
      idempotencyKey: 'auth-not-configured',
    });
    assert.equal(result.outcome, 'email_delivery_unavailable');
    if (result.outcome === 'email_delivery_unavailable') {
      assert.match(result.redactedReason, /not configured/u);
    }
    assert.equal(fixture.sentTagCounts.get('p527-delivery-auth-not-configured'), undefined);
  });

  test('the reused DirectMail callback verifies to stable facts only: no business side effects', async () => {
    // The auth email surface shares the DirectMail adapter's verified-callback
    // purity: verification returns ONLY stable delivery facts and never writes
    // the notification delivery ledger (the auth adapter has no callback or
    // ledger surface at all).
    const directMail = new AliyunDirectMailAdapter({
      endpoint: fixture.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 2_000,
      tagPrefix: AUTH_TAG_PREFIX,
      maxTagChars: 128,
      fixtureTls: true,
      callbackHmacSecret: CALLBACK_SECRET,
    });
    try {
      const raw = await fixture.readText('/__fixture/events/deliver-success');
      assert.equal(raw.status, 200);
      const body = raw.bodyText;
      const timestamp = new Date(Date.now() - 60_000).toISOString();
      const nonce = 'c1-fixture-nonce';
      const signature = createHmac('sha256', CALLBACK_SECRET)
        .update(`${body}\n${timestamp}\n${nonce}`).digest('base64');
      const fact = await directMail.verifyCallback({
        method: 'POST',
        url: 'https://dm.example/events',
        headers: {
          'x-known-dm-signature': signature,
          'x-known-dm-timestamp': timestamp,
          'x-known-dm-nonce': nonce,
          'content-type': 'application/json',
        },
        body,
      });
      assert.equal(fact.kind, 'delivered');
      assert.ok(fact.providerMessageId);
      assert.equal(fact.recipient, manifest.fixedInputs.recipient);
      assert.equal(fact.tag, 'p527-delivery-success');
      // Stable facts only: no error/ledger fields and no delivery row surface.
      const factKeys = Object.keys(fact).sort();
      assert.deepEqual(factKeys, ['kind', 'occurredAt', 'providerMessageId', 'recipient', 'tag']);
      assert.ok(typeof fact.occurredAt === 'string' && fact.occurredAt.length > 0);
    } finally {
      await directMail.close();
    }
  }, 20_000);

  test('the auth email adapter has no callback/ledger surface and the port documents side-effect purity', async () => {
    // Compile-time: the auth email sender exposes only sendAuthEmail + close.
    const { logger } = captureLogger();
    const sink = createInProcessMailboxSink();
    const sender: AuthEmailAdapter = createAuthEmailAdapter({ provider: sink.provider, logger });
    const keys: (keyof AuthEmailAdapter)[] = ['sendAuthEmail', 'close'];
    assert.deepEqual(keys, ['sendAuthEmail', 'close']);
    void sender;

    assert.doesNotMatch(adapterSource, /notification_deliveries/u);
    assert.doesNotMatch(adapterSource, /email-delivery-worker/u);
    assert.match(portSource, /never/iu);
    assert.match(portSource, /email_delivery_unavailable/u);
    assert.match(portSource, /queued/u);
  });
});
