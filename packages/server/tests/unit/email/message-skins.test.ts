import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  EMAIL_SKIN_BODY_MAX_BYTES,
  EMAIL_SKIN_PURPOSES,
  EMAIL_SKIN_SUBJECT_MAX_CHARS,
  defaultEmailSkinMap,
  mailClassForPurpose,
  parseEmailSkinConfig,
  wrapEmailMessage,
  wrapEmailTemplateRenderers,
  type EmailSkinMessage,
  type EmailSkinPurpose,
} from '../../../src/infrastructure/email/message-skins.js';
import { renderMarketingNotice } from '../../../src/infrastructure/email/marketing-notice.js';
import {
  UNIFIED_CHROME_MARKETING_UNSUBSCRIBE,
  UNIFIED_EMAIL_SKIN,
} from '../../../src/infrastructure/email/unified-email-chrome.js';
import { renderEmailHeading } from '../../../src/infrastructure/email/email-inner-blocks.js';
import { createEmailTemplateRenderers } from '../../../src/modules/notifications/index.js';
import type {
  EmailTemplateContext,
  EmailTemplateMessage,
  EmailTemplateNotificationType,
} from '../../../src/modules/notifications/index.js';

const OTP = '483920';
const backendRoot = resolve(import.meta.dirname, '../../..');

const otpInner: EmailSkinMessage = {
  subject: 'Your Know-N sign-in code',
  textBody: `Your sign-in code is:\n\n${OTP}\n\nThis code expires in 5 minutes.`,
  htmlBody: `<p>Your sign-in code is:</p>\n<p><strong>${OTP}</strong></p>`,
};

const configEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

function splitAroundInner(wrapped: string, inner: string): { header: string; footer: string } {
  const start = wrapped.indexOf(inner);
  assert.ok(start >= 0, 'inner fragment must appear unchanged in the wrap');
  assert.equal(wrapped.indexOf(inner, start + inner.length), -1, 'inner fragment must appear once');
  return {
    header: wrapped.slice(0, start),
    footer: wrapped.slice(start + inner.length),
  };
}

function allPurpose(map: ReturnType<typeof parseEmailSkinConfig>): void {
  for (const purpose of EMAIL_SKIN_PURPOSES) {
    assert.equal(map[purpose], 'purpose', purpose);
  }
}

function allUnified(map: ReturnType<typeof parseEmailSkinConfig>): void {
  for (const purpose of EMAIL_SKIN_PURPOSES) {
    assert.equal(map[purpose], 'unified', purpose);
  }
}

describe('parseEmailSkinConfig', () => {
  test('empty env defaults every closed purpose to unified (R7-31)', () => {
    allUnified(parseEmailSkinConfig({}));
    allUnified(defaultEmailSkinMap());
  });

  test('EMAIL_SKIN_DEFAULT=purpose succeeds and is never an unknown purpose', () => {
    allPurpose(parseEmailSkinConfig({ EMAIL_SKIN_DEFAULT: 'purpose' }));
  });

  test('EMAIL_SKIN_DEFAULT=pink refuses startup', () => {
    assert.throws(
      () => parseEmailSkinConfig({ EMAIL_SKIN_DEFAULT: 'pink' }),
      /EMAIL_SKIN_DEFAULT must be purpose or unified/u,
    );
  });

  test('EMAIL_SKIN_NOT_A_PURPOSE=unified refuses startup', () => {
    assert.throws(
      () => parseEmailSkinConfig({ EMAIL_SKIN_NOT_A_PURPOSE: 'unified' }),
      /EMAIL_SKIN_NOT_A_PURPOSE is not a known email skin purpose/u,
    );
  });

  test('legal EMAIL_SKIN_DEFAULT=unified fills every purpose, then one override stays local', () => {
    const map = parseEmailSkinConfig({
      EMAIL_SKIN_DEFAULT: 'unified',
      EMAIL_SKIN_SIGN_IN_OTP: 'purpose',
    });
    assert.equal(map['sign-in-otp'], 'purpose');
    for (const purpose of EMAIL_SKIN_PURPOSES) {
      if (purpose === 'sign-in-otp') continue;
      assert.equal(map[purpose], 'unified', purpose);
    }
  });

  test('hyphen and underscore purpose suffixes map to the closed set', () => {
    const map = parseEmailSkinConfig({
      EMAIL_SKIN_FOLLOW_ACTIVITY: 'unified',
      EMAIL_SKIN_COLLECTION_CHANGE: 'unified',
      EMAIL_SKIN_COLLABORATION_INVITE: 'unified',
      EMAIL_SKIN_MARKETING_NOTICE: 'unified',
      EMAIL_SKIN_EMAIL_VERIFICATION_OTP: 'unified',
    });
    assert.equal(map.follow_activity, 'unified');
    assert.equal(map.collection_change, 'unified');
    assert.equal(map['collaboration-invite'], 'unified');
    assert.equal(map['marketing-notice'], 'unified');
    assert.equal(map['email-verification-otp'], 'unified');
    // Untouched purposes ride the unified default (R7-31).
    assert.equal(map['sign-in-otp'], 'unified');
  });

  test('unrelated keys and a polluted process.env are ignored', () => {
    const previous = process.env.EMAIL_SKIN_DEFAULT;
    process.env.EMAIL_SKIN_DEFAULT = 'unified';
    try {
      const map = parseEmailSkinConfig({
        EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid',
        KNOWN_FEATURE_EMAIL: 'false',
      });
      allUnified(map);
    } finally {
      if (previous === undefined) delete process.env.EMAIL_SKIN_DEFAULT;
      else process.env.EMAIL_SKIN_DEFAULT = previous;
    }
  });

  test('known purpose with an illegal value refuses startup', () => {
    assert.throws(
      () => parseEmailSkinConfig({ EMAIL_SKIN_SIGN_IN_OTP: 'pink' }),
      /EMAIL_SKIN_SIGN_IN_OTP must be purpose or unified/u,
    );
  });
});

