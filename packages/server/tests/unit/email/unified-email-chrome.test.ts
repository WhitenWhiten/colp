import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  UNIFIED_CHROME_MARKETING_UNSUBSCRIBE,
  UNIFIED_CHROME_PRODUCT_NAME,
  UNIFIED_CHROME_SIGNATURE,
  UNIFIED_CHROME_SUBJECT_MAX_CHARS,
  UNIFIED_CHROME_TAGLINE,
  UNIFIED_EMAIL_SKIN,
  wrapUnifiedEmailChrome,
  type UnifiedChromeMessage,
} from '../../../src/infrastructure/email/unified-email-chrome.js';

const OTP = '123456';

// Purpose inner copy ends with the plain signature — the unified chrome must
// strip that trailing line (the brand lockup already names the product) while
// leaving the rest of the inner fragment byte-equal.
const otpInner: UnifiedChromeMessage = {
  subject: 'Your Know-N sign-in code',
  textBody: `Your sign-in code is:\n\n${OTP}\n\nThis code expires in 5 minutes. Never share it with anyone.\n\n${UNIFIED_CHROME_SIGNATURE}`,
  htmlBody: `<p>Your sign-in code is:</p>\n<p><strong>${OTP}</strong></p>\n<p>This code expires in 5 minutes. Never share it with anyone.</p>\n<p>${UNIFIED_CHROME_SIGNATURE}</p>`,
};

/** The inner fragment as it must appear inside the unified wrap (signature stripped). */
const strippedText = `Your sign-in code is:\n\n${OTP}\n\nThis code expires in 5 minutes. Never share it with anyone.`;
const strippedHtml = `<p>Your sign-in code is:</p>\n<p><strong>${OTP}</strong></p>\n<p>This code expires in 5 minutes. Never share it with anyone.</p>`;

function splitAroundInner(wrapped: string, inner: string): { header: string; footer: string } {
  const start = wrapped.indexOf(inner);
  assert.ok(start >= 0, 'inner fragment must appear unchanged in the wrap');
  assert.equal(wrapped.indexOf(inner, start + inner.length), -1, 'inner fragment must appear once');
  return {
    header: wrapped.slice(0, start),
    footer: wrapped.slice(start + inner.length),
  };
}

