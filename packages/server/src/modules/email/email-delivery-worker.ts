/**
 * P5-29 email delivery worker (application capability).
 *
 * Consumes the P5-17 channel intent (`notification_deliveries` rows with
 * `channel='email'`) through a claim/process/reconcile contract with explicit
 * lease fencing, then performs suppression recheck, code-owned template
 * rendering, a stable provider key send through the P5-28 adapter port, bounded
 * retry/dead-letter, and durable callback reconciliation.
 *
 * Frozen semantics (see docs/11-phase5-email-delivery-gate.md):
 * - Notification authority commits first (P5-17); this worker NEVER re-opens
 *   the Notification transaction. The claim and the final transition are their
 *   own transactions; the provider send happens OUTSIDE any authority
 *   transaction.
 * - Claim: `pending|retryable` with `next_attempt_at <= now`, or an EXPIRED
 *   `leased` row (`leased_until <= now`) is taken over. A fresh lease can never
 *   be stolen (the UPDATE re-checks the same predicate).
 * - Final transition CAS: `state='leased' AND leased_until > current_timestamp
 *   AND attempt_count = <claimed>` so an old lease owner can never overwrite a
 *   newer attempt or suppression state. A failed CAS is reported `lease_lost`
 *   and the newer owner decides.
 * - Suppression recheck happens BEFORE every send (preferences + account
 *   activity + durable suppression facts), and is re-run immediately before
 *   the provider call: a preference-disable / account-inactive / durable-fact
 *   change observed at ANY point before the provider accepts the message
 *   suppresses with ZERO provider sends (mid-race guarantee). Once the
 *   provider has accepted the send the delivery legitimately completes
 *   delivered - the email is already in flight and cannot be un-sent.
 *   Preference-disable and account-inactive races suppress the delivery
 *   WITHOUT recording a durable suppression fact (the preference/account
 *   tables are the durable authority).
 *   Bounce/complaint/unsubscribe facts (callback or lookup) DO record a durable
 *   recipient-level suppression fact in `notification_email_suppressions`.
 * - Stable provider key = `delivery_id` reused as the adapter idempotency key /
 *   DirectMail TagName (frozen D9); retried attempts reuse the same key.
 * - Unknown outcome handling: a send classified `unknown` (defensive; the
 *   P5-28 adapter never emits it for send today) is retryable with category
 *   `other` (frozen D11 unknown taxonomy). Retried attempts (attempt > 1) look
 *   up first via SenderStatisticsDetailByParam: the adapter aggregates ALL
 *   provider rows order-independently (FIX-M-025) - a definitive delivered
 *   fact finalizes WITHOUT re-sending; a definitive bounce/complaint/failed
 *   fact suppresses; conflicting facts with no provable event order dead-letter
 *   for manual review (never suppress, never complete, never re-send). Unknown
 *   lookup (statistics lag) proceeds to send. A lookup API ERROR is NEVER
 *   equivalent to "no delivery facts" (FIX-L-058): a failed statistics call
 *   proves nothing about the previous attempt, so it never re-sends - retryable
 *   provider failures back off with the adapter category (dead_letter
 *   retry_exhausted at max attempts), permanent invalid-contract dead-letters
 *   for operator review, and malformed/truncated responses (unknown WITH an
 *   error category) back off as `other` (frozen D11 unknown taxonomy). Only the
 *   documented benign unknown - a successful response with no facts and no
 *   error (errorCategory null, statistics lag) - proceeds to send.
 * - Delivered-callback authority: a VERIFIED delivered callback that matches a
 *   dead-lettered row re-arms it (dead_letter -> retryable) while persisting the
 *   callback's provider message id on the row as the delivered-confirmed marker,
 *   and one that matches a retryable row (a provider send/processing attempt is
 *   already recorded) finalizes it delivered directly with the same marker
 *   (FIX-M-028). Either way the delivery completes WITHOUT any provider call, so
 *   SenderStatisticsDetailByParam lag or 30-day retention can never cause a
 *   re-send after a verified delivered callback. A delivered callback that
 *   carries no provider message id never re-arms a dead-lettered row: the row
 *   stays dead_letter (never claimed, never re-sent).
 * - Callback reconciliation ingests an ALREADY VERIFIED EmailCallbackFact and
 *   durably reconciles the delivery row. It never creates Notifications or
 *   deliveries and is idempotent on replay.
 */

import {
  type EmailCallbackFact,
  type EmailDeliveryClassification,
  type EmailDeliveryErrorCategory,
  type EmailDeliverySender,
  type EmailDeliveryLookup,
  type EmailLookupResult,
  type EmailMessage,
  type EmailSendResult,
} from './email-delivery-port.js';

