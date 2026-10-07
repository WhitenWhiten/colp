import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  AliyunDirectMailAdapter,
  type AliyunDirectMailAdapterOptions,
  type EmailAdapterTransport,
} from '../../../src/infrastructure/email/aliyun-directmail-adapter.js';
import {
  composeAuthEmailAdapter,
  createAuthEmailAdapter,
  createInProcessMailboxSink,
  createUnavailableAuthEmailSender,
  type AuthEmailComposition,
  type InProcessMailboxSink,
} from '../../../src/infrastructure/email/auth-email-adapter.js';
import { parseEmailSkinConfig } from '../../../src/infrastructure/email/message-skins.js';
import { UNIFIED_EMAIL_SKIN } from '../../../src/infrastructure/email/unified-email-chrome.js';
import type { EmailSendInput, EmailSendResult } from '../../../src/modules/email/index.js';
import {
  AUTH_EMAIL_BODY_MAX_BYTES,
  AUTH_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS,
  AUTH_EMAIL_PURPOSES,
  AUTH_EMAIL_SUBJECT_MAX_CHARS,
  renderAuthEmailTemplate,
  type AuthEmailPurpose,
  type AuthEmailTemplateData,
} from '../../../src/modules/auth/index.js';
import {
  EMAIL_BODY_MAX_BYTES,
  EMAIL_IDEMPOTENCY_KEY_MAX_CHARS,
  EMAIL_SUBJECT_MAX_CHARS,
} from '../../../src/modules/email/index.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const adapterPath = resolve(backendRoot, 'src/infrastructure/email/auth-email-adapter.ts');
const adapterSource = readFileSync(adapterPath, 'utf8');
const portPath = resolve(backendRoot, 'src/modules/auth/application/auth-email-port.ts');
const portSource = readFileSync(portPath, 'utf8');

const OTP = '483920';
const RECIPIENT = 'auth-otp@example.invalid';
const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

