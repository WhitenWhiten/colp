/**
 * MAIL-01 selectable message skins.
 *
 * `purpose` = today's inner copy, zero chrome.
 * `unified` = wrap already-rendered subject/text/html in `wrapUnifiedEmailChrome`.
 *
 * Wrap lives only in infrastructure (auth/invite adapters and the notifications
 * postgres worker after `createEmailTemplateRenderers()`). Application modules
 * must not import this file.
 */

import type {
  EmailTemplateContext,
  EmailTemplateMessage,
  EmailTemplateNotificationType,
  EmailTemplateRenderers,
} from '../../modules/email/index.js';
import {
  wrapUnifiedEmailChrome,
  type EmailMailClass,
  type UnifiedChromeMessage,
} from './unified-email-chrome.js';

/** Closed purpose set: C1 auth + SC-04 invite + P5-29 notification types + reserved marketing. */
export const EMAIL_SKIN_PURPOSES = Object.freeze([
  'sign-in-otp',
  'email-verification-otp',
  'forget-password-otp',
  'change-email-otp',
  'email-verification',
  'password-reset',
  'email-change',
  'mfa-recovery',
  'collaboration-invite',
  'follow_activity',
  'collection_change',
  'marketing-notice',
] as const);

export type EmailSkinPurpose = (typeof EMAIL_SKIN_PURPOSES)[number];

export type EmailSkin = 'purpose' | 'unified';

export type EmailSkinMap = { readonly [K in EmailSkinPurpose]: EmailSkin };

export interface EmailSkinMessage {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

export type WrapEmailMessageResult =
  | { readonly ok: true; readonly message: EmailSkinMessage }
  | { readonly ok: false; readonly reason: string };

/** Mirrors frozen EMAIL_SUBJECT_MAX_CHARS (P5-28 / C1). Do not import notifications from auth. */
export const EMAIL_SKIN_SUBJECT_MAX_CHARS = 100;
/** Mirrors frozen EMAIL_BODY_MAX_BYTES (P5-28 / C1). */
export const EMAIL_SKIN_BODY_MAX_BYTES = 80 * 1024;

const EMAIL_SKIN_ENV_PREFIX = 'EMAIL_SKIN_';
const EMAIL_SKIN_DEFAULT_KEY = 'EMAIL_SKIN_DEFAULT';
const LEGAL_SKINS: ReadonlySet<string> = new Set<EmailSkin>(['purpose', 'unified']);

const PURPOSE_BY_ENV_SUFFIX: ReadonlyMap<string, EmailSkinPurpose> = new Map(
  EMAIL_SKIN_PURPOSES.map((purpose) => [purposeEnvSuffix(purpose), purpose]),
);

function purposeEnvSuffix(purpose: EmailSkinPurpose): string {
  return purpose.replaceAll('-', '_').toUpperCase();
}

function isEmailSkin(value: string): value is EmailSkin {
  return LEGAL_SKINS.has(value);
}

export function mailClassForPurpose(purpose: EmailSkinPurpose): EmailMailClass {
  return purpose === 'marketing-notice' ? 'marketing' : 'transactional';
}

export function defaultEmailSkinMap(): EmailSkinMap {
  return DEFAULT_EMAIL_SKIN_MAP;
}

/**
 * Parse `EMAIL_SKIN_*` from the **passed** env dict. Does not scan `process.env`.
 *
 * `EMAIL_SKIN_DEFAULT` is a special key (never an unknown purpose).
 * Missing → `unified` (R7-31): a deployment that forgets the env var must
 * still send branded mail; `purpose` stays available as an explicit opt-out.
 * Other `EMAIL_SKIN_*` suffixes must match a closed purpose (hyphens → underscores).
 * Unknown suffix or illegal value refuses startup.
 */
export function parseEmailSkinConfig(env: Record<string, string | undefined>): EmailSkinMap {
  let defaultSkin: EmailSkin = 'unified';
  const defaultRaw = env[EMAIL_SKIN_DEFAULT_KEY];
  if (defaultRaw !== undefined) {
    const trimmed = defaultRaw.trim();
    if (!isEmailSkin(trimmed)) {
      throw new Error('EMAIL_SKIN_DEFAULT must be purpose or unified');
    }
    defaultSkin = trimmed;
  }

  const overrides = new Map<EmailSkinPurpose, EmailSkin>();
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(EMAIL_SKIN_ENV_PREFIX) || key === EMAIL_SKIN_DEFAULT_KEY) continue;
    const suffix = key.slice(EMAIL_SKIN_ENV_PREFIX.length);
    const purpose = PURPOSE_BY_ENV_SUFFIX.get(suffix);
    if (purpose === undefined) {
      throw new Error(`${key} is not a known email skin purpose`);
    }
    const trimmed = (raw ?? '').trim();
    if (!isEmailSkin(trimmed)) {
      throw new Error(`${key} must be purpose or unified`);
    }
    overrides.set(purpose, trimmed);
  }

  const map = {} as { [K in EmailSkinPurpose]: EmailSkin };
  for (const purpose of EMAIL_SKIN_PURPOSES) {
    map[purpose] = overrides.get(purpose) ?? defaultSkin;
  }
  return Object.freeze(map);
}