export const EMAIL_DELIVERY_HANDLER_MODE = 'delivery_each_event' as const;
export const EMAIL_SUPPRESSION_SOURCE_VALUES = ['bounce', 'complaint', 'unsubscribe'] as const;
export type EmailSuppressionSource = (typeof EMAIL_SUPPRESSION_SOURCE_VALUES)[number];

export type EmailTemplateNotificationType = 'follow_activity' | 'collection_change';

/** Claim fence: delivery row + the attempt the claim produced. */
export interface EmailDeliveryAttemptFence {
  readonly deliveryId: string;
  readonly attemptCount: number;
}

export interface EmailDeliveryClaim {
  readonly deliveryId: string;
  readonly notificationId: string;
  readonly recipientAccountId: string;
  /** attempt_count AFTER the claim increment. */
  readonly attemptCount: number;
}

export interface EmailDeliveryAttempt {
  readonly deliveryId: string;
  readonly notificationId: string;
  readonly recipientAccountId: string;
  readonly state: 'pending' | 'leased' | 'retryable' | 'delivered' | 'suppressed' | 'dead_letter';
  readonly attemptCount: number;
  readonly stateRevision: string;
  readonly nextAttemptAt: Date;
  readonly leasedUntil: Date | null;
  readonly lastErrorCategory: EmailDeliveryErrorCategory | null;
  /**
   * Provider delivery evidence (EnvId). NULL on every production-written
   * claimable row EXCEPT one: a verified delivered callback re-arms a
   * dead-lettered row and persists its id here (delivered-confirmed marker).
   * A verified delivered callback on a retryable row persists it too, but that
   * write finalizes the row delivered in the same UPDATE (FIX-M-028), so it
   * never leaves a claimable row carrying the marker.
   */
  readonly providerMessageId: string | null;
}

export interface EmailTemplateContext {
  readonly notificationType: EmailTemplateNotificationType;
  /** Escaped at render time; never the recipient email. */
  readonly actorName: string | null;
  readonly collectionTitle: string | null;
  readonly occurredAt: Date;
}

/**
 * Rendered message WITHOUT the recipient address: `to` is applied by the
 * worker at send time from the trusted accounts.email fact so renderers never
 * see or embed PII (frozen D4/D10).
 */
export type EmailTemplateMessage = Omit<EmailMessage, 'to'>;

export interface EmailTemplateRenderers {
  render(notificationType: EmailTemplateNotificationType, context: EmailTemplateContext): EmailTemplateMessage;
}

export interface EmailDeliveryRetryPolicy {
  /** Bounded total attempts (>= 2); the last failing attempt dead-letters. */
  readonly maxAttempts: number;
  /** Backoff for `attemptCount` (1-based attempt that just failed). */
  backoffMs(attemptCount: number): number;
}

export interface EmailSuppressionFacts {
  readonly accountActive: boolean;
  readonly emailEnabled: boolean;
  readonly accountEmail: string | null;
  /** Durable recipient-level suppression fact (bounce/complaint/unsubscribe). */
  readonly suppression: EmailSuppressionSource | null;
}

/** P5-29 repository contract implemented by infrastructure. */
export interface EmailDeliveryWorkerRepository {
  claimDue(input: { readonly limit: number; readonly leaseDurationMs: number }):
    Promise<readonly EmailDeliveryClaim[]>;
  heartbeat(fence: EmailDeliveryAttemptFence, leaseDurationMs: number): Promise<boolean>;
  loadAttempt(fence: EmailDeliveryAttemptFence): Promise<EmailDeliveryAttempt | null>;
  readSuppressionFacts(recipientAccountId: string): Promise<EmailSuppressionFacts>;
  loadTemplateContext(notificationId: string): Promise<EmailTemplateContext | null>;
  recordSuppressionFact(recipientAccountId: string, source: EmailSuppressionSource,
    occurredAt: Date): Promise<void>;
  /** Final leased->delivered CAS; false when the lease fence is lost. */
  completeDelivery(fence: EmailDeliveryAttemptFence, providerMessageId: string | null): Promise<boolean>;
  /** Final leased->retryable|dead_letter CAS; false when the lease fence is lost. */
  failDelivery(fence: EmailDeliveryAttemptFence, input: {
    readonly nextAttemptAt: Date;
    readonly errorCategory: EmailDeliveryErrorCategory | null;
    readonly deadLetter: boolean;
  }): Promise<boolean>;
  /** Final leased->suppressed CAS (suppression recheck); false when the lease fence is lost. */
  suppressDelivery(fence: EmailDeliveryAttemptFence): Promise<boolean>;
}

export type EmailDeliveryDisposition =
  | 'delivered' | 'suppressed' | 'retryable' | 'dead_letter' | 'lease_lost';

