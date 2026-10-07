import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  EMAIL_INNER_P_STYLE,
  renderEmailCtaButton,
  renderEmailFooterNote,
  renderEmailHeading,
  renderEmailInnerParagraph,
  renderEmailPreheader,
  renderOtpBlock,
  renderRecoveryCodes,
} from '../../../src/infrastructure/email/email-inner-blocks.js';
import { EMAIL_FONT_SANS, EMAIL_SIGNATURE } from '../../../src/infrastructure/email/email-brand.js';
import { renderMarketingNotice } from '../../../src/infrastructure/email/marketing-notice.js';
import { renderAuthEmailTemplate } from '../../../src/modules/auth/index.js';
import { renderInviteEmailTemplate } from '../../../src/modules/access-policy/index.js';
import {
  renderCollectionChangeEmail,
  renderFollowActivityEmail,
} from '../../../src/modules/notifications/index.js';

/**
 * The module-layer template leaves (modules/auth, modules/access-policy,
 * modules/notifications) must not import infrastructure, so they carry
 * byte-equal MIRRORS of the shared inner blocks in
 * src/infrastructure/email/email-inner-blocks.ts. These tests pin every
 * mirror against the canonical renderer so the copies cannot drift.
 */

const OTP = '483920';
const URL = 'https://app.example.invalid/verify?token=abc';
const CODES = ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH'] as const;

