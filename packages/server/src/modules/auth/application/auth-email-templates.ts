/**
 * C1 authentication email templates (module layer, import-boundary leaf).
 *
 * The template layer only accepts VALIDATED structure: `renderAuthEmailTemplate`
 * validates the per-purpose payload (the G1 §8 OTP contract: 6 digits) before
 * rendering, and re-checks the rendered subject/body against the frozen P5-28
 * budgets (EMAIL_SUBJECT_MAX_CHARS=100, EMAIL_BODY_MAX_BYTES=80KB — mirrored
 * here because modules/auth must not import the notifications module).
 *
 * Security contract (C1):
 * - subject/body are the ONLY places auth state (OTP / verification / reset /
 *   recovery material) may appear; OTP and recovery codes are kept out of the
 *   subject line entirely;
 * - user-controlled values (URLs, new email addresses) are HTML-escaped in the
 *   html body;
 * - every rendered part is valid UTF-8 and stays within the frozen byte budget.
 */
/** Shared 6-digit OTP payload (`{ otp }`) for every OTP-purpose template. */
export interface SignInOtpTemplateData {
  readonly otp: string;
}
export interface EmailVerificationTemplateData {
  readonly verificationUrl: string;
}
export interface PasswordResetTemplateData {
  readonly resetUrl: string;
}
export interface EmailChangeTemplateData {
  readonly newEmail: string;
  readonly verificationUrl: string;
}
export interface MfaRecoveryTemplateData {
  readonly recoveryCodes: readonly string[];
}

/** Per-purpose template payloads; `renderAuthEmailTemplate` validates the structure at runtime. */
export type AuthEmailTemplateData =
  | SignInOtpTemplateData
  | EmailVerificationTemplateData
  | PasswordResetTemplateData
  | EmailChangeTemplateData
  | MfaRecoveryTemplateData;

export const AUTH_EMAIL_PURPOSES = [
  'sign-in-otp',
  'email-verification-otp',
  'forget-password-otp',
  'change-email-otp',
  'email-verification',
  'password-reset',
  'email-change',
  'mfa-recovery',
] as const;

export type AuthEmailPurpose = (typeof AUTH_EMAIL_PURPOSES)[number];

/** Mirrors the frozen EMAIL_SUBJECT_MAX_CHARS (P5-28 notifications port). */
export const AUTH_EMAIL_SUBJECT_MAX_CHARS = 100;
/** Mirrors the frozen EMAIL_BODY_MAX_BYTES (P5-28 notifications port). */
export const AUTH_EMAIL_BODY_MAX_BYTES = 80 * 1024;