export interface ProcessEmailDeliveryClaimInput {
  readonly claim: EmailDeliveryClaim;
  readonly repository: EmailDeliveryWorkerRepository;
  readonly provider: EmailDeliverySender & EmailDeliveryLookup;
  readonly renderers: EmailTemplateRenderers;
  readonly retryPolicy: EmailDeliveryRetryPolicy;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface ProcessEmailDeliveryClaimResult {
  readonly disposition: EmailDeliveryDisposition;
  readonly reason: string;
  readonly attemptCount: number;
  readonly errorCategory: EmailDeliveryErrorCategory | null;
}

/**
 * Re-reads suppression facts for an in-flight attempt and returns a terminal
 * suppression result when the decision flipped since the claim-time recheck.
 * Returns null when the attempt is still sendable (m3 mid-race recheck).
 */
export async function evaluateEmailSuppressionForAttempt(
  repository: Pick<EmailDeliveryWorkerRepository, 'readSuppressionFacts' | 'suppressDelivery'>,
  attempt: EmailDeliveryAttempt,
  fence: EmailDeliveryAttemptFence,
): Promise<ProcessEmailDeliveryClaimResult | null> {
  const facts = await repository.readSuppressionFacts(attempt.recipientAccountId);
  const suppression = evaluateEmailSuppression(facts);
  if (suppression.decision === 'suppressed') {
    const transitioned = await repository.suppressDelivery(fence);
    return result(transitioned ? 'suppressed' : 'lease_lost', suppression.reason,
      fence.attemptCount, null);
  }
  return null;
}

/** Pure suppression decision (precedence: account > durable fact > preference). */
export function evaluateEmailSuppression(facts: EmailSuppressionFacts):
{ readonly decision: 'sendable' | 'suppressed'; readonly reason: string } {
  if (!facts.accountActive) {
    return Object.freeze({ decision: 'suppressed', reason: 'account_inactive' });
  }
  if (facts.suppression !== null) {
    return Object.freeze({ decision: 'suppressed', reason: 'durable_suppression' });
  }
  if (!facts.emailEnabled) {
    return Object.freeze({ decision: 'suppressed', reason: 'email_disabled' });
  }
  return Object.freeze({ decision: 'sendable', reason: 'none' });
}

export interface EmailDeliveryRetryPolicyOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
}

export function createEmailDeliveryRetryPolicy(
  options: EmailDeliveryRetryPolicyOptions = {},
): EmailDeliveryRetryPolicy {
  const base = options.baseDelayMs ?? 60_000;
  const cap = options.maxDelayMs ?? 3_600_000;
  const maxAttempts = options.maxAttempts ?? 6;
  const jitter = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  if (base < 1_000 || cap < base || maxAttempts < 2 || maxAttempts > 20
    || jitter < 0 || jitter > 1) {
    throw new RangeError('invalid email delivery retry policy');
  }
  return Object.freeze({
    maxAttempts,
    backoffMs(attemptCount: number): number {
      const exponential = Math.min(cap, base * (2 ** Math.max(0, attemptCount - 1)));
      const factor = 1 - jitter + (2 * jitter * random());
      return Math.max(1, Math.round(exponential * factor));
    },
  });
}

export interface EmailDeliverySendOutcome {
  readonly disposition: 'delivered' | 'retryable' | 'dead_letter';
  readonly errorCategory: EmailDeliveryErrorCategory | null;
  readonly nextAttemptAt: Date | null;
}

/** Adapter classification -> delivery transition (frozen D11 taxonomy). */
export function decideEmailSendOutcome(input: {
  readonly classification: EmailDeliveryClassification;
  readonly errorCategory: EmailDeliveryErrorCategory | null;
  readonly attemptCount: number;
  readonly retryPolicy: EmailDeliveryRetryPolicy;
  readonly now: Date;
}): EmailDeliverySendOutcome {
  if (input.classification === 'success') {
    return Object.freeze({ disposition: 'delivered', errorCategory: null, nextAttemptAt: null });
  }
  if (input.classification === 'permanent') {
    return Object.freeze({ disposition: 'dead_letter',
      errorCategory: input.errorCategory ?? 'invalid_contract', nextAttemptAt: null });
  }
  if (input.attemptCount >= input.retryPolicy.maxAttempts) {
    return Object.freeze({ disposition: 'dead_letter', errorCategory: 'retry_exhausted',
      nextAttemptAt: null });
  }
  const retryable = input.classification === 'retryable';
  return Object.freeze({
    disposition: 'retryable',
    // 'unknown' (defensive) -> retryable 'other' (frozen unknown taxonomy).
    errorCategory: retryable ? (input.errorCategory ?? 'other') : 'other',
    nextAttemptAt: new Date(input.now.getTime() + input.retryPolicy.backoffMs(input.attemptCount)),
  });
}

