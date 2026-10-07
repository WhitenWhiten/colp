/**
 * Unified email chrome (visual envelope only).
 *
 * MAIL-01 `wrapEmailMessage` calls `wrapUnifiedEmailChrome` when skin=`unified`.
 * Purpose inner subject/text/html are concatenated, not rewritten: OTP, recovery
 * codes, and verification URLs stay exactly where the purpose renderer put them.
 *
 * Chrome copy is static product identity only — never recipient email, OTP,
 * recovery codes, or URLs. Marketing chrome may add a plaintext unsubscribe
 * sentence; transactional chrome must not (P5-27 UnSubscribeLinkType=disabled).
 */

import { EMAIL_FONT_SANS, EMAIL_SIGNATURE } from './email-brand.js';
import { renderEmailFooterNote, renderEmailPreheader } from './email-inner-blocks.js';

export type EmailMailClass = 'transactional' | 'marketing';

export interface UnifiedChromeMessage {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

/** Skin token written on the outer HTML wrapper for MAIL-01 assertions. */
export const UNIFIED_EMAIL_SKIN = 'unified';

/** Mirrors the frozen EMAIL_SUBJECT_MAX_CHARS budget (P5-28 / C1). */
export const UNIFIED_CHROME_SUBJECT_MAX_CHARS = 100;

export const UNIFIED_CHROME_PRODUCT_NAME = 'Know-N';

export const UNIFIED_CHROME_SIGNATURE = EMAIL_SIGNATURE;

/** Footer tagline on every envelope (faint, 12px). */
export const UNIFIED_CHROME_TAGLINE = 'Know-N · Your bookmarks, organized and shareable.';

/** Marketing-only footer sentence. Not a List-Unsubscribe header. */
export const UNIFIED_CHROME_MARKETING_UNSUBSCRIBE =
  'You can unsubscribe from these Know-N notices at any time.';

const FONT_SANS = EMAIL_FONT_SANS;

/** Product tokens inlined — email clients drop CSS custom properties. */
const PAPER = 'rgb(243, 245, 248)';
const SURFACE = 'rgb(252, 253, 255)';
const INK = 'rgb(6, 7, 10)';
const MUTED = 'rgb(97, 99, 103)';
const FAINT = 'rgb(104, 106, 110)';
/** Card stroke — matches tokens.css --line-strong. */
const LINE_CARD = 'rgba(6, 7, 10, 0.12)';
/** Footer hairline — tokens.css --line. */
const LINE = 'rgba(6, 7, 10, 0.06)';
const ACCENT = 'rgb(56, 102, 149)';
const PAPER_HEX = '#F3F5F8';
const SURFACE_HEX = '#FCFDFF';

/**
 * Wrap an already-rendered purpose message in the unified paper envelope.
 * Does not escape `htmlBody` — callers pass a trusted inner fragment.
 */
export function wrapUnifiedEmailChrome(input: {
  readonly mailClass: EmailMailClass;
  readonly message: UnifiedChromeMessage;
  /** Inbox preview snippet (first body line, ≤ 90 chars) rendered hidden at body start. */
  readonly preheader?: string;
  /** Small muted sentence above the footer tagline (why the recipient got this mail). */
  readonly footerNote?: string;
}): UnifiedChromeMessage {
  const { mailClass, message } = input;
  return {
    subject: wrapSubject(message.subject),
    textBody: wrapText(mailClass, message.textBody),
    htmlBody: wrapHtml(mailClass, message.subject, message.htmlBody, input.preheader, input.footerNote),
  };
}

/**
 * Inner copy owns the subject (OTP never belongs here). Prefer leaving it
 * unchanged: purpose subjects already name Know-N, and a prefix would eat
 * the 100-character budget that MAIL-01 checks after wrap.
 */
function wrapSubject(subject: string): string {
  return subject;
}

/**
 * The purpose inner copy ends with the plain "— Know-N" signature so the
 * `purpose` skin stays self-identifying. Under the unified chrome the brand
 * lockup already names the product, so a trailing inner signature is stripped
 * before wrapping (text line + signature `<p>`). Signatures anywhere else in
 * the body are left untouched.
 */
const TRAILING_TEXT_SIGNATURE = /\n+\u2014 Know-N\s*$/u;
const TRAILING_HTML_SIGNATURE = /\s*<p\b[^>]*>\u2014 Know-N<\/p>\s*$/u;

function stripTrailingTextSignature(textBody: string): string {
  return textBody.replace(TRAILING_TEXT_SIGNATURE, '');
}

function stripTrailingHtmlSignature(htmlBody: string): string {
  return htmlBody.replace(TRAILING_HTML_SIGNATURE, '');
}

function wrapText(mailClass: EmailMailClass, textBody: string): string {
  const lines = [
    '',
    UNIFIED_CHROME_PRODUCT_NAME,
    '',
    stripTrailingTextSignature(textBody),
  ];
  if (mailClass === 'marketing') {
    lines.push('', UNIFIED_CHROME_MARKETING_UNSUBSCRIBE);
  }
  return lines.join('\n');
}

function wrapHtml(
  mailClass: EmailMailClass,
  subject: string,
  htmlBody: string,
  preheader?: string,
  footerNote?: string,
): string {
  const footerNoteRow = footerNote !== undefined
    ? `<tr>
                      <td>${renderEmailFooterNote(escapeXml(footerNote))}</td>
                    </tr>`
    : '';
  const marketingUnsubscribeRow = mailClass === 'marketing'
    ? `<tr>
                      <td height="6" style="height:6px;font-size:0;line-height:0;">&nbsp;</td>
                    </tr>
                    <tr>
                      <td style="font-family:${FONT_SANS};font-size:12px;line-height:1.5;color:${FAINT};">${UNIFIED_CHROME_MARKETING_UNSUBSCRIBE}</td>
                    </tr>`
    : '';
  const footer = `<tr>
                <td bgcolor="${SURFACE_HEX}" style="padding:28px 32px;border-top:1px solid ${LINE};background-color:${SURFACE};">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    ${footerNoteRow}
                    <tr>
                      <td style="font-family:${FONT_SANS};font-size:12px;line-height:1.5;color:${FAINT};">${UNIFIED_CHROME_TAGLINE}</td>
                    </tr>
                    ${marketingUnsubscribeRow}
                  </table>
                </td>
              </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeXml(subject)}</title>
<style>
  a { color: ${ACCENT}; }
  p { margin: 0 0 1em 0; }
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${PAPER};">
${preheader !== undefined ? renderEmailPreheader(escapeXml(preheader)) : ''}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" data-known-email-skin="${UNIFIED_EMAIL_SKIN}" style="width:100%;background-color:${PAPER};">
  <tr>
    <td align="center" bgcolor="${PAPER_HEX}" style="padding:32px 16px 40px;background-color:${PAPER};">
      <!--[if mso]><table role="presentation" width="580" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="580" style="width:100%;max-width:580px;background-color:${SURFACE};border:1px solid ${LINE_CARD};border-radius:8px;overflow:hidden;">
        <tr>
          <td bgcolor="${SURFACE_HEX}" style="padding:28px 32px;background-color:${SURFACE};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:${FONT_SANS};font-size:18px;font-weight:600;letter-spacing:-0.02em;color:${INK};">Know-N</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td bgcolor="${SURFACE_HEX}" style="padding:28px 32px;background-color:${SURFACE};font-family:${FONT_SANS};font-size:16px;line-height:1.6;color:${INK};">
${stripTrailingHtmlSignature(htmlBody)}
          </td>
        </tr>
        ${footer}
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}