describe('loadConfig email skins', () => {
  test('EMAIL_SKIN_DEFAULT=pink refuses startup', () => {
    assert.throws(
      () => loadConfig({ ...configEnv, EMAIL_SKIN_DEFAULT: 'pink' }),
      /EMAIL_SKIN_DEFAULT must be purpose or unified/u,
    );
  });

  test('EMAIL_SKIN_NOT_A_PURPOSE=unified refuses startup', () => {
    assert.throws(
      () => loadConfig({ ...configEnv, EMAIL_SKIN_NOT_A_PURPOSE: 'unified' }),
      /EMAIL_SKIN_NOT_A_PURPOSE is not a known email skin purpose/u,
    );
  });

  test('EMAIL_SKIN_DEFAULT=purpose succeeds', () => {
    const { emailSkins } = loadConfig({ ...configEnv, EMAIL_SKIN_DEFAULT: 'purpose' });
    allPurpose(emailSkins);
  });

  test('overriding one purpose does not change others', () => {
    const { emailSkins } = loadConfig({
      ...configEnv,
      EMAIL_SKIN_SIGN_IN_OTP: 'purpose',
    });
    assert.equal(emailSkins['sign-in-otp'], 'purpose');
    assert.equal(emailSkins.follow_activity, 'unified');
    assert.equal(emailSkins['collaboration-invite'], 'unified');
    assert.equal(emailSkins['marketing-notice'], 'unified');
  });
});