/**
 * FIX-M-026: bounded failure transition for an unclassified process-phase
 * exception (repository / renderer / provider throw). The thrown error maps
 * to the stable sanitized category `other`: the category never varies with
 * error text, so PII/secrets stay out of the row and the ops tally (the
 * redacted origin detail is logged at the loop boundary). The attempt fence
 * decides the transition: below maxAttempts the row goes retryable with
 * policy backoff (a retried attempt reconciles via provider lookup BEFORE any
 * re-send, so an unknown send outcome is never hastily dead-lettered), and at
 * or above maxAttempts it dead-letters as retry_exhausted - dead_letter rows
 * are never claimed again, so every live claim's attempt_count is bounded by
 * maxAttempts.
 */
export function decideEmailProcessingFailure(input: {
  readonly error: unknown;
  readonly attemptCount: number;
  readonly retryPolicy: EmailDeliveryRetryPolicy;
  readonly now: Date;
}): EmailDeliverySendOutcome {
  void input.error; // stable category; the sanitized origin detail is logged separately
  return decideEmailSendOutcome({
    classification: 'retryable',
    errorCategory: 'other',
    attemptCount: input.attemptCount,
    retryPolicy: input.retryPolicy,
    now: input.now,
  });
}

export async function processEmailDeliveryClaim(
  input: ProcessEmailDeliveryClaimInput,
): Promise<ProcessEmailDeliveryClaimResult> {
  const now = input.now ?? (() => new Date());
  if (input.signal?.aborted) {
    return result('lease_lost', 'aborted', input.claim.attemptCount, null);
  }
  const fence: EmailDeliveryAttemptFence = {
    deliveryId: input.claim.deliveryId, attemptCount: input.claim.attemptCount,
  };
  const attempt = await input.repository.loadAttempt(fence);
  if (!attempt) return result('lease_lost', 'fence_lost', fence.attemptCount, null);

  // Delivered-confirmed marker: a VERIFIED delivered callback on a dead-lettered
  // row re-arms it (dead_letter -> retryable) and persists the callback's
  // provider message id here. The callback itself is authoritative evidence
  // that the provider accepted the message, so this claim finalizes delivered
  // WITHOUT any provider call - even when SenderStatisticsDetailByParam has no
  // row yet (statistics lag) or the stats row aged out (30-day retention).
  // Production writes never set provider_message_id on non-terminal rows, so a
  // non-null id on a retried attempt can only come from a verified delivered
  // callback. The marker also outranks the suppression recheck: a delivery
  // confirmed delivered is a past fact and cannot be retroactively suppressed.
  if (fence.attemptCount > 1 && attempt.providerMessageId !== null) {
    const transitioned = await input.repository.completeDelivery(fence, attempt.providerMessageId);
    return result(transitioned ? 'delivered' : 'lease_lost', 'callback_delivered_confirmed',
      fence.attemptCount, null);
  }

  const facts = await input.repository.readSuppressionFacts(attempt.recipientAccountId);
  const suppression = evaluateEmailSuppression(facts);
  if (suppression.decision === 'suppressed') {
    const transitioned = await input.repository.suppressDelivery(fence);
    return result(transitioned ? 'suppressed' : 'lease_lost', suppression.reason,
      fence.attemptCount, null);
  }
  if (!facts.accountEmail || facts.accountEmail.trim() === '') {
    // Recipient identity (D4) is missing; retrying cannot help. Permanent.
    const transitioned = await input.repository.failDelivery(fence, {
      nextAttemptAt: now(), errorCategory: 'invalid_contract', deadLetter: true });
    return result(transitioned ? 'dead_letter' : 'lease_lost', 'missing_recipient_email',
      fence.attemptCount, 'invalid_contract');
  }

  const context = await input.repository.loadTemplateContext(attempt.notificationId);
  if (!context) {
    // The authority row vanished mid-flight (e.g. cascade delete raced the
    // claim); the orphaned delivery is dead-lettered for operator review.
    const transitioned = await input.repository.failDelivery(fence, {
      nextAttemptAt: now(), errorCategory: 'other', deadLetter: true });
    return result(transitioned ? 'dead_letter' : 'lease_lost', 'authority_row_missing',
      fence.attemptCount, 'other');
  }
  const rendered = input.renderers.render(context.notificationType, context);
  const message: EmailMessage = Object.freeze({ ...rendered, to: facts.accountEmail });

  // Retried attempts reconcile via SenderStatisticsDetailByParam BEFORE any
  // new send: a known-delivered/bounced message is never re-sent (completion
  // standard + frozen D9 lookup authority). A lookup API ERROR (FIX-L-058)
  // never reaches the send below either: the reconciliation classifies it and
  // returns a terminal/backoff result instead of null.
  if (fence.attemptCount > 1) {
    const lookup = await input.provider.lookup({ idempotencyKey: fence.deliveryId });
    const recovered = await reconcileLookupBeforeSend(
      lookup, attempt, fence, input.repository, input.retryPolicy, now);
    if (recovered) return recovered;
  }

  input.signal?.throwIfAborted();
  // Mid-race suppression recheck immediately before the provider call:
  // a preference/account/suppression-fact change observed AFTER the earlier
  // recheck but BEFORE the provider accepts suppresses with zero sends.
  // Once the send has reached the provider the delivery completes delivered.
  const preSendSuppression = await evaluateEmailSuppressionForAttempt(
    input.repository, attempt, fence);
  if (preSendSuppression !== null) return preSendSuppression;
  const send = await input.provider.send({
    idempotencyKey: fence.deliveryId, message, signal: input.signal,
  });
  const outcome = decideEmailSendOutcome({
    classification: send.classification, errorCategory: send.errorCategory,
    attemptCount: fence.attemptCount, retryPolicy: input.retryPolicy, now: now(),
  });
  switch (outcome.disposition) {
    case 'delivered': {
      const transitioned = await input.repository.completeDelivery(fence, send.providerMessageId);
      return result(transitioned ? 'delivered' : 'lease_lost', 'send_success',
        fence.attemptCount, null);
    }
    case 'retryable': {
      const transitioned = await input.repository.failDelivery(fence, {
        nextAttemptAt: outcome.nextAttemptAt ?? now(), errorCategory: outcome.errorCategory,
        deadLetter: false });
      return result(transitioned ? 'retryable' : 'lease_lost', 'send_retryable',
        fence.attemptCount, outcome.errorCategory);
    }
    default: {
      const transitioned = await input.repository.failDelivery(fence, {
        nextAttemptAt: now(), errorCategory: outcome.errorCategory, deadLetter: true });
      return result(transitioned ? 'dead_letter' : 'lease_lost', 'send_dead_letter',
        fence.attemptCount, outcome.errorCategory);
    }
  }
}