describe('unified email chrome', () => {
  test('writes the stable unified skin marker on the outer wrapper', () => {
    const wrapped = wrapUnifiedEmailChrome({ mailClass: 'transactional', message: otpInner });
    assert.match(wrapped.htmlBody, new RegExp(`data-known-email-skin="${UNIFIED_EMAIL_SKIN}"`, 'u'));
    assert.equal(wrapped.subject, otpInner.subject);
    assert.ok(wrapped.subject.length <= UNIFIED_CHROME_SUBJECT_MAX_CHARS);
    assert.ok(wrapped.htmlBody.includes(strippedHtml));
    assert.ok(wrapped.textBody.includes(strippedText));
  });

  test('strips the duplicate trailing inner signature (lockup already names the product)', () => {
    const wrapped = wrapUnifiedEmailChrome({ mailClass: 'transactional', message: otpInner });
    assert.doesNotMatch(wrapped.textBody, new RegExp(UNIFIED_CHROME_SIGNATURE, 'u'));
    assert.doesNotMatch(wrapped.htmlBody, new RegExp(`>${UNIFIED_CHROME_SIGNATURE}<`, 'u'));
    // A styled signature paragraph (inline-styled inner copy) is stripped too.
    const styledInner: UnifiedChromeMessage = {
      ...otpInner,
      htmlBody: `${strippedHtml}\n<p style="margin:0 0 1em 0;">${UNIFIED_CHROME_SIGNATURE}</p>`,
    };
    const styledWrapped = wrapUnifiedEmailChrome({ mailClass: 'transactional', message: styledInner });
    assert.doesNotMatch(styledWrapped.htmlBody, new RegExp(`>${UNIFIED_CHROME_SIGNATURE}<`, 'u'));
    // Inner copy WITHOUT a trailing signature stays byte-equal.
    const bare: UnifiedChromeMessage = {
      subject: otpInner.subject, textBody: strippedText, htmlBody: strippedHtml };
    const bareWrapped = wrapUnifiedEmailChrome({ mailClass: 'transactional', message: bare });
    assert.ok(bareWrapped.htmlBody.includes(strippedHtml));
    assert.ok(bareWrapped.textBody.includes(strippedText));
  });

  test('transactional footer carries the faint tagline and no unsubscribe copy', () => {
    const wrapped = wrapUnifiedEmailChrome({ mailClass: 'transactional', message: otpInner });
    const { header, footer } = splitAroundInner(wrapped.htmlBody, strippedHtml);
    assert.doesNotMatch(header, /unsubscribe/iu);
    assert.doesNotMatch(footer, /unsubscribe/iu);
    assert.doesNotMatch(wrapped.htmlBody, /List-Unsubscribe/u);
    assert.doesNotMatch(wrapped.textBody, /unsubscribe/iu);
    assert.doesNotMatch(wrapped.textBody, /List-Unsubscribe/u);
    assert.ok(footer.includes(UNIFIED_CHROME_TAGLINE));
  });

  test('optional preheader renders hidden at body start; footerNote sits above the tagline', () => {
    const wrapped = wrapUnifiedEmailChrome({
      mailClass: 'transactional',
      message: otpInner,
      preheader: 'Your sign-in code is: <peek>',
      footerNote: 'You received this because an account was created with this address.',
    });
    const bodyStart = wrapped.htmlBody.indexOf('<body');
    const tableStart = wrapped.htmlBody.indexOf('data-known-email-skin');
    const preheaderAt = wrapped.htmlBody.indexOf('display:none;max-height:0;overflow:hidden');
    assert.ok(preheaderAt > bodyStart && preheaderAt < tableStart, 'preheader sits at body start');
    // Preheader copy is escaped.
    assert.ok(wrapped.htmlBody.includes('&lt;peek&gt;'));
    const footerAt = wrapped.htmlBody.indexOf(UNIFIED_CHROME_TAGLINE);
    const noteAt = wrapped.htmlBody.indexOf('an account was created with this address.');
    assert.ok(noteAt > 0 && noteAt < footerAt, 'footerNote renders above the tagline');
  });

  test('marketing footer includes a plaintext unsubscribe sentence and the tagline', () => {
    const wrapped = wrapUnifiedEmailChrome({ mailClass: 'marketing', message: otpInner });
    const { header, footer } = splitAroundInner(wrapped.htmlBody, strippedHtml);
    assert.doesNotMatch(header, /unsubscribe/iu);
    assert.match(footer, /unsubscribe/iu);
    assert.ok(footer.includes(UNIFIED_CHROME_MARKETING_UNSUBSCRIBE));
    assert.ok(footer.includes(UNIFIED_CHROME_TAGLINE));
    assert.ok(wrapped.textBody.endsWith(UNIFIED_CHROME_MARKETING_UNSUBSCRIBE));
    assert.doesNotMatch(wrapped.htmlBody, /List-Unsubscribe/u);
  });

  test('OTP 123456 does not appear in header or footer chrome', () => {
    const wrapped = wrapUnifiedEmailChrome({ mailClass: 'transactional', message: otpInner });
    const htmlParts = splitAroundInner(wrapped.htmlBody, strippedHtml);
    assert.doesNotMatch(htmlParts.header, new RegExp(OTP, 'u'));
    assert.doesNotMatch(htmlParts.footer, new RegExp(OTP, 'u'));
    assert.match(wrapped.htmlBody, new RegExp(`<strong>${OTP}</strong>`, 'u'));

    const textParts = splitAroundInner(wrapped.textBody, strippedText);
    assert.doesNotMatch(textParts.header, new RegExp(OTP, 'u'));
    assert.doesNotMatch(textParts.footer, new RegExp(OTP, 'u'));
    assert.equal(textParts.header, `\n${UNIFIED_CHROME_PRODUCT_NAME}\n\n`);
    assert.equal(textParts.footer, '');
  });

  test('chrome stays small relative to the 80 KiB body budget', () => {
    const wrapped = wrapUnifiedEmailChrome({ mailClass: 'marketing', message: otpInner });
    const chromeBytes = Buffer.byteLength(wrapped.htmlBody, 'utf8')
      - Buffer.byteLength(otpInner.htmlBody, 'utf8');
    assert.ok(chromeBytes < 8 * 1024, `chrome html is ${chromeBytes} bytes`);
    assert.ok(Buffer.byteLength(wrapped.htmlBody, 'utf8') < 80 * 1024);
  });
});
