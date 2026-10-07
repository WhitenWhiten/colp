/**
 * P5-28 email provider adapter contract (application-layer port).
 *
 * This port is the ONLY surface through which the notification delivery worker
 * may reach a mail provider. Implementations live in infrastructure (the
 * narrow Aliyun DirectMail adapter) and must never leak third-party SDK types
 * or provider protocol types into this module: the port declares its own
 * classification/outcome unions that mirror the frozen Phase 5 taxonomy
 * (docs/11-phase5-email-delivery-gate.md §9 and the
 * notification_deliveries.last_error_category CHECK values).
 *
 * Frozen semantics (see docs/11-phase5-email-delivery-gate.md):
 * - App-side exactly-once is enforced by the unique `(notification_id, channel)`
 *   delivery row BEFORE any provider call; the provider has no
 *   native idempotency key (D9). The adapter itself is therefore stateless
 *   with respect to dedupe: every `send()` call is a fresh attempt and a
 *   retried attempt of the same delivery REUSES the same stable
 *   `idempotencyKey` (reused as DirectMail TagName) so the delivery stays
 *   queryable/reconcilable. Duplicate app-level intents are rejected by the
 *   delivery row, never by the provider adapter.
 * - Stable provider key: `idempotencyKey` is the delivery_id (<=128 chars)
 *   and is sent as TagName (bounded to the configured TagName budget).
 * - Classification: success / retryable / permanent / unknown, mapped onto
 *   the existing `notification_deliveries.last_error_category` CHECK values
 *   (unknown_future_version, invalid_contract, retry_exhausted, dependency,
 *   provider_unavailable, other).
 * - Malformed responses never throw raw provider text: a 2xx SingleSendMail
 *   body that is not JSON or lacks EnvId+RequestId is classified permanent /
 *   invalid_contract (frozen parseSingleSendMailSuccessBody; the delivery may
 *   have occurred, so recovery MUST use `lookup()` /
 *   SenderStatisticsDetailByParam reconciliation as the authority and never
 *   blindly resend). A 2xx lookup body that is not the documented
 *   `data.mailDetail` shape is classified unknown / other (no delivery fact
 *   can be derived). Transport failures, timeouts and aborts (including
 *   client shutdown) are retryable / provider_unavailable.
 * - Lookup (SenderStatisticsDetailByParam) honors the official at-most-ONE-of
 *   (AccountName | TagName | ToAddress) rule and uses TagName only. Status
 *   0 -> delivered, 2 -> bounced, 3 -> complaint, 4 -> failed, and unknown /
 *   missing rows (statistics may lag after send) -> outcome `unknown` with
 *   classification `unknown` and a null error category (not an error).
 * - Callback verification returns ONLY stable delivery facts
 *   (kind/providerMessageId/recipient/occurredAt/tag). It never creates
 *   Notifications, deliveries, or resource grants of any kind; side effects
 *   belong exclusively to the P5-29 worker. Two documented verification
 *   modes:
 *   (a) EventBridge/controlled-sink HMAC envelope (frozen MVP callback
 *       contract — official EventBridge HTTP targets document no payload
 *       signature): `X-Known-DM-Signature = HMAC-SHA256(sharedSecret,
 *       canonicalBody + "\n" + X-Known-DM-Timestamp + "\n" +
 *       X-Known-DM-Nonce)` with a bounded timestamp replay window,
 *       constant-time comparison, and rejection of missing/invalid/expired
 *       envelopes. Production deployments must configure the EventBridge HTTP
 *       target to add these headers; SenderStatisticsDetailByParam
 *       reconciliation remains the delivery authority. When the HMAC secret
 *       is configured, this envelope is the only admitted callback door.
 *   (b) legacy MNS HTTP push is admitted only when the HMAC secret is unset:
 *       RSA-SHA1 over the official string-to-sign with a 15-minute Date
 *       replay window and an EXACT Aliyun-only signing-certificate URL
 *       allowlist (whitelisted hosts plus the single documented
 *       `x509_public_certificate.pem` path). The regional SMQ certificate is
 *       not a deployment secret, so MNS cannot substitute for HMAC.
 */

/** Frozen code-owned template budgets (D7); mirrors the DirectMail contract module. */
export const EMAIL_SUBJECT_MAX_CHARS = 100;
export const EMAIL_BODY_MAX_BYTES = 80 * 1024;
/** Stable provider key budget: delivery_id reused as TagName (D9). */
export const EMAIL_IDEMPOTENCY_KEY_MAX_CHARS = 128;

export type EmailDeliveryClassification = 'success' | 'retryable' | 'permanent' | 'unknown';

export type EmailDeliveryErrorCategory =
  | 'unknown_future_version'
  | 'invalid_contract'
  | 'retry_exhausted'
  | 'dependency'
  | 'provider_unavailable'
  | 'other';

/**
 * Stable delivery facts derivable from SenderStatisticsDetailByParam Status +
 * ErrorClassification. `conflicting_facts` is the order-independent
 * aggregation result (FIX-M-025) when provider rows contain BOTH a delivered
 * fact and a bounce/complaint/failed fact whose relative event order cannot be
 * proven: the consumer must take NO irreversible action (no suppression, no
 * delivered completion) and dead-letter for manual review.
 */