describe('wrapEmailMessage', () => {
  test('purpose skin returns the inner message unchanged', () => {
    const wrapped = wrapEmailMessage({
      purpose: 'sign-in-otp',
      skin: 'purpose',
      mailClass: 'transactional',
      message: otpInner,
    });
    assert.equal(wrapped.ok, true);
    if (!wrapped.ok) return;
    assert.deepEqual(wrapped.message, otpInner);
    assert.doesNotMatch(wrapped.message.htmlBody, /data-known-email-skin/u);
  });

  test('unified wrap writes the skin marker and keeps OTP out of header/footer and subject', () => {
    const wrapped = wrapEmailMessage({
      purpose: 'sign-in-otp',
      skin: 'unified',
      mailClass: 'transactional',
      message: otpInner,
    });
    assert.equal(wrapped.ok, true);
    if (!wrapped.ok) return;
    assert.equal(wrapped.message.subject, otpInner.subject);
    assert.doesNotMatch(wrapped.message.subject, new RegExp(OTP, 'u'));
    assert.match(wrapped.message.htmlBody, new RegExp(`data-known-email-skin="${UNIFIED_EMAIL_SKIN}"`, 'u'));
    const htmlParts = splitAroundInner(wrapped.message.htmlBody, otpInner.htmlBody);
    assert.doesNotMatch(htmlParts.header, new RegExp(OTP, 'u'));
    assert.doesNotMatch(htmlParts.footer, new RegExp(OTP, 'u'));
    const textParts = splitAroundInner(wrapped.message.textBody, otpInner.textBody);
    assert.doesNotMatch(textParts.header, new RegExp(OTP, 'u'));
    assert.doesNotMatch(textParts.footer, new RegExp(OTP, 'u'));
    assert.doesNotMatch(wrapped.message.htmlBody, /unsubscribe/iu);
    assert.doesNotMatch(wrapped.message.textBody, /unsubscribe/iu);
  });

  test('subject longer than 100 after wrap is ok:false with a static reason and no truncation', () => {
    const longSubject = 'K'.repeat(EMAIL_SKIN_SUBJECT_MAX_CHARS + 1);
    const wrapped = wrapEmailMessage({
      purpose: 'sign-in-otp',
      skin: 'unified',
      mailClass: 'transactional',
      message: { ...otpInner, subject: longSubject },
    });
    assert.equal(wrapped.ok, false);
    if (wrapped.ok) return;
    assert.equal('message' in wrapped, false);
    assert.match(wrapped.reason, /subject exceeds/u);
    assert.doesNotMatch(wrapped.reason, new RegExp(OTP, 'u'));
    assert.doesNotMatch(wrapped.reason, new RegExp(longSubject.slice(0, 16), 'u'));
    assert.equal(longSubject.length, EMAIL_SKIN_SUBJECT_MAX_CHARS + 1);
  });

  test('body over 80 KiB after wrap is ok:false and does not truncate OTP', () => {
    const huge = `${'a'.repeat(EMAIL_SKIN_BODY_MAX_BYTES + 1)}${OTP}`;
    const wrapped = wrapEmailMessage({
      purpose: 'follow_activity',
      skin: 'purpose',
      mailClass: 'transactional',
      message: { subject: 'A collection update', textBody: huge, htmlBody: `<p>${huge}</p>` },
    });
    assert.equal(wrapped.ok, false);
    if (wrapped.ok) return;
    assert.match(wrapped.reason, /body exceeds/u);
    assert.doesNotMatch(wrapped.reason, new RegExp(OTP, 'u'));
  });

  test('mailClass must match the purpose', () => {
    const mismatch = wrapEmailMessage({
      purpose: 'sign-in-otp',
      skin: 'unified',
      mailClass: 'marketing',
      message: otpInner,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mailClassForPurpose('sign-in-otp'), 'transactional');
    assert.equal(mailClassForPurpose('marketing-notice'), 'marketing');
  });
});

describe('wrapEmailTemplateRenderers', () => {
  const context = Object.freeze({
    notificationType: 'follow_activity' as const,
    actorName: 'Ada',
    collectionTitle: null,
    occurredAt: new Date('2026-08-23T00:00:00.000Z'),
  });

  test('purpose skin keeps the inner renderer copy pixel-equal', () => {
    const inner = createEmailTemplateRenderers();
    const wrapped = wrapEmailTemplateRenderers(
      inner,
      parseEmailSkinConfig({ EMAIL_SKIN_DEFAULT: 'purpose' }),
    );
    assert.deepEqual(
      wrapped.render('follow_activity', context),
      inner.render('follow_activity', context),
    );
  });

  test('unified follow_activity html carries the chrome marker', () => {
    const inner = createEmailTemplateRenderers();
    const wrapped = wrapEmailTemplateRenderers(
      inner,
      parseEmailSkinConfig({ EMAIL_SKIN_FOLLOW_ACTIVITY: 'unified' }),
    );
    const message = wrapped.render('follow_activity', context);
    assert.match(message.htmlBody ?? '', new RegExp(`data-known-email-skin="${UNIFIED_EMAIL_SKIN}"`, 'u'));
    assert.doesNotMatch(message.htmlBody ?? '', /unsubscribe/iu);
  });

  test('over-budget wrap throws a static TypeError without sending copy', () => {
    const inner = {
    render(
      notificationType: EmailTemplateNotificationType,
      context: EmailTemplateContext,
    ): EmailTemplateMessage {
      void notificationType;
      void context;
      return {
        subject: 'K'.repeat(EMAIL_SKIN_SUBJECT_MAX_CHARS + 1),
        textBody: 'x',
        htmlBody: '<p>x</p>',
      };
    },
    };
    const wrapped = wrapEmailTemplateRenderers(inner, defaultEmailSkinMap());
    assert.throws(
      () => wrapped.render('follow_activity', context),
      (error: unknown) => error instanceof TypeError
        && /subject exceeds/u.test((error as TypeError).message)
        && !new RegExp(OTP, 'u').test((error as TypeError).message),
    );
  });
});

describe('marketing-notice renderer', () => {
  const input = {
    heading: 'A Know-N product notice',
    bodyText: 'Library sharing is getting a quieter layout.',
    ctaUrl: 'https://known.example/blog/notice',
  };

  test('purpose skin has no chrome marker and no unsubscribe sentence', () => {
    const rendered = renderMarketingNotice(input, 'purpose');
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    assert.equal(rendered.message.subject, input.heading);
    assert.ok(rendered.message.textBody.includes(input.bodyText));
    assert.ok(rendered.message.htmlBody.includes(input.ctaUrl));
    assert.doesNotMatch(rendered.message.htmlBody, /data-known-email-skin/u);
    assert.doesNotMatch(rendered.message.textBody, /unsubscribe/iu);
    assert.doesNotMatch(rendered.message.htmlBody, /notice@example/u);
  });

  test('unified skin writes the chrome marker and the marketing unsubscribe sentence', () => {
    const rendered = renderMarketingNotice(input, 'unified');
    assert.equal(rendered.ok, true);
    if (!rendered.ok) return;
    assert.match(rendered.message.htmlBody, new RegExp(`data-known-email-skin="${UNIFIED_EMAIL_SKIN}"`, 'u'));
    assert.ok(rendered.message.textBody.includes(UNIFIED_CHROME_MARKETING_UNSUBSCRIBE));
    assert.ok(rendered.message.htmlBody.includes(UNIFIED_CHROME_MARKETING_UNSUBSCRIBE));
    const htmlParts = splitAroundInner(
      rendered.message.htmlBody,
      renderEmailHeading(input.heading),
    );
    assert.doesNotMatch(htmlParts.header, /unsubscribe/iu);
  });

  test('user text is HTML-escaped and ctaUrl is optional', () => {
    const escaped = renderMarketingNotice({
      heading: 'Hello <script>',
      bodyText: 'Use "quotes" & more',
    }, 'purpose');
    assert.equal(escaped.ok, true);
    if (!escaped.ok) return;
    assert.match(escaped.message.htmlBody, /&lt;script&gt;/u);
    assert.doesNotMatch(escaped.message.htmlBody, /<script>/u);
    assert.match(escaped.message.htmlBody, /&quot;quotes&quot; &amp; more/u);
    assert.doesNotMatch(escaped.message.htmlBody, /<a href=/u);
  });
});

describe('MAIL-01 source negatives', () => {
  test('SingleSendMail param builder still has no TemplateName', () => {
    const source = readFileSync(
      resolve(backendRoot, 'src/infrastructure/email/aliyun-directmail-adapter.ts'),
      'utf8',
    );
    assert.match(source, /function buildSingleSendMailParams/u);
    assert.doesNotMatch(source, /TemplateName/u);
  });

  test('application email delivery worker still has no chrome import', () => {
    const source = readFileSync(
      resolve(backendRoot, 'src/modules/notifications/application/email-delivery-worker.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /unified-email-chrome/u);
    assert.doesNotMatch(source, /message-skins/u);
    assert.doesNotMatch(source, /wrapUnifiedEmailChrome/u);
    assert.doesNotMatch(source, /wrapEmailMessage/u);
    assert.doesNotMatch(source, /infrastructure\/email/u);
  });

  test('closed purpose set includes the required auth, invite, notification, and marketing names', () => {
    const expected: readonly EmailSkinPurpose[] = [
      'sign-in-otp', 'email-verification-otp', 'forget-password-otp', 'change-email-otp',
      'email-verification', 'password-reset', 'email-change', 'mfa-recovery',
      'collaboration-invite', 'follow_activity', 'collection_change', 'marketing-notice',
    ];
    assert.deepEqual([...EMAIL_SKIN_PURPOSES], [...expected]);
  });
});