async function reconcileLookupBeforeSend(
  lookup: EmailLookupResult,
  attempt: EmailDeliveryAttempt,
  fence: EmailDeliveryAttemptFence,
  repository: EmailDeliveryWorkerRepository,
  retryPolicy: EmailDeliveryRetryPolicy,
  now: () => Date,
): Promise<ProcessEmailDeliveryClaimResult | null> {
  // FIX-L-058: a lookup API ERROR is never equivalent to "no delivery facts".
  // A failed statistics call proves NOTHING about the previous attempt, so
  // re-sending on an error could double-deliver a possibly-sent message.
  // Errors take the same attempt-fenced transition as the send path and NEVER
  // reach the provider send:
  //   - retryable (transport/timeout/5xx/abort/closed) -> retryable with the
  //     adapter category + policy backoff, dead_letter retry_exhausted at/above
  //     maxAttempts;
  //   - permanent (4xx invalid contract / rejected lookup input) -> dead_letter
  //     with the adapter category (default invalid_contract) for review;
  //   - unknown WITH an error category (malformed 2xx body / pagination past
  //     the bounded cap - no fact derivable) -> retryable 'other' + backoff
  //     (frozen D11 unknown taxonomy).
  // An error is NEVER recorded as a durable suppression fact either (error
  // classification must not permanently suppress the recipient). Only the
  // documented benign unknown - a successful response with no facts and NO
  // error (errorCategory null, statistics lag) - returns null to proceed to
  // send per the frozen strategy.
  if (lookup.classification !== 'success') {
    if (lookup.classification === 'permanent') {
      const errorCategory = lookup.errorCategory ?? 'invalid_contract';
      const transitioned = await repository.failDelivery(fence, {
        nextAttemptAt: now(), errorCategory, deadLetter: true });
      return result(transitioned ? 'dead_letter' : 'lease_lost', 'lookup_permanent_error',
        fence.attemptCount, errorCategory);
    }
    if (lookup.classification === 'retryable' || lookup.errorCategory !== null) {
      const outcome = decideEmailSendOutcome({
        classification: 'retryable',
        errorCategory: lookup.errorCategory
          ?? (lookup.classification === 'retryable' ? 'provider_unavailable' : 'other'),
        attemptCount: fence.attemptCount,
        retryPolicy,
        now: now(),
      });
      const transitioned = await repository.failDelivery(fence, {
        nextAttemptAt: outcome.nextAttemptAt ?? now(), errorCategory: outcome.errorCategory,
        deadLetter: outcome.disposition === 'dead_letter' });
      return result(transitioned ? outcome.disposition : 'lease_lost',
        outcome.disposition === 'dead_letter' ? 'lookup_retry_exhausted' : 'lookup_retryable_error',
        fence.attemptCount, outcome.errorCategory);
    }
    // Benign unknown (statistics lag, errorCategory null): continue per the
    // frozen strategy.
    return null;
  }
  if (lookup.outcome === 'delivered') {
    // The lookup API does not expose the EnvId; the delivery evidence stays the
    // provider_message_id from the original send or null.
    const transitioned = await repository.completeDelivery(fence, null);
    return result(transitioned ? 'delivered' : 'lease_lost', 'lookup_delivered',
      fence.attemptCount, null);
  }
  if (lookup.outcome === 'conflicting_facts') {
    // FIX-M-025: the provider returned BOTH delivered and bounce/complaint/
    // failed rows whose relative event order cannot be proven. Take NO
    // irreversible action: no durable suppression from an unproven failure, no
    // delivered completion from an unproven success, and no re-send of a
    // possibly-delivered message. Dead-letter for manual review (dead_letter
    // rows are never auto-replayed).
    const transitioned = await repository.failDelivery(fence, {
      nextAttemptAt: now(), errorCategory: 'other', deadLetter: true });
    return result(transitioned ? 'dead_letter' : 'lease_lost', 'lookup_conflicting_facts',
      fence.attemptCount, 'other');
  }
  if (lookup.outcome === 'bounced' || lookup.outcome === 'complaint'
    || lookup.outcome === 'failed') {
    const source: EmailSuppressionSource = lookup.outcome === 'complaint' ? 'complaint' : 'bounce';
    // FIX-L-062: the durable fact records the PROVIDER event time (the winning
    // lookup row's UtcLastUpdateTime/LastUpdateTime) when the lookup carries
    // one, never the local reconcile clock - so a late-arriving out-of-order
    // old fact can never masquerade as newer than a verified callback fact.
    // When the provider row carried no reliable time the reconcile clock is
    // the explicit documented fallback (mirrors the callback path); it is
    // never presented as a provider-verified event time.
    const suppressionOccurredAt = lookup.eventTimeMs !== undefined && lookup.eventTimeMs !== null
      ? new Date(lookup.eventTimeMs)
      : now();
    await repository.recordSuppressionFact(attempt.recipientAccountId, source, suppressionOccurredAt);
    const transitioned = await repository.suppressDelivery(fence);
    return result(transitioned ? 'suppressed' : 'lease_lost', 'lookup_suppressed',
      fence.attemptCount, null);
  }
  return null;
}