describe('canonical inner blocks', () => {
  test('CTA button is the ink .btn-primary with inline styles and escaped label/href', () => {
    const button = renderEmailCtaButton('Open & go', 'https://x.example/?a=1&b=2');
    assert.match(button, /^<a href="https:\/\/x\.example\/\?a=1&amp;b=2" /u);
    assert.match(button, /display:inline-block/u);
    assert.match(button, /background:rgb\(6, 7, 10\)/u);
    assert.match(button, /color:rgb\(243, 245, 248\)/u);
    assert.match(button, /padding:12px 18px/u);
    assert.match(button, /border-radius:8px/u);
    assert.match(button, /font-weight:600/u);
    assert.match(button, /text-decoration:none/u);
    assert.ok(button.includes(EMAIL_FONT_SANS));
    assert.ok(button.endsWith('>Open &amp; go</a>'));
  });

  test('OTP block centers 28px mono digits on the tinted well', () => {
    const block = renderOtpBlock(OTP);
    assert.match(block, /background:rgb\(236, 240, 245\)/u);
    assert.match(block, /border-radius:8px/u);
    assert.match(block, /padding:16px/u);
    assert.match(block, /text-align:center/u);
    assert.match(block, /font-size:28px/u);
    assert.match(block, /font-weight:700/u);
    assert.match(block, /letter-spacing:0\.2em/u);
    assert.match(block, /ui-monospace, 'Cascadia Code', Consolas, monospace/u);
    assert.ok(block.includes(OTP));
  });

  test('recovery codes render as a styled 13px mono <pre> on the tinted well', () => {
    const block = renderRecoveryCodes(CODES);
    assert.match(block, /^<pre style="/u);
    assert.match(block, /background:rgb\(236, 240, 245\)/u);
    assert.match(block, /border-radius:8px/u);
    assert.match(block, /padding:16px/u);
    assert.match(block, /font-size:13px/u);
    assert.ok(block.includes(CODES.join('\n')));
  });

  test('heading is the 22px semibold ink h1', () => {
    const heading = renderEmailHeading('A Know-N notice');
    assert.match(heading, /^<h1 style="/u);
    assert.match(heading, /font-size:22px/u);
    assert.match(heading, /line-height:1\.3/u);
    assert.match(heading, /font-weight:600/u);
    assert.match(heading, /color:rgb\(6, 7, 10\)/u);
    assert.ok(heading.endsWith('>A Know-N notice</h1>'));
  });

  test('preheader renders fully hidden', () => {
    const preheader = renderEmailPreheader('Preview copy');
    assert.match(preheader, /display:none/u);
    assert.match(preheader, /max-height:0/u);
    assert.match(preheader, /overflow:hidden/u);
    assert.match(preheader, /opacity:0/u);
    assert.ok(preheader.includes('Preview copy'));
  });

  test('footer note is the 12px muted paragraph', () => {
    const note = renderEmailFooterNote('Why you got this');
    assert.match(note, /^<p style="margin:16px 0 0 0/u);
    assert.match(note, /font-size:12px/u);
    assert.match(note, /color:rgb\(97, 99, 103\)/u);
    assert.ok(note.endsWith('>Why you got this</p>'));
  });

  test('paragraph helper carries the full inline style (Outlook strips head styles)', () => {
    assert.equal(renderEmailInnerParagraph('x'), `<p style="${EMAIL_INNER_P_STYLE}">x</p>`);
    assert.match(EMAIL_INNER_P_STYLE, /margin:0 0 1em 0/u);
    assert.match(EMAIL_INNER_P_STYLE, /font-size:16px/u);
    assert.match(EMAIL_INNER_P_STYLE, /line-height:1\.6/u);
    assert.match(EMAIL_INNER_P_STYLE, /color:rgb\(6, 7, 10\)/u);
    assert.ok(EMAIL_INNER_P_STYLE.includes(EMAIL_FONT_SANS));
    assert.match(EMAIL_FONT_SANS, /'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif$/u);
  });
});

describe('module template mirrors stay byte-equal to the canonical blocks', () => {
  test('auth templates: CTA buttons, OTP block, recovery codes and paragraph style', () => {
    const verification = renderAuthEmailTemplate('email-verification', { verificationUrl: URL });
    assert.equal(verification.ok, true);
    if (verification.ok) {
      assert.ok(verification.message.htmlBody.includes(renderEmailCtaButton('Verify my email', URL)));
      assert.ok(verification.message.htmlBody.includes(`<p style="${EMAIL_INNER_P_STYLE}">`));
    }

    const reset = renderAuthEmailTemplate('password-reset', { resetUrl: URL });
    assert.equal(reset.ok, true);
    if (reset.ok) {
      assert.ok(reset.message.htmlBody.includes(renderEmailCtaButton('Reset my password', URL)));
    }

    const change = renderAuthEmailTemplate('email-change', {
      newEmail: 'new-owner@example.invalid',
      verificationUrl: URL,
    });
    assert.equal(change.ok, true);
    if (change.ok) {
      assert.ok(change.message.htmlBody.includes(renderEmailCtaButton('Confirm my new email', URL)));
    }

    const otp = renderAuthEmailTemplate('sign-in-otp', { otp: OTP });
    assert.equal(otp.ok, true);
    if (otp.ok) {
      assert.ok(otp.message.htmlBody.includes(renderOtpBlock(OTP)));
    }

    const recovery = renderAuthEmailTemplate('mfa-recovery', { recoveryCodes: [...CODES] });
    assert.equal(recovery.ok, true);
    if (recovery.ok) {
      assert.ok(recovery.message.htmlBody.includes(renderRecoveryCodes(CODES)));
    }
  });

  test('invite template: CTA button and paragraph style', () => {
    const rendered = renderInviteEmailTemplate({
      inviterDisplayName: 'Ada',
      collectionTitle: 'Notes',
      role: 'editor',
      expiresAtUtcDate: '2026-09-01',
      loginUrl: URL,
    });
    assert.equal(rendered.ok, true);
    if (rendered.ok) {
      assert.ok(rendered.htmlBody.includes(renderEmailCtaButton('Sign in to view it', URL)));
      assert.ok(rendered.htmlBody.includes(`<p style="${EMAIL_INNER_P_STYLE}">`));
    }
  });

  test('notification templates: paragraph style mirror (no CTA — context carries no URL)', () => {
    const context = {
      notificationType: 'follow_activity' as const,
      actorName: 'Ada',
      collectionTitle: null,
      occurredAt: new Date('2026-08-23T00:00:00.000Z'),
    };
    const follow = renderFollowActivityEmail(context);
    assert.ok((follow.htmlBody ?? '').includes(`<p style="${EMAIL_INNER_P_STYLE}">`));
    const change = renderCollectionChangeEmail({ ...context, collectionTitle: 'Notes' });
    assert.ok((change.htmlBody ?? '').includes(`<p style="${EMAIL_INNER_P_STYLE}">`));
  });

  test('module signature mirrors stay byte-equal to EMAIL_SIGNATURE (chrome strips this exact line)', () => {
    // The unified chrome strips a trailing `<p>— Know-N</p>` / "\n— Know-N";
    // if a module's local signature constant drifted, stripping would silently
    // stop matching. Pin every leaf's trailing signature to the canonical one.
    const signatureParagraph = `<p style="${EMAIL_INNER_P_STYLE}">${EMAIL_SIGNATURE}</p>`;

    const verification = renderAuthEmailTemplate('email-verification', { verificationUrl: URL });
    assert.equal(verification.ok, true);
    if (verification.ok) {
      assert.ok(verification.message.htmlBody.endsWith(signatureParagraph));
      assert.ok(verification.message.textBody.endsWith(`\n\n${EMAIL_SIGNATURE}`));
    }

    const invite = renderInviteEmailTemplate({
      inviterDisplayName: 'Ada',
      collectionTitle: 'Notes',
      role: 'editor',
      expiresAtUtcDate: '2026-09-01',
      loginUrl: URL,
    });
    assert.equal(invite.ok, true);
    if (invite.ok) {
      assert.ok(invite.htmlBody.endsWith(signatureParagraph));
      assert.ok(invite.textBody.endsWith(`\n${EMAIL_SIGNATURE}`));
    }

    const follow = renderFollowActivityEmail({
      notificationType: 'follow_activity',
      actorName: 'Ada',
      collectionTitle: null,
      occurredAt: new Date('2026-08-23T00:00:00.000Z'),
    });
    assert.ok((follow.htmlBody ?? '').endsWith(signatureParagraph));
    assert.ok((follow.textBody ?? '').endsWith(`\n\n${EMAIL_SIGNATURE}`));
  });

  test('marketing notice uses the canonical button with a verb label, never the URL as link text', () => {
    const cta = 'https://known.example/blog/notice';
    const rendered = renderMarketingNotice({
      heading: 'A Know-N product notice',
      bodyText: 'Library sharing is getting a quieter layout.',
      ctaUrl: cta,
    }, 'purpose');
    assert.equal(rendered.ok, true);
    if (rendered.ok) {
      assert.ok(rendered.message.htmlBody.includes(renderEmailCtaButton('Open Know-N', cta)));
      assert.doesNotMatch(rendered.message.htmlBody, new RegExp(`>${cta}</a>`, 'u'));
      // The heading renders as the canonical h1 block, not a bold paragraph.
      assert.ok(rendered.message.htmlBody.includes(renderEmailHeading('A Know-N product notice')));
    }
  });

  test('marketing notice accepts a custom ctaLabel', () => {
    const cta = 'https://known.example/blog/notice';
    const rendered = renderMarketingNotice({
      heading: 'A Know-N product notice',
      bodyText: 'Library sharing is getting a quieter layout.',
      ctaUrl: cta,
      ctaLabel: 'Read the announcement',
    }, 'purpose');
    assert.equal(rendered.ok, true);
    if (rendered.ok) {
      assert.ok(rendered.message.htmlBody.includes(renderEmailCtaButton('Read the announcement', cta)));
    }
  });
});
