/**
 * Canonical shared inner-copy blocks for purpose email templates.
 *
 * Email clients (notably Outlook) strip `<head><style>` rules, so every inner
 * element carries inline styles. This file is the single source of truth for
 * the block markup; the module-layer template leaves (modules/auth,
 * modules/access-policy, modules/notifications) must not import
 * infrastructure, so they carry byte-equal MIRRORS of these constants —
 * `tests/unit/email/email-inner-blocks.test.ts` pins the mirrors against the
 * canonical renderers here.
 *
 * Visual tokens mirror Known-Frontend/web/src/styles/tokens.css: ink button
 * with paper text (`.btn-primary`), 8px radii, and the wash well for
 * OTP/recovery code blocks.
 */

import { EMAIL_FONT_SANS } from './email-brand.js';

export const EMAIL_INNER_INK = 'rgb(6, 7, 10)';
export const EMAIL_INNER_PAPER = 'rgb(243, 245, 248)';
/** Tinted well behind OTP digits and recovery codes. */
export const EMAIL_INNER_WELL = 'rgb(236, 240, 245)';
/** Faint copy — mirrors the chrome MUTED token. */
const MUTED = 'rgb(97, 99, 103)';

export const EMAIL_FONT_MONO = "ui-monospace, 'Cascadia Code', Consolas, monospace";

/** Inline paragraph style for every inner `<p>` (head styles get stripped). */
export const EMAIL_INNER_P_STYLE =
  `margin:0 0 1em 0;font-family:${EMAIL_FONT_SANS};font-size:16px;line-height:1.6;color:${EMAIL_INNER_INK};`;

function escapeEmailInnerHtml(value: string): string {
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

/** Inner paragraph with the standard inline style. `html` is a trusted fragment. */
export function renderEmailInnerParagraph(html: string): string {
  return `<p style="${EMAIL_INNER_P_STYLE}">${html}</p>`;
}

/** Card heading — 22px semibold ink. `text` is a trusted fragment. */
export function renderEmailHeading(text: string): string {
  return `<h1 style="margin:0 0 12px 0;font-family:${EMAIL_FONT_SANS};font-size:22px;line-height:1.3;font-weight:600;color:${EMAIL_INNER_INK};">${text}</h1>`;
}

/** Inbox preview snippet, hidden in the opened message. `text` is a trusted fragment. */
export function renderEmailPreheader(text: string): string {
  return `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#fff;opacity:0;">${text}</div>`;
}

/** Small muted footer sentence above the tagline. `text` is a trusted fragment. */
export function renderEmailFooterNote(text: string): string {
  return `<p style="margin:16px 0 0 0;font-family:${EMAIL_FONT_SANS};font-size:12px;line-height:1.5;color:${MUTED};">${text}</p>`;
}

/** Solid ink CTA button (paper label, 8px radius) — the `.btn-primary` of email. */
export function renderEmailCtaButton(label: string, href: string): string {
  return `<a href="${escapeEmailInnerHtml(href)}" `
    + `style="display:inline-block;background:${EMAIL_INNER_INK};color:${EMAIL_INNER_PAPER};`
    + `padding:12px 18px;border-radius:8px;font-family:${EMAIL_FONT_SANS};font-size:16px;`
    + `font-weight:600;text-decoration:none;">${escapeEmailInnerHtml(label)}</a>`;
}

/** Centered one-time code on the tinted well (28px mono, wide tracking). */
export function renderOtpBlock(otp: string): string {
  return `<div style="margin:0 0 1em 0;background:${EMAIL_INNER_WELL};border-radius:8px;padding:16px;text-align:center;">`
    + `<span style="font-family:${EMAIL_FONT_MONO};font-size:28px;font-weight:700;letter-spacing:0.2em;color:${EMAIL_INNER_INK};">`
    + `${escapeEmailInnerHtml(otp)}</span></div>`;
}

/** Recovery codes as a styled `<pre>` on the tinted well (13px mono). */
export function renderRecoveryCodes(codes: readonly string[]): string {
  return `<pre style="margin:0 0 1em 0;background:${EMAIL_INNER_WELL};border-radius:8px;padding:16px;`
    + `font-family:${EMAIL_FONT_MONO};font-size:13px;line-height:1.7;color:${EMAIL_INNER_INK};">`
    + `${escapeEmailInnerHtml(codes.join('\n'))}</pre>`;
}