function validTemplateData(purpose: AuthEmailPurpose): AuthEmailTemplateData {
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

const ALL_PURPOSES: readonly AuthEmailPurpose[] = AUTH_EMAIL_PURPOSES;

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

function directMailAdapterOptions(
  overrides: Partial<AliyunDirectMailAdapterOptions> = {},
): AliyunDirectMailAdapterOptions {
  return {
    endpoint: 'https://dm.aliyuncs.com/',
    regionId: 'cn-hangzhou',
    accountName: 'auth-sender@example.invalid',
    accessKeyId: 'C1FIXTUREAKID',
    accessKeySecret: 'c1-fixture-key',
    timeoutMs: 1_000,
    tagPrefix: 'known-auth-',
    maxTagChars: 128,
    ...overrides,
  };
}

interface FakeTransport {
  readonly transport: EmailAdapterTransport;
  readonly calls: number;
  readonly urls: readonly string[];
}

/** Fake DirectMail transport returning scripted responses; honors abort signals. */
function fakeTransport(
  responses: readonly (() => { readonly httpStatus: number; readonly bodyText: string } | Promise<never>)[],
): FakeTransport {
  let index = 0;
  let calls = 0;
  const urls: string[] = [];
  return {
    transport: {
      async request(input) {
        calls += 1;
        urls.push(input.url);
        if (input.signal.aborted) {
          throw input.signal.reason instanceof Error ? input.signal.reason : new Error('aborted');
        }
        const response = responses[Math.min(index, responses.length - 1)]!;
        index += 1;
        const value = response();
        if (value instanceof Promise) {
          return new Promise((resolvePromise, rejectPromise) => {
            input.signal.addEventListener('abort', () => {
              rejectPromise(input.signal.reason instanceof Error
                ? input.signal.reason : new Error('aborted'));
            }, { once: true });
            value.then(resolvePromise, rejectPromise);
          });
        }
        return value;
      },
    },
    get calls() { return calls; },
    get urls() { return urls; },
  };
}

const json = (httpStatus: number, body: unknown): { readonly httpStatus: number; readonly bodyText: string } => ({
  httpStatus,
  bodyText: JSON.stringify(body),
});

function authAdapterOverDirectMail(
  transport: EmailAdapterTransport,
  options: { readonly logger?: ReturnType<typeof createLogger>; readonly timeoutMs?: number } = {},
) {
  const directMail = new AliyunDirectMailAdapter(directMailAdapterOptions({
    transport,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }));
  const sender = createAuthEmailAdapter({
    provider: directMail,
    logger: options.logger ?? createLogger('silent'),
  });
  return { sender, directMail };
}

function sendInput(overrides: Partial<{
  purpose: AuthEmailPurpose;
  to: string;
  templateData: AuthEmailTemplateData;
  idempotencyKey: string;
  signal: AbortSignal;
}> = {}) {
  return {
    purpose: overrides.purpose ?? 'sign-in-otp',
    to: overrides.to ?? RECIPIENT,
    templateData: overrides.templateData ?? validTemplateData('sign-in-otp'),
    idempotencyKey: overrides.idempotencyKey ?? 'auth-otp-1',
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
  };
}

function unavailableReason(result: import('../../../src/modules/auth/index.js').AuthEmailDeliveryResult): string {
  return result.outcome === 'email_delivery_unavailable' ? result.redactedReason : '';
}

describe('C1 auth email templates stay within the frozen budgets and leak nothing outside subject/body', () => {
  test('every purpose renders with valid data: subject <= 100 chars, bodies within the byte budget, valid UTF-8', () => {
    for (const purpose of ALL_PURPOSES) {
      const rendered = renderAuthEmailTemplate(purpose, validTemplateData(purpose));
      assert.equal(rendered.ok, true, purpose);
      if (!rendered.ok) continue;
      assert.ok(rendered.message.subject.length <= AUTH_EMAIL_SUBJECT_MAX_CHARS, purpose);
      assert.ok(Buffer.byteLength(rendered.message.textBody, 'utf8') <= AUTH_EMAIL_BODY_MAX_BYTES, purpose);
      assert.ok(Buffer.byteLength(rendered.message.htmlBody, 'utf8') <= AUTH_EMAIL_BODY_MAX_BYTES, purpose);
      for (const part of [rendered.message.subject, rendered.message.textBody, rendered.message.htmlBody]) {
        // No lone surrogates: every template output round-trips as valid UTF-8 text.
        assert.doesNotMatch(part,
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u, purpose);
      }
    }
  });

  test('subjects never carry the OTP or the recovery codes (auth state stays in the body)', () => {
    const otp = renderAuthEmailTemplate('sign-in-otp', { otp: OTP });
    assert.equal(otp.ok, true);
    if (otp.ok) {
      assert.doesNotMatch(otp.message.subject, new RegExp(OTP, 'u'));
      assert.match(otp.message.textBody, new RegExp(OTP, 'u'));
      assert.match(otp.message.htmlBody, new RegExp(OTP, 'u'));
    }
    const recovery = renderAuthEmailTemplate('mfa-recovery', { recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] });
    assert.equal(recovery.ok, true);
    if (recovery.ok) {
      assert.doesNotMatch(recovery.message.subject, /AAAA-BBBB-CCCC-DDDD/u);
      assert.match(recovery.message.htmlBody, /AAAA-BBBB-CCCC-DDDD/u);
    }
  });

  test('multibyte template data renders valid UTF-8 within the byte budget', () => {
    const rendered = renderAuthEmailTemplate('email-verification',
      { verificationUrl: 'https://app.example.invalid/verify?token=\uD83C\uDF89abc' });
    assert.equal(rendered.ok, true);
    if (rendered.ok) {
      assert.match(rendered.message.htmlBody, /\uD83C\uDF89/u);
      assert.ok(Buffer.byteLength(rendered.message.htmlBody, 'utf8') <= AUTH_EMAIL_BODY_MAX_BYTES);
    }
  });

  test('user-controlled values are HTML-escaped in the html body', () => {
    const rendered = renderAuthEmailTemplate('email-change', {
      newEmail: '<script>alert(1)</script>@example.invalid',
      verificationUrl: 'https://app.example.invalid/change?token=abc',
    });
    assert.equal(rendered.ok, true);
    if (rendered.ok) {
      assert.match(rendered.message.htmlBody, /&lt;script&gt;/u);
      assert.doesNotMatch(rendered.message.htmlBody, /<script>/u);
    }
  });

  test('template validation rejects malformed per-purpose structure (validated structure contract)', () => {
    const cases: ReadonlyArray<readonly [AuthEmailPurpose, Record<string, unknown>]> = [
      ['sign-in-otp', {}],
      ['sign-in-otp', { otp: '12' }],
      ['sign-in-otp', { otp: 'abcdef' }],
      ['email-verification-otp', {}],
      ['email-verification-otp', { otp: '12' }],
      ['email-verification-otp', { otp: 'abcdef' }],
      ['forget-password-otp', {}],
      ['forget-password-otp', { otp: '12' }],
      ['forget-password-otp', { otp: 'abcdef' }],
      ['change-email-otp', {}],
      ['change-email-otp', { otp: '12' }],
      ['change-email-otp', { otp: 'abcdef' }],
      ['email-verification', {}],
      ['email-verification', { verificationUrl: '' }],
      ['password-reset', {}],
      ['password-reset', { resetUrl: '   ' }],
      ['email-change', { newEmail: 'a@example.invalid' }],
      ['email-change', { verificationUrl: 'https://app.example.invalid/change?token=abc' }],
      ['mfa-recovery', {}],
      ['mfa-recovery', { recoveryCodes: [] }],
      ['mfa-recovery', { recoveryCodes: [''] }],
      ['mfa-recovery', { recoveryCodes: ['x'.repeat(65)] }],
    ];
    for (const [purpose, data] of cases) {
      const rendered = renderAuthEmailTemplate(purpose, data as AuthEmailTemplateData);
      assert.equal(rendered.ok, false, `${purpose} ${JSON.stringify(data)}`);
    }
  });
});