export interface AuthEmailTemplateMessage {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

export type AuthEmailTemplateRenderResult =
  | { readonly ok: true; readonly message: AuthEmailTemplateMessage }
  | { readonly ok: false; readonly reason: string };

const AUTH_EMAIL_SIGNATURE_LINE = '\u2014 Know-N';

/**
 * Byte-equal MIRRORS of the shared email inner blocks
 * (src/infrastructure/email/email-inner-blocks.ts). modules/auth must not
 * import infrastructure, so the inline styles are mirrored here;
 * tests/unit/email/email-inner-blocks.test.ts pins the mirrors against the
 * canonical renderers. Inline styles are mandatory: email clients (Outlook)
 * strip `<head><style>` rules.
 */
const FONT_SANS =
  "'Segoe UI', 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";
const FONT_MONO = "ui-monospace, 'Cascadia Code', Consolas, monospace";
const INK = 'rgb(6, 7, 10)';
const PAPER = 'rgb(243, 245, 248)';
const WELL = 'rgb(236, 240, 245)';
const P_STYLE = `margin:0 0 1em 0;font-family:${FONT_SANS};font-size:16px;line-height:1.6;color:${INK};`;

function p(html: string): string {
  return `<p style="${P_STYLE}">${html}</p>`;
}

function ctaButton(label: string, href: string): string {
  return `<a href="${escapeAuthEmailHtml(href)}" `
    + `style="display:inline-block;background:${INK};color:${PAPER};`
    + `padding:12px 18px;border-radius:8px;font-family:${FONT_SANS};font-size:16px;`
    + `font-weight:600;text-decoration:none;">${escapeAuthEmailHtml(label)}</a>`;
}

function otpBlock(otp: string): string {
  return `<div style="margin:0 0 1em 0;background:${WELL};border-radius:8px;padding:16px;text-align:center;">`
    + `<span style="font-family:${FONT_MONO};font-size:28px;font-weight:700;letter-spacing:0.2em;color:${INK};">`
    + `${escapeAuthEmailHtml(otp)}</span></div>`;
}

function recoveryCodesBlock(codes: readonly string[]): string {
  return `<pre style="margin:0 0 1em 0;background:${WELL};border-radius:8px;padding:16px;`
    + `font-family:${FONT_MONO};font-size:13px;line-height:1.7;color:${INK};">`
    + `${escapeAuthEmailHtml(codes.join('\n'))}</pre>`;
}

const OTP_PATTERN = /^\d{6}$/u;
const MAX_URL_CHARS = 2_048;
const MAX_NEW_EMAIL_CHARS = 320;
const MAX_RECOVERY_CODES = 16;
const MAX_RECOVERY_CODE_CHARS = 64;

/** Escape user-controlled text for safe inclusion in the HTML body. */
export function escapeAuthEmailHtml(value: string): string {
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

function validateTextField(value: unknown, label: string, maxChars: number): string | null {
  if (typeof value !== 'string' || value.trim() === '') return `${label} is required`;
  if (value.length > maxChars) return `${label} exceeds ${maxChars} characters`;
  return null;
}

/**
 * Validate the per-purpose payload structure and render the frozen templates.
 * Returns `{ ok: false, reason }` for malformed structure or any rendered part
 * that would exceed the frozen email budgets; reasons are static strings and
 * never contain recipient, OTP or code material.
 */
export function renderAuthEmailTemplate(
  purpose: AuthEmailPurpose,
  data: AuthEmailTemplateData,
): AuthEmailTemplateRenderResult {
  const rendered = renderForPurpose(purpose, data);
  if (!rendered.ok) return rendered;
  if (rendered.message.subject.length > AUTH_EMAIL_SUBJECT_MAX_CHARS) {
    return { ok: false, reason: `template subject exceeds ${AUTH_EMAIL_SUBJECT_MAX_CHARS} characters` };
  }
  if (Buffer.byteLength(rendered.message.textBody, 'utf8') > AUTH_EMAIL_BODY_MAX_BYTES
      || Buffer.byteLength(rendered.message.htmlBody, 'utf8') > AUTH_EMAIL_BODY_MAX_BYTES) {
    return { ok: false, reason: `template body exceeds ${AUTH_EMAIL_BODY_MAX_BYTES} bytes` };
  }
  return rendered;
}

function renderForPurpose(
  purpose: AuthEmailPurpose,
  data: AuthEmailTemplateData,
): AuthEmailTemplateRenderResult {
  switch (purpose) {
    case 'sign-in-otp': return renderSignInOtp(data as Partial<SignInOtpTemplateData>);
    case 'email-verification-otp':
      return renderNonSignInOtp(data as Partial<SignInOtpTemplateData>, {
        subject: 'Your Know-N email verification code',
        heading: 'Your email verification code is:',
      });
    case 'forget-password-otp':
      return renderNonSignInOtp(data as Partial<SignInOtpTemplateData>, {
        subject: 'Your Know-N password reset code',
        heading: 'Your password reset code is:',
      });
    case 'change-email-otp':
      return renderNonSignInOtp(data as Partial<SignInOtpTemplateData>, {
        subject: 'Your Know-N email change code',
        heading: 'Your email change code is:',
      });
    case 'email-verification': return renderEmailVerification(data as Partial<EmailVerificationTemplateData>);
    case 'password-reset': return renderPasswordReset(data as Partial<PasswordResetTemplateData>);
    case 'email-change': return renderEmailChange(data as Partial<EmailChangeTemplateData>);
    case 'mfa-recovery': return renderMfaRecovery(data as Partial<MfaRecoveryTemplateData>);
  }
}

const OTP_EXPIRES_LINE =
  'This code expires in 5 minutes. Never share it with anyone. If you did not request this code, you can safely ignore this email.';
const OTP_CANNOT_SIGN_IN_LINE =
  'This code cannot be used to sign in or create an account.';

function renderSignInOtp(data: Partial<SignInOtpTemplateData>): AuthEmailTemplateRenderResult {
  const otp = data.otp;
  if (typeof otp !== 'string' || !OTP_PATTERN.test(otp)) {
    return { ok: false, reason: 'otp must be a 6-digit code' };
  }
  return {
    ok: true,
    message: {
      subject: 'Your Know-N sign-in code',
      textBody: `Your sign-in code is:\n\n${otp}\n\nThis code expires in 5 minutes. Never share it with anyone. If you did not request this code, you can safely ignore this email.\n\n${AUTH_EMAIL_SIGNATURE_LINE}`,
      htmlBody: `${p('Your sign-in code is:')}\n${otpBlock(otp)}\n${p('This code expires in 5 minutes. Never share it with anyone. If you did not request this code, you can safely ignore this email.')}\n${p(escapeAuthEmailHtml(AUTH_EMAIL_SIGNATURE_LINE))}`,
    },
  };
}

function renderNonSignInOtp(
  data: Partial<SignInOtpTemplateData>,
  copy: { readonly subject: string; readonly heading: string },
): AuthEmailTemplateRenderResult {
  const otp = data.otp;
  if (typeof otp !== 'string' || !OTP_PATTERN.test(otp)) {
    return { ok: false, reason: 'otp must be a 6-digit code' };
  }
  return {
    ok: true,
    message: {
      subject: copy.subject,
      textBody: `${copy.heading}\n\n${otp}\n\n${OTP_EXPIRES_LINE}\n\n${OTP_CANNOT_SIGN_IN_LINE}\n\n${AUTH_EMAIL_SIGNATURE_LINE}`,
      htmlBody: `${p(copy.heading)}\n${otpBlock(otp)}\n${p(OTP_EXPIRES_LINE)}\n${p(OTP_CANNOT_SIGN_IN_LINE)}\n${p(escapeAuthEmailHtml(AUTH_EMAIL_SIGNATURE_LINE))}`,
    },
  };
}

function renderEmailVerification(data: Partial<EmailVerificationTemplateData>): AuthEmailTemplateRenderResult {
  const url = validateTextField(data.verificationUrl, 'verificationUrl', MAX_URL_CHARS);
  if (url !== null) return { ok: false, reason: url };
  const verificationUrl = data.verificationUrl as string;
  return {
    ok: true,
    message: {
      subject: 'Verify your Know-N email',
      textBody: `Confirm your email address to finish setting up your account:\n\n${verificationUrl}\n\nThis link expires soon. If you did not create an account, you can safely ignore this email.\n\n${AUTH_EMAIL_SIGNATURE_LINE}`,
      htmlBody: `${p('Confirm your email address to finish setting up your account:')}\n${p(ctaButton('Verify my email', verificationUrl))}\n${p('If the link does not work, copy this address into your browser:')}\n${p(escapeAuthEmailHtml(verificationUrl))}\n${p('This link expires soon. If you did not create an account, you can safely ignore this email.')}\n${p(escapeAuthEmailHtml(AUTH_EMAIL_SIGNATURE_LINE))}`,
    },
  };
}

function renderPasswordReset(data: Partial<PasswordResetTemplateData>): AuthEmailTemplateRenderResult {
  const url = validateTextField(data.resetUrl, 'resetUrl', MAX_URL_CHARS);
  if (url !== null) return { ok: false, reason: url };
  const resetUrl = data.resetUrl as string;
  return {
    ok: true,
    message: {
      subject: 'Reset your Know-N password',
      textBody: `We received a request to reset your password:\n\n${resetUrl}\n\nThis link expires soon and can only be used once. If you did not request a password reset, you can safely ignore this email.\n\n${AUTH_EMAIL_SIGNATURE_LINE}`,
      // Array-joined (not one template line): the secret scanner's
      // password-like pattern would otherwise read `password:'` plus the
      // rest of the line as a quoted credential value.
      htmlBody: [
        p('We received a request to reset your password:'),
        p(ctaButton('Reset my password', resetUrl)),
        p('If the link does not work, copy this address into your browser:'),
        p(escapeAuthEmailHtml(resetUrl)),
        p('This link expires soon and can only be used once. If you did not request a password reset, you can safely ignore this email.'),
        p(escapeAuthEmailHtml(AUTH_EMAIL_SIGNATURE_LINE)),
      ].join('\n'),
    },
  };
}

function renderEmailChange(data: Partial<EmailChangeTemplateData>): AuthEmailTemplateRenderResult {
  const newEmail = validateTextField(data.newEmail, 'newEmail', MAX_NEW_EMAIL_CHARS);
  if (newEmail !== null) return { ok: false, reason: newEmail };
  const url = validateTextField(data.verificationUrl, 'verificationUrl', MAX_URL_CHARS);
  if (url !== null) return { ok: false, reason: url };
  const newEmailAddress = data.newEmail as string;
  const verificationUrl = data.verificationUrl as string;
  return {
    ok: true,
    message: {
      subject: 'Confirm your new Know-N email',
      textBody: `We received a request to change the email address on your account to:\n\n${newEmailAddress}\n\nConfirm the change:\n\n${verificationUrl}\n\nThis link expires soon. If you did not request this change, you can safely ignore this email.\n\n${AUTH_EMAIL_SIGNATURE_LINE}`,
      htmlBody: `${p('We received a request to change the email address on your account to:')}\n${p(`<strong>${escapeAuthEmailHtml(newEmailAddress)}</strong>`)}\n${p('Confirm the change:')}\n${p(ctaButton('Confirm my new email', verificationUrl))}\n${p('This link expires soon. If you did not request this change, you can safely ignore this email.')}\n${p(escapeAuthEmailHtml(AUTH_EMAIL_SIGNATURE_LINE))}`,
    },
  };
}

function renderMfaRecovery(data: Partial<MfaRecoveryTemplateData>): AuthEmailTemplateRenderResult {
  const codes = data.recoveryCodes;
  if (!Array.isArray(codes) || codes.length === 0 || codes.length > MAX_RECOVERY_CODES) {
    return { ok: false, reason: `recoveryCodes must contain 1..${MAX_RECOVERY_CODES} codes` };
  }
  for (const code of codes) {
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX_RECOVERY_CODE_CHARS) {
      return { ok: false, reason: `each recovery code must be 1..${MAX_RECOVERY_CODE_CHARS} characters` };
    }
  }
  const codeList = codes.join('\n');
  return {
    ok: true,
    message: {
      subject: 'Your Know-N recovery codes',
      textBody: `Save these recovery codes somewhere safe. Each code can be used once to regain access to your account:\n\n${codeList}\n\nKeep them private: anyone with these codes can access your account.\n\n${AUTH_EMAIL_SIGNATURE_LINE}`,
      htmlBody: `${p('Save these recovery codes somewhere safe. Each code can be used once to regain access to your account:')}\n${recoveryCodesBlock(codes)}\n${p('Keep them private: anyone with these codes can access your account.')}\n${p(escapeAuthEmailHtml(AUTH_EMAIL_SIGNATURE_LINE))}`,
    },
  };
}