export type EmailDeliveryOutcome =
  | 'delivered' | 'bounced' | 'complaint' | 'failed' | 'conflicting_facts' | 'unknown';

/** Stable callback fact kinds; the only values a verified callback may produce. */
export type EmailCallbackKind =
  | 'delivered' | 'bounced' | 'complaint' | 'unsubscribed'
  | 'subscribed' | 'open' | 'click';

export interface EmailMessage {
  /** Single recipient (MVP sends exactly one address). */
  readonly to: string;
  /** <= EMAIL_SUBJECT_MAX_CHARS characters. */
  readonly subject: string;
  /** <= EMAIL_BODY_MAX_BYTES bytes; at least one of textBody/htmlBody is required. */
  readonly textBody?: string;
  /** <= EMAIL_BODY_MAX_BYTES bytes; at least one of textBody/htmlBody is required. */
  readonly htmlBody?: string;
}

export interface EmailSendInput {
  /** Stable delivery_id (<= EMAIL_IDEMPOTENCY_KEY_MAX_CHARS chars), reused as TagName. */
  readonly idempotencyKey: string;
  readonly message: EmailMessage;
  /** Optional caller cancellation; aborts the provider call (classified retryable). */
  readonly signal?: AbortSignal;
}

export interface EmailSendResult {
  readonly classification: EmailDeliveryClassification;
  /** DirectMail EnvId when the send was accepted. */
  readonly providerMessageId: string | null;
  readonly requestId: string | null;
  readonly errorCategory: EmailDeliveryErrorCategory | null;
  /** Redacted, log-safe failure detail; never contains credentials, recipients or bodies. */
  readonly redactedError?: string;
}

export interface EmailLookupInput {
  /** Same stable delivery_id used at send time. */
  readonly idempotencyKey: string;
}

export interface EmailLookupResult {
  /** Success = a definitive delivery fact was derived; unknown = no fact yet; else provider failure. */
  readonly classification: EmailDeliveryClassification;
  /**
   * Aggregated across ALL mailDetail rows for the stable TagName
   * (order-independent; pagination followed up to a bounded page cap): any
   * provably-newer delivered fact blocks suppression from older failures, and
   * conflicting facts with no provable order yield `conflicting_facts`.
   */
  readonly outcome: EmailDeliveryOutcome;
  /**
   * Provider event time (epoch ms) of the definitive fact (the winning
   * mailDetail row's UtcLastUpdateTime/LastUpdateTime) when the outcome is
   * winner-based and the row carried a reliable time; null when the winning
   * row carried none; absent for non-winner outcomes (unknown/conflicting/
   * errors). FIX-L-062: the consumer records THIS time on the durable
   * suppression fact instead of the local reconcile clock, so an out-of-order
   * old fact can never masquerade as newer than a verified callback fact.
   */
  readonly eventTimeMs?: number | null;
  readonly requestId: string | null;
  readonly errorCategory: EmailDeliveryErrorCategory | null;
  /** Provider ErrorClassification enumeration when a detail row matched (e.g. SendOk, SmtpNxBox). */
  readonly errorClassification?: string | null;
  readonly redactedError?: string;
}

export interface EmailCallbackFact {
  readonly kind: EmailCallbackKind;
  /** env_id (EnvId, the delivery evidence) preferred, else msg_id. */
  readonly providerMessageId?: string;
  readonly recipient?: string;
  readonly occurredAt?: string;
  readonly tag?: string;
}

export type EmailCallbackRejectionReason =
  | 'not_configured'
  | 'missing_signature_headers'
  | 'invalid_certificate_url'
  | 'expired_timestamp'
  | 'signature_mismatch'
  | 'missing_content_md5'
  | 'malformed_callback_body'
  | 'unknown_event_type';

export class EmailCallbackRejectedError extends Error {
  readonly reason: EmailCallbackRejectionReason;

  constructor(reason: EmailCallbackRejectionReason, message?: string) {
    super(message ?? reason);
    this.name = 'EmailCallbackRejectedError';
    this.reason = reason;
  }
}

export interface EmailCallbackVerificationInput {
  /** HTTP method (default POST). */
  readonly method?: string;
  /** Full request URL used to derive the MNS CanonicalizedResource. */
  readonly url?: string;
  /** Raw request headers (case-insensitive names, first value wins). */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Raw request body (canonicalBody for the HMAC envelope; MNS key=value body). */
  readonly body: string;
  /** Verification clock (defaults to Date.now()); test seam for replay windows. */
  readonly now?: Date;
}

export interface EmailDeliverySender {
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

export interface EmailDeliveryLookup {
  lookup(input: EmailLookupInput): Promise<EmailLookupResult>;
}

export interface EmailCallbackVerifier {
  /**
   * Verifies a delivery-result callback and returns ONLY stable delivery
   * facts. Rejects (EmailCallbackRejectedError) on missing/invalid/expired
   * signatures, unknown event types, or malformed bodies. Never creates
   * Notifications or resource authorization.
   */
  verifyCallback(input: EmailCallbackVerificationInput): Promise<EmailCallbackFact>;
}

export interface EmailDeliveryClient {
  /** Graceful shutdown: aborts in-flight provider requests and frees sockets. */
  close(): Promise<void>;
}

export interface EmailProviderAdapter
  extends EmailDeliverySender, EmailDeliveryLookup, EmailCallbackVerifier, EmailDeliveryClient {}