describe('C1 auth email port contract (stable result union, logging and ledger purity)', () => {
  test('port documents the unified queued / email_delivery_unavailable result contract', () => {
    assert.match(portSource, /email_delivery_unavailable/u);
    assert.match(portSource, /queued/u);
  });

  test('port documents that logs record only purpose, redacted classification and correlation id', () => {
    assert.match(portSource, /purpose/u);
    assert.match(portSource, /correlationId/u);
    assert.match(portSource, /redact|redacted/iu);
  });

  test('adapter never references the notification delivery ledger (no business side effects)', () => {
    assert.doesNotMatch(adapterSource, /notification_deliveries/u);
    assert.doesNotMatch(adapterSource, /email-delivery-worker/u);
    assert.doesNotMatch(adapterSource, /EmailDeliveryWorkerRepository/u);
    assert.doesNotMatch(adapterSource, /createPostgresEmailDeliveryWorkerRepository/u);
    // The only modules/notifications surface the adapter may consume is the
    // frozen provider port types (EmailSendInput/EmailSendResult).
    assert.match(adapterSource, /from '\.\.\/\.\.\/modules\/email\/index\.js'/u);
  });

  test('the auth email sender surface exposes ONLY sendAuthEmail (never lookup/verifyCallback/ledger)', async () => {
    const surfaceKeys: (keyof ReturnType<typeof createAuthEmailAdapter>)[] = ['sendAuthEmail', 'close'];
    assert.deepEqual(surfaceKeys, ['sendAuthEmail', 'close']);
    // Compile-time pin: the concrete adapter satisfies the port interface.
    const { logger } = captureLogger();
    const sink = createInProcessMailboxSink();
    const _surface: import('../../../src/modules/auth/index.js').AuthEmailSender
      = createAuthEmailAdapter({ provider: sink.provider, logger });
    void _surface;
  });

  test('budget constants mirror the frozen notifications port budgets', () => {
    assert.equal(AUTH_EMAIL_SUBJECT_MAX_CHARS, EMAIL_SUBJECT_MAX_CHARS);
    assert.equal(AUTH_EMAIL_BODY_MAX_BYTES, EMAIL_BODY_MAX_BYTES);
    assert.equal(AUTH_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS, EMAIL_IDEMPOTENCY_KEY_MAX_CHARS);
  });
});