const DEFAULT_EMAIL_SKIN_MAP: EmailSkinMap = parseEmailSkinConfig({});

function checkEmailSkinBudget(message: EmailSkinMessage): WrapEmailMessageResult {
  if (message.subject.length > EMAIL_SKIN_SUBJECT_MAX_CHARS) {
    return { ok: false, reason: `wrapped email subject exceeds ${EMAIL_SKIN_SUBJECT_MAX_CHARS} characters` };
  }
  if (Buffer.byteLength(message.textBody, 'utf8') > EMAIL_SKIN_BODY_MAX_BYTES
      || Buffer.byteLength(message.htmlBody, 'utf8') > EMAIL_SKIN_BODY_MAX_BYTES) {
    return { ok: false, reason: `wrapped email body exceeds ${EMAIL_SKIN_BODY_MAX_BYTES} bytes` };
  }
  return { ok: true, message };
}

/**
 * Apply the selected skin to an already-rendered inner message, then re-check
 * the frozen 100-character / 80 KiB budgets. Never truncates OTP or body copy.
 */
export function wrapEmailMessage(input: {
  readonly purpose: EmailSkinPurpose;
  readonly skin: EmailSkin;
  readonly mailClass: EmailMailClass;
  readonly message: EmailSkinMessage;
  /** Optional inbox preview snippet + footer reason, forwarded to the unified chrome. */
  readonly preheader?: string;
  readonly footerNote?: string;
}): WrapEmailMessageResult {
  const expectedClass = mailClassForPurpose(input.purpose);
  if (input.mailClass !== expectedClass) {
    return { ok: false, reason: 'email skin mailClass does not match purpose' };
  }
  const wrapped: UnifiedChromeMessage = input.skin === 'unified'
    ? wrapUnifiedEmailChrome({
      mailClass: input.mailClass,
      message: input.message,
      ...(input.preheader !== undefined ? { preheader: input.preheader } : {}),
      ...(input.footerNote !== undefined ? { footerNote: input.footerNote } : {}),
    })
    : input.message;
  const budget = checkEmailSkinBudget(wrapped);
  if (!budget.ok) return budget;
  return { ok: true, message: Object.freeze({ ...budget.message }) };
}

/**
 * Postgres worker helper: run the inner renderer, then wrap for that
 * notification type. Over-budget throws a static TypeError so the existing
 * loop failure mapper classifies the claim without sending.
 */
export function wrapEmailTemplateRenderers(
  inner: EmailTemplateRenderers,
  skins: EmailSkinMap = DEFAULT_EMAIL_SKIN_MAP,
): EmailTemplateRenderers {
  return Object.freeze({
    render(
      notificationType: EmailTemplateNotificationType,
      context: EmailTemplateContext,
    ): EmailTemplateMessage {
      const rendered = inner.render(notificationType, context);
      const skin = skins[notificationType];
      const wrapInput: EmailSkinMessage = {
        subject: rendered.subject,
        textBody: rendered.textBody ?? '',
        htmlBody: rendered.htmlBody ?? '',
      };
      const wrapped = wrapEmailMessage({
        purpose: notificationType,
        skin,
        mailClass: 'transactional',
        message: wrapInput,
      });
      if (!wrapped.ok) {
        throw new TypeError(wrapped.reason);
      }
      if (skin === 'purpose') return rendered;
      return Object.freeze({
        subject: wrapped.message.subject,
        textBody: wrapped.message.textBody,
        htmlBody: wrapped.message.htmlBody,
      });
    },
  });
}
