/**
 * Reserved `marketing-notice` renderer (MAIL-01).
 *
 * Pure function: no fetch, no worker, no table, no Product path.
 * Input is closed `{ heading, bodyText, ctaUrl? }` — never a recipient address.
 */

import {
  renderEmailCtaButton,
  renderEmailHeading,
  renderEmailInnerParagraph,
} from './email-inner-blocks.js';
import {
  wrapEmailMessage,
  type EmailSkin,
  type EmailSkinMessage,
  type WrapEmailMessageResult,
} from './message-skins.js';

export interface MarketingNoticeInput {
  readonly heading: string;
  readonly bodyText: string;
  readonly ctaUrl?: string;
  /** CTA button label (never the URL); defaults to 'Open Know-N'. */
  readonly ctaLabel?: string;
}

const MAX_HEADING_CHARS = 100;
const MAX_BODY_CHARS = 8_192;
const MAX_CTA_URL_CHARS = 2_048;
const MAX_CTA_LABEL_CHARS = 60;

function escapeHtml(value: string): string {
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

function validateText(value: unknown, label: string, maxChars: number): string | null {
  if (typeof value !== 'string' || value.trim() === '') return `${label} is required`;
  if (value.length > maxChars) return `${label} exceeds ${maxChars} characters`;
  return null;
}

function renderInner(input: MarketingNoticeInput): WrapEmailMessageResult {
  const headingError = validateText(input.heading, 'heading', MAX_HEADING_CHARS);
  if (headingError !== null) return { ok: false, reason: headingError };
  const bodyError = validateText(input.bodyText, 'bodyText', MAX_BODY_CHARS);
  if (bodyError !== null) return { ok: false, reason: bodyError };

  const ctaUrl = input.ctaUrl;
  let cta: string | undefined;
  if (ctaUrl !== undefined) {
    const ctaError = validateText(ctaUrl, 'ctaUrl', MAX_CTA_URL_CHARS);
    if (ctaError !== null) return { ok: false, reason: ctaError };
    cta = ctaUrl;
  }
  const ctaLabel = input.ctaLabel ?? 'Open Know-N';
  if (cta !== undefined) {
    const labelError = validateText(ctaLabel, 'ctaLabel', MAX_CTA_LABEL_CHARS);
    if (labelError !== null) return { ok: false, reason: labelError };
  }

  const heading = input.heading;
  const bodyText = input.bodyText;
  const textLines = [heading, '', bodyText];
  const htmlParts = [
    renderEmailHeading(escapeHtml(heading)),
    renderEmailInnerParagraph(escapeHtml(bodyText)),
  ];
  if (cta !== undefined) {
    textLines.push('', cta);
    // The URL is never the link text — the CTA is a labeled ink button.
    htmlParts.push(renderEmailInnerParagraph(renderEmailCtaButton(ctaLabel, cta)));
  }
  const message: EmailSkinMessage = Object.freeze({
    subject: heading,
    textBody: textLines.join('\n'),
    htmlBody: htmlParts.join('\n'),
  });
  return { ok: true, message };
}

/** Render inner copy then wrap with the configured skin. */
export function renderMarketingNotice(
  input: MarketingNoticeInput,
  skin: EmailSkin = 'purpose',
): WrapEmailMessageResult {
  const inner = renderInner(input);
  if (!inner.ok) return inner;
  return wrapEmailMessage({
    purpose: 'marketing-notice',
    skin,
    mailClass: 'marketing',
    message: inner.message,
  });
}