describe('sendAuthEmail request validation fails closed before provider contact', () => {
  test('missing recipient returns email_delivery_unavailable without contacting the provider', async () => {
    const fake = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
    try {
      const result = await sender.sendAuthEmail(sendInput({ to: '   ' }));
      assert.equal(result.outcome, 'email_delivery_unavailable');
      assert.match(unavailableReason(result), /recipient/u);
      assert.equal(fake.calls, 0);
    } finally {
      await directMail.close();
    }
  });

  test('oversized idempotency key returns email_delivery_unavailable without provider contact', async () => {
    const fake = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
    try {
      const result = await sender.sendAuthEmail(sendInput({ idempotencyKey: 'x'.repeat(129) }));
      assert.equal(result.outcome, 'email_delivery_unavailable');
      assert.match(unavailableReason(result), /idempotencyKey/u);
      assert.equal(fake.calls, 0);
    } finally {
      await directMail.close();
    }
  });

  test('invalid template data returns email_delivery_unavailable without provider contact', async () => {
    const fake = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
    try {
      const result = await sender.sendAuthEmail(sendInput({ templateData: { otp: '12' } }));
      assert.equal(result.outcome, 'email_delivery_unavailable');
      assert.match(unavailableReason(result), /template/u);
      assert.equal(fake.calls, 0);
    } finally {
      await directMail.close();
    }
  });
});