function result(disposition: EmailDeliveryDisposition, reason: string, attemptCount: number,
  errorCategory: EmailDeliveryErrorCategory | null): ProcessEmailDeliveryClaimResult {
  return Object.freeze({ disposition, reason, attemptCount, errorCategory });
}

// ---------------------------------------------------------------------------
// Code-owned template renderers (D7/D8).
// ---------------------------------------------------------------------------

const FOLLOW_SUBJECT = 'New follower on Know-N';
const COLLECTION_CHANGE_SUBJECT = 'A collection you follow was updated on Know-N';
const SIGNATURE_LINE = '\u2014 Know-N';

/**
 * Byte-equal MIRRORS of the shared email inner-block styles (the
 * email-inner-blocks leaf of the email adapter surface). This application
 * module must stay free of adapter imports, so the paragraph style is
 * mirrored here; tests/unit/email/email-inner-blocks.test.ts pins the mirror
 * against the canonical renderer. Inline styles are mandatory: email clients
 * (Outlook) strip `<head><style>` rules.
 */
const FONT_SANS =
  "'Segoe UI', 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";
const INK = 'rgb(6, 7, 10)';
const P_STYLE = `margin:0 0 1em 0;font-family:${FONT_SANS};font-size:16px;line-height:1.6;color:${INK};`;

function p(html: string): string {
  return `<p style="${P_STYLE}">${html}</p>`;
}

