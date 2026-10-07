/**
 * SC-04 collection invite email port (application layer).
 *
 * The ONLY surface through which the invite worker may request a transactional
 * collaboration email. Implementations live in infrastructure/email and reuse
 * DirectMail without touching the notification delivery ledger.
 *
 * Result is the C1 dichotomy: `queued` or `email_delivery_unavailable`.
 * Notifications taxonomy never leaks into access-policy.
 */
import type { InviteEmailTemplateRenderResult } from './invite-email-templates.js';

/** Mirrors EMAIL_IDEMPOTENCY_KEY_MAX_CHARS (P5-28). Do not import notifications. */
export const INVITE_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS = 128;

export interface InviteEmailMessage {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

export interface SendInviteEmailInput {
  readonly to: string;
  readonly message: InviteEmailMessage;
  /**
   * Stable provider key (1..INVITE_EMAIL_IDEMPOTENCY_KEY_MAX_CHARS chars).
   * DirectMail TagName = delivery_id, reused verbatim on retries.
   */
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export type InviteEmailDeliveryResult =
  | { readonly outcome: 'queued'; readonly correlationId: string; readonly providerMessageId: string | null }
  | { readonly outcome: 'email_delivery_unavailable'; readonly correlationId: string; readonly redactedReason: string };

export interface InviteEmailSender {
  sendInviteEmail(input: SendInviteEmailInput): Promise<InviteEmailDeliveryResult>;
}

export type InviteEmailRenderedMessage = Extract<InviteEmailTemplateRenderResult, { ok: true }>;