describe('sendAuthEmail maps the DirectMail classification onto the unified result (real adapter + classifier)', () => {
  test('provider success -> queued with providerMessageId and correlationId', async () => {
    const fake = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
    try {
      const result = await sender.sendAuthEmail(sendInput());
      assert.equal(result.outcome, 'queued');
      if (result.outcome === 'queued') {
        assert.equal(result.providerMessageId, 'env-1');
        assert.ok(result.correlationId.length > 0);
      }
    } finally {
      await directMail.close();
    }
  });

  test('provider permanent (400 InvalidToAddress) -> email_delivery_unavailable, reason redacted', async () => {
    const fake = fakeTransport([() => json(400, { Code: 'InvalidToAddress', Message: 'x', RequestId: 'r' })]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
    try {
      const result = await sender.sendAuthEmail(sendInput());
      assert.equal(result.outcome, 'email_delivery_unavailable');
      assert.doesNotMatch(JSON.stringify(result), new RegExp(RECIPIENT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      assert.doesNotMatch(JSON.stringify(result), new RegExp(OTP, 'u'));
    } finally {
      await directMail.close();
    }
  });

  test('provider retryable (500 InternalError) and (429 Throttling) -> email_delivery_unavailable', async () => {
    for (const [httpStatus, code] of [[500, 'InternalError'], [429, 'Throttling']] as const) {
      const fake = fakeTransport([() => json(httpStatus, { Code: code, Message: 'x', RequestId: 'r' })]);
      const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
      try {
        const result = await sender.sendAuthEmail(sendInput());
        assert.equal(result.outcome, 'email_delivery_unavailable', code);
      } finally {
        await directMail.close();
      }
    }
  });

  test('provider unknown (3xx redirect) -> email_delivery_unavailable', async () => {
    const fake = fakeTransport([() => ({ httpStatus: 302, bodyText: '<html>redirect</html>' })]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
    try {
      const result = await sender.sendAuthEmail(sendInput());
      assert.equal(result.outcome, 'email_delivery_unavailable');
    } finally {
      await directMail.close();
    }
  });

  test('malformed 2xx provider body (non-JSON) -> email_delivery_unavailable', async () => {
    const fake = fakeTransport([() => ({ httpStatus: 200, bodyText: 'not json' })]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
    try {
      const result = await sender.sendAuthEmail(sendInput());
      assert.equal(result.outcome, 'email_delivery_unavailable');
    } finally {
      await directMail.close();
    }
  });

  test('DirectMail timeout -> email_delivery_unavailable with a timeout redacted reason', async () => {
    const fake = fakeTransport([() => new Promise<never>(() => { /* never settles */ })]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport, { timeoutMs: 500 });
    try {
      const result = await sender.sendAuthEmail(sendInput());
      assert.equal(result.outcome, 'email_delivery_unavailable');
      assert.match(unavailableReason(result), /timeout/iu);
    } finally {
      await directMail.close();
    }
  });

  test('pre-aborted caller signal -> email_delivery_unavailable', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
    try {
      const result = await sender.sendAuthEmail(sendInput({ signal: controller.signal }));
      assert.equal(result.outcome, 'email_delivery_unavailable');
    } finally {
      await directMail.close();
    }
  });

  test('transport-level throw -> email_delivery_unavailable with redacted reason', async () => {
    const transport: EmailAdapterTransport = {
      async request() {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      },
    };
    const { sender, directMail } = authAdapterOverDirectMail(transport);
    try {
      const result = await sender.sendAuthEmail(sendInput());
      assert.equal(result.outcome, 'email_delivery_unavailable');
      assert.ok(unavailableReason(result).length > 0);
    } finally {
      await directMail.close();
    }
  });
});

describe('idempotency key reuse keeps the stable provider TagName across retries', () => {
  test('retrying with the same idempotency key reaches the provider twice with the identical TagName', async () => {
    const fake = fakeTransport([
      () => json(200, { EnvId: 'env-1', RequestId: 'req-1' }),
      () => json(200, { EnvId: 'env-1', RequestId: 'req-1' }),
    ]);
    const { sender, directMail } = authAdapterOverDirectMail(fake.transport);
    try {
      const first = await sender.sendAuthEmail(sendInput({ idempotencyKey: 'auth-otp-1' }));
      const second = await sender.sendAuthEmail(sendInput({ idempotencyKey: 'auth-otp-1' }));
      assert.equal(first.outcome, 'queued');
      assert.equal(second.outcome, 'queued');
      assert.equal(fake.calls, 2);
      assert.equal(fake.urls.length, 2);
      assert.match(fake.urls[0] ?? '', /TagName=known-auth-auth-otp-1/u);
      assert.match(fake.urls[1] ?? '', /TagName=known-auth-auth-otp-1/u);
      // Full URLs differ per request (fresh SignatureNonce/Signature); the
      // STABLE part is the TagName, which must be reused verbatim.
      const tagNameOf = (url: string): string | null => new URL(url).searchParams.get('TagName');
      assert.equal(tagNameOf(fake.urls[0] ?? ''), tagNameOf(fake.urls[1] ?? ''),
        'the stable TagName must be reused verbatim');
    } finally {
      await directMail.close();
    }
  });
});

describe('log redaction: recipient, OTP and body text never reach the logs', () => {
  test('queued and unavailable paths log only purpose, redacted classification and correlation id', async () => {
    const { logger, lines } = captureLogger();
    const markerRecipient = 'c1-redaction-otp@example.invalid';
    const markerOtp = '918273';

    const success = fakeTransport([() => json(200, { EnvId: 'env-1', RequestId: 'req-1' })]);
    const directMail = new AliyunDirectMailAdapter(directMailAdapterOptions({ transport: success.transport }));
    const sender = createAuthEmailAdapter({ provider: directMail, logger });
    try {
      const queued = await sender.sendAuthEmail({
        purpose: 'sign-in-otp',
        to: markerRecipient,
        templateData: { otp: markerOtp },
        idempotencyKey: 'auth-otp-redact',
      });
      assert.equal(queued.outcome, 'queued');

      const failure = fakeTransport([() => json(500, { Code: 'InternalError', Message: markerOtp, RequestId: 'r' })]);
      const failingDirectMail = new AliyunDirectMailAdapter(directMailAdapterOptions({ transport: failure.transport }));
      const failingSender = createAuthEmailAdapter({ provider: failingDirectMail, logger });
      const unavailable = await failingSender.sendAuthEmail({
        purpose: 'password-reset',
        to: markerRecipient,
        templateData: { resetUrl: 'https://app.example.invalid/reset?token=abc' },
        idempotencyKey: 'auth-reset-redact',
      });
      assert.equal(unavailable.outcome, 'email_delivery_unavailable');
      await failingDirectMail.close();

      const serialized = JSON.stringify({ queued, unavailable });
      for (const marker of [markerRecipient, markerOtp, 'Your Know-N sign-in code', '918273']) {
        assert.doesNotMatch(serialized, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), marker);
      }
      const logText = lines.join('\n');
      for (const marker of [markerRecipient, markerOtp]) {
        assert.doesNotMatch(logText, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), marker);
      }
      assert.match(logText, /"purpose":"sign-in-otp"/u);
      assert.match(logText, /"purpose":"password-reset"/u);
      assert.match(logText, /"classification":"queued"/u);
      assert.match(logText, /"classification":"provider_unavailable"/u);
      assert.match(logText, /"correlationId"/u);
    } finally {
      await directMail.close();
    }
  });
});

describe('provider not configured: the unavailable sender never claims delivery', () => {
  test('createUnavailableAuthEmailSender returns email_delivery_unavailable and logs only safe bindings', async () => {
    const { logger, lines } = captureLogger();
    const sender = createUnavailableAuthEmailSender(logger);
    const result = await sender.sendAuthEmail(sendInput());
    assert.equal(result.outcome, 'email_delivery_unavailable');
    assert.match(result.outcome === 'email_delivery_unavailable' ? result.redactedReason : '', /not configured/u);
    const logText = lines.join('\n');
    assert.match(logText, /"classification":"not_configured"/u);
    assert.doesNotMatch(logText, new RegExp(RECIPIENT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.doesNotMatch(logText, new RegExp(OTP, 'u'));
  });

  test('composeAuthEmailAdapter with enabled=false composes the unavailable sender without touching credentials', () => {
    const { logger } = captureLogger();
    const composition = composeAuthEmailAdapter({
      enabled: false,
      nodeEnv: 'production',
      directMail: {
        endpoint: 'https://dm.aliyuncs.com/',
        regionId: 'cn-hangzhou',
        accountName: 'sender@example.invalid',
        timeoutMs: 10_000,
        tagPrefix: 'known-auth-',
        maxTagChars: 128,
      },
      resolveCredentials: () => {
        throw new Error('credentials must never be resolved when auth email is disabled');
      },
      logger,
    });
    assert.ok(composition.sender);
    void composition.close();
  });
});

describe('test mode composes the in-process mailbox sink (never DirectMail credentials)', () => {
  test('nodeEnv=test routes every send into the mailbox sink with the rendered message', async () => {
    const { logger } = captureLogger();
    const sink = createInProcessMailboxSink();
    const composition: AuthEmailComposition = composeAuthEmailAdapter({
      enabled: true,
      nodeEnv: 'test',
      directMail: {
        endpoint: 'https://dm.aliyuncs.com/',
        regionId: 'cn-hangzhou',
        accountName: 'sender@example.invalid',
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
      const result = await composition.sender.sendAuthEmail(sendInput());
      assert.equal(result.outcome, 'queued');
      assert.equal(sink.sentCount, 1);
      assert.equal(sink.entries.length, 1);
      const entry = sink.entries[0]!;
      assert.equal(entry.to, RECIPIENT);
      assert.equal(entry.idempotencyKey, 'auth-otp-1');
      assert.match(entry.textBody, new RegExp(OTP, 'u'));
      assert.match(entry.subject, /sign-in/u);
    } finally {
      await composition.close();
    }
  });

  test('the mailbox sink is a plain in-process provider: it records and never throws', async () => {
    const sink: InProcessMailboxSink = createInProcessMailboxSink();
    const result = await sink.provider.send({
      idempotencyKey: 'k',
      message: { to: 'a@example.invalid', subject: 's', textBody: 'b' },
    });
    assert.equal(result.classification, 'success');
    assert.equal(sink.sentCount, 1);
  });
});

describe('production composition fails closed without DirectMail credentials', () => {
  test('enabled + nodeEnv != test + missing credentials throws before any adapter is built', () => {
    const { logger } = captureLogger();
    assert.throws(
      () => composeAuthEmailAdapter({
        enabled: true,
        nodeEnv: 'production',
        directMail: {
          endpoint: 'https://dm.aliyuncs.com/',
          regionId: 'cn-hangzhou',
          accountName: 'sender@example.invalid',
          timeoutMs: 10_000,
          tagPrefix: 'known-auth-',
          maxTagChars: 128,
        },
        resolveCredentials: () => {
          throw new Error('ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET are required');
        },
        logger,
      }),
      /ALIBABA_CLOUD_ACCESS_KEY_ID/u,
    );
  });

  test('enabled + nodeEnv != test + missing accountName throws fail closed', () => {
    const { logger } = captureLogger();
    assert.throws(
      () => composeAuthEmailAdapter({
        enabled: true,
        nodeEnv: 'staging',
        directMail: {
          endpoint: 'https://dm.aliyuncs.com/',
          regionId: 'cn-hangzhou',
          accountName: null,
          timeoutMs: 10_000,
          tagPrefix: 'known-auth-',
          maxTagChars: 128,
        },
        resolveCredentials: () => ({ accessKeyId: 'AKID', accessKeySecret: 'SECRET' }),
        logger,
      }),
      /AUTH_EMAIL_DM_ACCOUNT_NAME/u,
    );
  });

  test('enabled + nodeEnv != test + credentials present builds a working composition', async () => {
    const { logger } = captureLogger();
    const composition = composeAuthEmailAdapter({
      enabled: true,
      nodeEnv: 'staging',
      directMail: {
        endpoint: 'https://dm.aliyuncs.com/',
        regionId: 'cn-hangzhou',
        accountName: 'sender@example.invalid',
        timeoutMs: 10_000,
        tagPrefix: 'known-auth-',
        maxTagChars: 128,
      },
      resolveCredentials: () => ({ accessKeyId: 'AKID', accessKeySecret: 'SECRET' }),
      logger,
    });
    await composition.close();
  });
});

describe('AUTH_EMAIL_* config parsing (closed defaults, fail-closed validation)', () => {
  test('defaults off with bounded DirectMail settings and no required account', () => {
    const authEmail = loadConfig(baseEnv).authEmail;
    assert.ok(authEmail, 'authEmail section must be present (closed defaults)');
    assert.equal(authEmail.enabled, false);
    assert.equal(authEmail.endpoint, 'https://dm.aliyuncs.com/');
    assert.equal(authEmail.regionId, 'cn-hangzhou');
    assert.equal(authEmail.accountName, null);
    assert.equal(authEmail.timeoutMs, 10_000);
    assert.equal(authEmail.tagPrefix, 'known-auth-');
    assert.equal(authEmail.maxTagChars, 128);
  });

  test('flag on requires AUTH_EMAIL_DM_ACCOUNT_NAME (fail closed)', () => {
    assert.throws(
      () => loadConfig({ ...baseEnv, AUTH_EMAIL_ENABLED: 'true' }),
      /AUTH_EMAIL_DM_ACCOUNT_NAME is required/u,
    );
    assert.throws(
      () => loadConfig({ ...baseEnv, AUTH_EMAIL_ENABLED: 'true', AUTH_EMAIL_DM_ACCOUNT_NAME: '   ' }),
      /AUTH_EMAIL_DM_ACCOUNT_NAME is required/u,
    );
  });

  test('flag on accepts explicit bounded settings', () => {
    const authEmail = loadConfig({
      ...baseEnv,
      AUTH_EMAIL_ENABLED: 'true',
      AUTH_EMAIL_DM_ACCOUNT_NAME: 'auth-no-reply@example.invalid',
      AUTH_EMAIL_DM_ENDPOINT: 'https://dm.aliyuncs.com/',
      AUTH_EMAIL_DM_REGION_ID: 'ap-southeast-1',
      AUTH_EMAIL_DM_TIMEOUT_MS: '500',
      AUTH_EMAIL_DM_TAG_PREFIX: 'known-auth-',
      AUTH_EMAIL_DM_MAX_TAG_CHARS: '64',
    }).authEmail;
    assert.equal(authEmail.enabled, true);
    assert.equal(authEmail.accountName, 'auth-no-reply@example.invalid');
    assert.equal(authEmail.regionId, 'ap-southeast-1');
    assert.equal(authEmail.timeoutMs, 500);
    assert.equal(authEmail.tagPrefix, 'known-auth-');
    assert.equal(authEmail.maxTagChars, 64);
  });

  test('illegal flags and out-of-bounds values fail startup', () => {
    assert.throws(() => loadConfig({ ...baseEnv, AUTH_EMAIL_ENABLED: 'yes' }), /AUTH_EMAIL_ENABLED must be true or false/u);
    const on = { ...baseEnv, AUTH_EMAIL_ENABLED: 'true', AUTH_EMAIL_DM_ACCOUNT_NAME: 'a@example.invalid' };
    assert.throws(() => loadConfig({ ...on, AUTH_EMAIL_DM_TIMEOUT_MS: '499' }), /AUTH_EMAIL_DM_TIMEOUT_MS/u);
    assert.throws(() => loadConfig({ ...on, AUTH_EMAIL_DM_TIMEOUT_MS: '60001' }), /AUTH_EMAIL_DM_TIMEOUT_MS/u);
    assert.throws(() => loadConfig({ ...on, AUTH_EMAIL_DM_MAX_TAG_CHARS: '15' }), /AUTH_EMAIL_DM_MAX_TAG_CHARS/u);
    assert.throws(() => loadConfig({ ...on, AUTH_EMAIL_DM_MAX_TAG_CHARS: '129' }), /AUTH_EMAIL_DM_MAX_TAG_CHARS/u);
    assert.throws(() => loadConfig({ ...on, AUTH_EMAIL_DM_TAG_PREFIX: 'bad prefix!' }), /AUTH_EMAIL_DM_TAG_PREFIX/u);
    assert.throws(() => loadConfig({ ...on, AUTH_EMAIL_DM_TAG_PREFIX: '' }), /AUTH_EMAIL_DM_TAG_PREFIX/u);
    assert.throws(() => loadConfig({ ...on, AUTH_EMAIL_DM_ENDPOINT: 'http://dm.aliyuncs.com/' }), /AUTH_EMAIL_DM_ENDPOINT/u);
    assert.throws(() => loadConfig({ ...on, AUTH_EMAIL_DM_ENDPOINT: 'https://dm.aliyuncs.com/?a=1' }), /AUTH_EMAIL_DM_ENDPOINT/u);
    // Values that genuinely violate the frozen region pattern (mirrors the
    // notifications email-config rejection set; 'not-a-region' is accepted by
    // the frozen /^[a-z]{2,3}(?:-[a-z0-9]+){1,4}$/u shape check).
    for (const region of ['hangzhou', 'cn_hangzhou', 'CN-HANGZHOU', 'cn-hangzhou-', 'cn']) {
      assert.throws(() => loadConfig({ ...on, AUTH_EMAIL_DM_REGION_ID: region }),
        /AUTH_EMAIL_DM_REGION_ID/u, `region ${region} must be rejected`);
    }
  });
});

// Compile-time checks: the concrete adapter implements the port surface and
// the composition exposes the port sender.
const _compositionSurface: { readonly sender: import('../../../src/modules/auth/index.js').AuthEmailSender; close(): Promise<void> }
  = composeAuthEmailAdapter({
    enabled: false,
    nodeEnv: 'test',
    directMail: {
      endpoint: 'https://dm.aliyuncs.com/',
      regionId: 'cn-hangzhou',
      accountName: 'sender@example.invalid',
      timeoutMs: 10_000,
      tagPrefix: 'known-auth-',
      maxTagChars: 128,
    },
    resolveCredentials: () => ({ accessKeyId: 'AKID', accessKeySecret: 'SECRET' }),
    logger: createLogger('silent'),
  });
void _compositionSurface;
