/**
 * C1 authentication email port (application layer).
 *
 * The ONLY surface through which the Better Auth email flows (C2) may request
 * an authentication email. Implementations live in infrastructure
 * (infrastructure/email/auth-email-adapter.ts) and reuse the frozen DirectMail
 * bounded timeout / redaction / classification / stable tag / idempotency-key
 * machinery WITHOUT touching the notification delivery ledger: auth emails
 * never enter the notification business tables.
 *
 * Frozen semantics (plan §9 Task C1):
 * - `sendAuthEmail({ purpose, to, templateData, idempotencyKey, signal })`:
 *   the template layer (auth-email-templates.ts) accepts only VALIDATED
 *   per-purpose structure and renders subject/body inside the frozen budgets;
 * - result: unified `queued` or `email_delivery_unavailable` (never the
 *   notification taxonomy) — a failure never claims the mail was sent;
 * - idempotencyKey is the stable provider key (reused verbatim on retries as
 *   the DirectMail TagName);
 * - logs record ONLY purpose, redacted provider classification and the
 *   correlation id — recipient addresses, OTP/codes, subjects and bodies never
 *   reach logs or error text;
 * - the sender never creates Notifications, delivery rows, suppression facts
 *   or resource grants of any kind (side-effect-free surface).
 */
import type { AuthEmailPurpose, AuthEmailTemplateData } from './auth-email-templates.js';

/** Mirrors the frozen EMAIL_IDEMPOTENCY_KEY_MAX_CHARS (P5-28 notifications port). */
export const AUTH_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS = 128;

export interface SendAuthEmailInput {
  /** Selects the frozen template AND its validated payload structure. */
  readonly purpose: AuthEmailPurpose;
  /** Single recipient address; required (empty/whitespace is rejected before provider contact). */
  readonly to: string;
  /** Per-purpose validated structure; rejected before provider contact when malformed. */
  readonly templateData: AuthEmailTemplateData;
  /**
   * Stable provider key (1..AUTH_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS chars),
   * reused verbatim as the DirectMail TagName on retries.
   */
  readonly idempotencyKey: string;
  /** Optional caller cancellation; aborts the provider call (reported unavailable). */
  readonly signal?: AbortSignal;
}

/**
 * Unified delivery result. `queued` means the provider accepted the message;
 * EVERY failure (validation, provider rejection, timeout/abort, provider
 * unavailable, not configured) collapses to `email_delivery_unavailable` with
 * a redacted, log-safe reason (never recipient/OTP/subject material).
 */
export type AuthEmailDeliveryResult =
  | { readonly outcome: 'queued'; readonly correlationId: string; readonly providerMessageId: string | null }
  | { readonly outcome: 'email_delivery_unavailable'; readonly correlationId: string; readonly redactedReason: string };

export interface AuthEmailSender {
  sendAuthEmail(input: SendAuthEmailInput): Promise<AuthEmailDeliveryResult>;
}
