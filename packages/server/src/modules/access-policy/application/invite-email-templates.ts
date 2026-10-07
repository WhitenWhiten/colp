/**
 * SC-04 collection invite email templates (access-policy module leaf).
 *
 * Budgets mirror the frozen P5-28 / C1 numbers (100 chars / 80 KiB) without
 * importing notifications or auth constants. Known and unknown invitees share
 * this single renderer. Subject/body never include recipient email, inviteId,
 * collectionId, subjectId, or account-existence forks.
 */
import { assertSafeRelativeReturnTo } from '../../identity/index.js';

/** Mirrors EMAIL_SUBJECT_MAX_CHARS (P5-28). Do not import notifications. */
export const INVITE_EMAIL_SUBJECT_MAX_CHARS = 100;
/** Mirrors EMAIL_BODY_MAX_BYTES (P5-28). Do not import notifications. */
export const INVITE_EMAIL_BODY_MAX_BYTES = 80 * 1024;
export const INVITE_EMAIL_TITLE_MAX_GRAPHEMES = 80;
export const INVITE_EMAIL_SUBJECT = "You've been invited to collaborate on Know-N";
export const INVITE_EMAIL_RETURN_TO = '/library';
const INVITE_EMAIL_SIGNATURE_LINE = '\u2014 Know-N';

/**
 * Byte-equal MIRRORS of the shared email inner blocks
 * (src/infrastructure/email/email-inner-blocks.ts). modules/access-policy
 * must not import infrastructure, so the inline styles are mirrored here;
 * tests/unit/email/email-inner-blocks.test.ts pins the mirrors against the
 * canonical renderers. Inline styles are mandatory: email clients (Outlook)
 * strip `<head><style>` rules.
 */
const FONT_SANS =
  "'Segoe UI', 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";
const INK = 'rgb(6, 7, 10)';
const PAPER = 'rgb(243, 245, 248)';
const P_STYLE = `margin:0 0 1em 0;font-family:${FONT_SANS};font-size:16px;line-height:1.6;color:${INK};`;

function p(html: string): string {
  return `<p style="${P_STYLE}">${html}</p>`;
}

function ctaButton(label: string, href: string): string {
  return `<a href="${escapeInviteEmailHtml(href)}" `
    + `style="display:inline-block;background:${INK};color:${PAPER};`
    + `padding:12px 18px;border-radius:8px;font-family:${FONT_SANS};font-size:16px;`
    + `font-weight:600;text-decoration:none;">${escapeInviteEmailHtml(label)}</a>`;
}

const MAX_URL_CHARS = 2_048;
const MAX_NAME_CHARS = 240;
const MAX_TITLE_CHARS = 8_192;
const MAX_DATE_CHARS = 32;

export interface InviteEmailTemplateInput {
  readonly inviterDisplayName: string;
  readonly collectionTitle: string;
  readonly role: 'editor' | 'viewer';
  readonly expiresAtUtcDate: string;
  readonly loginUrl: string;
}

export type InviteEmailTemplateRenderResult =
  | {
      readonly ok: true;
      readonly subject: string;
      readonly textBody: string;
      readonly htmlBody: string;
    }
  | { readonly ok: false; readonly reason: string };

export function escapeInviteEmailHtml(value: string): string {
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

export function truncateInviteTitleGraphemes(title: string, max = INVITE_EMAIL_TITLE_MAX_GRAPHEMES): string {
  if (typeof title !== 'string' || title.length === 0) return '';
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  let count = 0;
  let result = '';
  for (const { segment } of segmenter.segment(title)) {
    if (count >= max) break;
    result += segment;
    count += 1;
  }
  return result;
}

export function buildInviteLoginUrl(productOrigin: string): string {
  const returnTo = assertSafeRelativeReturnTo(INVITE_EMAIL_RETURN_TO);
  if (typeof productOrigin !== 'string' || productOrigin.trim() === '') {
    throw new Error('product origin is required');
  }
  const origin = new URL(productOrigin).origin;
  return `${origin}/login?returnTo=${returnTo}`;
}

export function renderInviteEmailTemplate(
  input: InviteEmailTemplateInput,
): InviteEmailTemplateRenderResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'invite email template input is required' };
  }
  if (input.role !== 'editor' && input.role !== 'viewer') {
    return { ok: false, reason: 'invite email role is invalid' };
  }
  const nameError = validateText(input.inviterDisplayName, 'inviterDisplayName', MAX_NAME_CHARS);
  if (nameError !== null) return { ok: false, reason: nameError };
  const titleError = validateText(input.collectionTitle, 'collectionTitle', MAX_TITLE_CHARS, true);
  if (titleError !== null) return { ok: false, reason: titleError };
  const dateError = validateText(input.expiresAtUtcDate, 'expiresAtUtcDate', MAX_DATE_CHARS);
  if (dateError !== null) return { ok: false, reason: dateError };
  const urlError = validateText(input.loginUrl, 'loginUrl', MAX_URL_CHARS);
  if (urlError !== null) return { ok: false, reason: urlError };

  const roleLabel = input.role === 'editor' ? 'Editor' : 'Viewer';
  const title = truncateInviteTitleGraphemes(input.collectionTitle);
  const name = input.inviterDisplayName;
  const subject = INVITE_EMAIL_SUBJECT;
  const textBody = [
    `${name} invited you to collaborate on \u201C${title}\u201D as ${roleLabel}.`,
    '',
    `This invitation expires on ${input.expiresAtUtcDate}.`,
    '',
    'Sign in to view it:',
    input.loginUrl,
    '',
    INVITE_EMAIL_SIGNATURE_LINE,
  ].join('\n');
  const htmlBody = [
    p(`${escapeInviteEmailHtml(name)} invited you to collaborate on \u201C${escapeInviteEmailHtml(title)}\u201D as ${roleLabel}.`),
    p(`This invitation expires on ${escapeInviteEmailHtml(input.expiresAtUtcDate)}.`),
    p(ctaButton('Sign in to view it', input.loginUrl)),
    p('If the link does not work, copy this address into your browser:'),
    p(escapeInviteEmailHtml(input.loginUrl)),
    p(escapeInviteEmailHtml(INVITE_EMAIL_SIGNATURE_LINE)),
  ].join('\n');

  if (subject.length > INVITE_EMAIL_SUBJECT_MAX_CHARS) {
    return { ok: false, reason: `template subject exceeds ${INVITE_EMAIL_SUBJECT_MAX_CHARS} characters` };
  }
  if (Buffer.byteLength(textBody, 'utf8') > INVITE_EMAIL_BODY_MAX_BYTES
      || Buffer.byteLength(htmlBody, 'utf8') > INVITE_EMAIL_BODY_MAX_BYTES) {
    return { ok: false, reason: `template body exceeds ${INVITE_EMAIL_BODY_MAX_BYTES} bytes` };
  }
  if (containsForbiddenMaterial(subject) || containsForbiddenMaterial(textBody)
      || containsForbiddenMaterial(htmlBody)) {
    return { ok: false, reason: 'template rejected forbidden material' };
  }
  return { ok: true, subject, textBody, htmlBody };
}

function validateText(
  value: unknown,
  label: string,
  maxChars: number,
  allowEmpty = false,
): string | null {
  if (typeof value !== 'string') return `${label} is required`;
  if (!allowEmpty && value.trim() === '') return `${label} is required`;
  if (value.length > maxChars) return `${label} exceeds ${maxChars} characters`;
  return null;
}

function containsForbiddenMaterial(value: string): boolean {
  return /You already have an account/u.test(value)
    || /Create an account/u.test(value);
}
