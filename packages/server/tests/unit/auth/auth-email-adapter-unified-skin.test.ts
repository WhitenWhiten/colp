import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  composeAuthEmailAdapter,
  createAuthEmailAdapter,
  createInProcessMailboxSink,
} from '../../../src/infrastructure/email/auth-email-adapter.js';
import { parseEmailSkinConfig } from '../../../src/infrastructure/email/message-skins.js';
import { UNIFIED_EMAIL_SKIN } from '../../../src/infrastructure/email/unified-email-chrome.js';
import type { EmailSendInput, EmailSendResult } from '../../../src/modules/email/index.js';
import {
  renderAuthEmailTemplate,
  type AuthEmailPurpose,
  type AuthEmailTemplateData,
} from '../../../src/modules/auth/index.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';

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


function capturingAuthProvider(): {
  readonly provider: { send(input: EmailSendInput): Promise<EmailSendResult> };
  readonly sent: EmailSendInput[];
} {
  const sent: EmailSendInput[] = [];
  return {
    sent,
    provider: {
      async send(input) {
        sent.push(input);
        return {
          classification: 'success',
          providerMessageId: 'auth-cap-1',
          requestId: null,
          errorCategory: null,
        };
      },
    },
  };
}

function splitAroundInner(wrapped: string, inner: string): { header: string; footer: string } {
  const start = wrapped.indexOf(inner);
  assert.ok(start >= 0, 'inner fragment must appear unchanged in the wrap');
  return {
    header: wrapped.slice(0, start),
    footer: wrapped.slice(start + inner.length),
  };
}

/** The unified chrome strips the duplicate trailing "— Know-N" signature from inner copy. */
function stripTrailingSignature(body: string): string {
  return body
    .replace(/\n+\u2014 Know-N\s*$/u, '')
    .replace(/\s*<p\b[^>]*>\u2014 Know-N<\/p>\s*$/u, '');
}

describe('MAIL-01 auth adapter unified skin', () => {
  test('default skins wrap html with the unified marker and keep the OTP (R7-31)', async () => {
    const cap = capturingAuthProvider();
    const sender = createAuthEmailAdapter({ provider: cap.provider, logger: createLogger('silent') });
    const result = await sender.sendAuthEmail(sendInput());
    assert.equal(result.outcome, 'queued');
    const html = cap.sent[0]?.message.htmlBody ?? '';
    assert.match(html, /data-known-email-skin/u);
    assert.match(html, new RegExp(OTP, 'u'));
  });

  test('explicit purpose opt-out keeps inner html without the unified marker', async () => {
    const cap = capturingAuthProvider();
    const sender = createAuthEmailAdapter({
      provider: cap.provider,
      logger: createLogger('silent'),
      emailSkins: parseEmailSkinConfig({ EMAIL_SKIN_DEFAULT: 'purpose' }),
    });
    const result = await sender.sendAuthEmail(sendInput());
    assert.equal(result.outcome, 'queued');
    const html = cap.sent[0]?.message.htmlBody ?? '';
    assert.doesNotMatch(html, /data-known-email-skin/u);
    assert.match(html, new RegExp(OTP, 'u'));
  });

  test('unified sign-in-otp html has chrome marker; OTP stays out of header/footer and subject', async () => {
    const inner = renderAuthEmailTemplate('sign-in-otp', { otp: OTP });
    assert.equal(inner.ok, true);
    if (!inner.ok) return;
    const cap = capturingAuthProvider();
    const sender = createAuthEmailAdapter({
      provider: cap.provider,
      logger: createLogger('silent'),
      emailSkins: parseEmailSkinConfig({ EMAIL_SKIN_SIGN_IN_OTP: 'unified' }),
    });
    const result = await sender.sendAuthEmail(sendInput());
    assert.equal(result.outcome, 'queued');
    assert.equal(cap.sent.length, 1);
    const sent = cap.sent[0]!.message;
    assert.match(sent.htmlBody ?? '', new RegExp(`data-known-email-skin="${UNIFIED_EMAIL_SKIN}"`, 'u'));
    assert.doesNotMatch(sent.subject, new RegExp(OTP, 'u'));
    const htmlParts = splitAroundInner(sent.htmlBody ?? '', stripTrailingSignature(inner.message.htmlBody));
    assert.doesNotMatch(htmlParts.header, new RegExp(OTP, 'u'));
    assert.doesNotMatch(htmlParts.footer, new RegExp(OTP, 'u'));
    assert.doesNotMatch(htmlParts.header, /unsubscribe/iu);
    assert.doesNotMatch(htmlParts.footer, /unsubscribe/iu);
    const textParts = splitAroundInner(sent.textBody ?? '', stripTrailingSignature(inner.message.textBody));
    assert.doesNotMatch(textParts.header, new RegExp(OTP, 'u'));
    assert.doesNotMatch(textParts.footer, new RegExp(OTP, 'u'));
  });

  test('composeAuthEmailAdapter threads skins so unified wrap reaches the mailbox', async () => {
    const sink = createInProcessMailboxSink();
    const composition = composeAuthEmailAdapter({
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
      logger: createLogger('silent'),
      inProcessSink: sink,
      emailSkins: parseEmailSkinConfig({ EMAIL_SKIN_SIGN_IN_OTP: 'unified' }),
    });
    try {
      const result = await composition.sender.sendAuthEmail(sendInput());
      assert.equal(result.outcome, 'queued');
      assert.match(sink.entries[0]?.textBody ?? '', /Know-N/u);
      assert.match(sink.entries[0]?.textBody ?? '', new RegExp(OTP, 'u'));
      assert.doesNotMatch(sink.entries[0]?.subject ?? '', new RegExp(OTP, 'u'));
    } finally {
      await composition.close();
    }
  });
});