/** Escape user-controlled text for safe inclusion in the HTML body. */
export function escapeEmailHtml(value: string): string {
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

export function renderFollowActivityEmail(context: EmailTemplateContext): EmailTemplateMessage {
  const actor = context.actorName ?? 'a member';
  return Object.freeze({
    subject: FOLLOW_SUBJECT,
    textBody: `${actor} followed your work.\n\n${SIGNATURE_LINE}`,
    htmlBody: `${p(`<strong>${escapeEmailHtml(actor)}</strong> followed your work.`)}\n${p(escapeEmailHtml(SIGNATURE_LINE))}`,
  });
}

export function renderCollectionChangeEmail(context: EmailTemplateContext): EmailTemplateMessage {
  const actor = context.actorName ?? 'a member';
  const title = context.collectionTitle ?? 'a collection';
  return Object.freeze({
    subject: COLLECTION_CHANGE_SUBJECT,
    textBody: `${actor} updated \u201C${title}\u201D.\n\n${SIGNATURE_LINE}`,
    htmlBody: `${p(`<strong>${escapeEmailHtml(actor)}</strong> updated \u201C<strong>${escapeEmailHtml(title)}</strong>\u201D.`)}\n${p(escapeEmailHtml(SIGNATURE_LINE))}`,
  });
}

export function createEmailTemplateRenderers(): EmailTemplateRenderers {
  return Object.freeze({
    render(notificationType: EmailTemplateNotificationType,
      context: EmailTemplateContext): EmailTemplateMessage {
      if (notificationType === 'follow_activity') return renderFollowActivityEmail(context);
      if (notificationType === 'collection_change') return renderCollectionChangeEmail(context);
      throw new TypeError(`unsupported notification type for email template: ${String(notificationType)}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Callback reconciliation (already signature-verified facts).
// ---------------------------------------------------------------------------

export interface EmailCallbackDeliveryRow {
  readonly deliveryId: string;
  readonly notificationId: string;
  readonly recipientAccountId: string;
  readonly state: 'pending' | 'leased' | 'retryable' | 'delivered' | 'suppressed' | 'dead_letter';
  readonly attemptCount: number;
  readonly stateRevision: string;
  readonly leasedUntil: Date | null;
}

export interface EmailCallbackReconcilerRepository {
  resolveDeliveryForCallback(input: { readonly providerMessageId?: string;
    readonly deliveryId?: string }): Promise<EmailCallbackDeliveryRow | null>;
  resolveSuppressionRecipient(recipientEmail: string): Promise<string | null>;
  recordSuppressionFact(recipientAccountId: string, source: EmailSuppressionSource,
    occurredAt: Date): Promise<void>;
  /** CAS transition guarded on the expected state/revision (+ active lease). */
  applyCallbackTransition(input: {
    readonly deliveryId: string;
    readonly expectedState: 'leased' | 'pending' | 'retryable' | 'dead_letter';
    readonly expectedStateRevision: string;
    readonly expectedAttemptCount: number;
    readonly nextState: 'delivered' | 'suppressed' | 'retryable';
    readonly providerMessageId?: string | null;
    readonly nextAttemptAt?: Date;
  }): Promise<boolean>;
}

export type EmailCallbackReconciliationDisposition = 'delivered' | 'suppressed' | 'noop';

export interface ReconcileEmailCallbackInput {
  readonly fact: EmailCallbackFact;
  readonly repository: EmailCallbackReconcilerRepository;
  /** Config tag prefix stripped from the callback tag to recover the delivery_id. */
  readonly tagPrefix: string;
  readonly now?: () => Date;
}

export interface EmailCallbackReconciliationResult {
  readonly disposition: EmailCallbackReconciliationDisposition;
  readonly deliveryId: string | null;
  readonly suppressionRecorded: boolean;
  readonly deliveryTransitioned: boolean;
}

/** Frozen D6 suppression mapping per callback kind (see gate doc section 4). */
export function mapEmailCallbackFactKind(fact: EmailCallbackFact): {
  readonly suppress: boolean;
  readonly source: EmailSuppressionSource | null;
  readonly deliveryNextState: 'delivered' | 'suppressed' | null;
} {
  switch (fact.kind) {
    case 'delivered': return { suppress: false, source: null, deliveryNextState: 'delivered' };
    case 'bounced': return { suppress: true, source: 'bounce', deliveryNextState: 'suppressed' };
    case 'complaint': return { suppress: true, source: 'complaint', deliveryNextState: 'suppressed' };
    case 'unsubscribed': return { suppress: true, source: 'unsubscribe', deliveryNextState: 'suppressed' };
    default: return { suppress: false, source: null, deliveryNextState: null };
  }
}

/**
 * Parse a verified callback fact's occurredAt string into a Date. DirectMail
 * emits two formats: ISO-8601 date-time (deliver/operate events, e.g.
 * `2026-08-02T00:00:12`) and UNIX epoch seconds (FblReport send_time /
 * block_time, e.g. `1783036806`). A bare 10/13-digit value is treated as
 * epoch seconds/milliseconds; everything else goes through Date parsing.
 * Returns null when unparseable so callers fall back to the reconcile clock.
 */
export function parseCallbackOccurredAt(value: string | undefined): Date | null {
  if (value === undefined) return null;
  if (/^\d{10}(?:\.\d+)?$/u.test(value)) return new Date(Number(value) * 1000);
  if (/^\d{13}$/u.test(value)) return new Date(Number(value));
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function reconcileEmailCallback(
  input: ReconcileEmailCallbackInput,
): Promise<EmailCallbackReconciliationResult> {
  const now = input.now ?? (() => new Date());
  const mapped = mapEmailCallbackFactKind(input.fact);
  const tagDeliveryId = input.fact.tag !== undefined && input.fact.tag.startsWith(input.tagPrefix)
    ? input.fact.tag.slice(input.tagPrefix.length) : undefined;
  let delivery: EmailCallbackDeliveryRow | null = null;
  let deliveryId: string | null = null;
  if (input.fact.providerMessageId !== undefined || tagDeliveryId !== undefined) {
    delivery = await input.repository.resolveDeliveryForCallback({
      ...(input.fact.providerMessageId !== undefined
        ? { providerMessageId: input.fact.providerMessageId } : {}),
      ...(tagDeliveryId !== undefined ? { deliveryId: tagDeliveryId } : {}),
    });
    deliveryId = delivery?.deliveryId ?? tagDeliveryId ?? null;
  }

  let suppressionRecorded = false;
  if (mapped.suppress) {
    const recipientAccountId = delivery?.recipientAccountId
      ?? (input.fact.recipient !== undefined
        ? await input.repository.resolveSuppressionRecipient(input.fact.recipient) : null);
    if (recipientAccountId !== null && recipientAccountId !== undefined) {
      // The durable fact records the provider-verified event time (FblReport
      // block_time / deliver-time), falling back to the reconcile clock only
      // when the callback carried no parseable occurredAt.
      const suppressionOccurredAt = parseCallbackOccurredAt(input.fact.occurredAt) ?? now();
      await input.repository.recordSuppressionFact(recipientAccountId, mapped.source!, suppressionOccurredAt);
      suppressionRecorded = true;
    }
  }

  if (!delivery) {
    return Object.freeze({ disposition: mapped.suppress ? 'suppressed' : 'noop',
      deliveryId, suppressionRecorded, deliveryTransitioned: false });
  }

  const transitioned = await attemptCallbackTransition(input, delivery, mapped, now());
  const disposition = transitioned
    ? (mapped.deliveryNextState === 'delivered' ? 'delivered' : 'suppressed')
    : (mapped.suppress && suppressionRecorded ? 'suppressed' : 'noop');
  return Object.freeze({ disposition, deliveryId: delivery.deliveryId, suppressionRecorded,
    deliveryTransitioned: transitioned });
}

async function attemptCallbackTransition(
  input: ReconcileEmailCallbackInput,
  delivery: EmailCallbackDeliveryRow,
  mapped: { readonly deliveryNextState: 'delivered' | 'suppressed' | null },
  now: Date,
): Promise<boolean> {
  const next = mapped.deliveryNextState;
  if (next === null) return false;
  const base = {
    deliveryId: delivery.deliveryId,
    expectedStateRevision: delivery.stateRevision,
    expectedAttemptCount: delivery.attemptCount,
  };
  if (next === 'delivered') {
    if (delivery.state === 'pending') {
      // No send is recorded yet; the worker remains the send authority.
      return false;
    }
    if (delivery.state === 'retryable') {
      // FIX-M-028: a retryable row only exists after a provider send/processing
      // attempt (e.g. the send succeeded but the final leased->delivered CAS
      // lost the lease and the row fell back to retryable), and the VERIFIED
      // delivered callback is authoritative evidence the provider accepted the
      // message. Finalize delivered NOW (retryable -> delivered CAS, fenced on
      // state revision + attempt count like every callback transition) and
      // persist the callback's provider message id as the delivered-confirmed
      // marker, so the next claim never runs - SenderStatisticsDetailByParam
      // lag or 30-day stats retention can never cause a re-send (mirrors the
      // dead_letter re-arm path).
      return input.repository.applyCallbackTransition({ ...base, expectedState: 'retryable',
        nextState: 'delivered', providerMessageId: input.fact.providerMessageId ?? null });
    }
    if (delivery.state === 'leased') {
      if (delivery.leasedUntil === null || delivery.leasedUntil.getTime() <= now.getTime()) {
        // Expired lease: a newer attempt may own the row; never overwrite it.
        return false;
      }
      return input.repository.applyCallbackTransition({ ...base, expectedState: 'leased',
        nextState: 'delivered', providerMessageId: input.fact.providerMessageId ?? null });
    }
    if (delivery.state === 'dead_letter') {
      // Re-arm so the next claim finalizes the delivery as delivered. The
      // callback's provider message id is persisted on the row as the
      // delivered-confirmed marker: the next claim completes delivered WITHOUT
      // any provider call, so statistics lag/retention can never cause a
      // re-send. A delivered callback that carries no provider message id can
      // NOT persist the marker, so the row stays dead-lettered (dead_letter
      // rows are never claimed; a re-send can never occur).
      if (input.fact.providerMessageId === undefined) return false;
      return input.repository.applyCallbackTransition({ ...base, expectedState: 'dead_letter',
        nextState: 'retryable', nextAttemptAt: now,
        providerMessageId: input.fact.providerMessageId });
    }
    return false;
  }
  // Suppression facts (bounced/complaint/unsubscribed).
  if (delivery.state === 'leased') {
    if (delivery.leasedUntil === null || delivery.leasedUntil.getTime() <= now.getTime()) {
      return false;
    }
    return input.repository.applyCallbackTransition({ ...base, expectedState: 'leased',
      nextState: 'suppressed' });
  }
  if (delivery.state === 'pending' || delivery.state === 'retryable') {
    return input.repository.applyCallbackTransition({ ...base, expectedState: delivery.state,
      nextState: 'suppressed' });
  }
  return false;
}
