/**
 * SC-04 collection invite email worker (application).
 *
 * Claims a due `collection_invite_deliveries` row, suppresses when the invite
 * is no longer pending or the known account is bounce-suppressed, renders the
 * shared template, sends outside the claim transaction, then CAS-finalizes.
 * Access-policy never imports notifications; suppression is a boolean port.
 */
import { renderInviteEmailTemplate } from './invite-email-templates.js';
import type { InviteEmailSender } from './invite-email-port.js';
import type { CollaborationInviteStatus, CollaboratorGrantRole } from './ports.js';

export const INVITE_EMAIL_MAX_ATTEMPTS = 5;
export const INVITE_EMAIL_BASE_BACKOFF_MS = 30_000;
export const INVITE_EMAIL_MAX_BACKOFF_MS = 15 * 60 * 1_000;
export const INVITE_EMAIL_MISSING_DISPLAY_NAME = 'A user';
export const INVITE_EMAIL_HANDLER_NAME = 'collection_invite_email';
export const INVITE_EMAIL_EVENT_TYPE = 'collection.invite-created';
export const INVITE_EMAIL_EVENT_VERSION = 1;

export type InviteEmailDeliveryState =
  | 'pending' | 'leased' | 'retryable' | 'delivered' | 'suppressed' | 'dead_letter';

export type InviteEmailErrorCategory =
  | 'unknown_future_version'
  | 'invalid_contract'
  | 'retry_exhausted'
  | 'dependency'
  | 'provider_unavailable'
  | 'other'
  | 'not_configured';

export interface InviteEmailAttemptFence {
  readonly deliveryId: string;
  readonly attemptCount: number;
}

export interface InviteEmailClaim {
  readonly deliveryId: string;
  readonly inviteId: string;
  readonly attemptCount: number;
}

export interface InviteEmailDeliveryContext {
  readonly inviteId: string;
  readonly email: string;
  readonly role: CollaboratorGrantRole;
  readonly status: CollaborationInviteStatus;
  readonly expiresAt: Date;
  readonly collectionTitle: string;
  readonly inviterDisplayName: string | null;
  readonly invitedAccountId: string | null;
}

export interface InviteEmailDeliveryRepository {
  claimDue(input: {
    readonly limit: number;
    readonly leaseDurationMs: number;
    readonly inviteId?: string;
  }): Promise<InviteEmailClaim | null>;
  loadContext(inviteId: string): Promise<InviteEmailDeliveryContext | null>;
  isRecipientSuppressed(accountId: string): Promise<boolean>;
  completeDelivery(fence: InviteEmailAttemptFence, providerMessageId: string | null): Promise<boolean>;
  failDelivery(fence: InviteEmailAttemptFence, input: {
    readonly nextAttemptAt: Date;
    readonly errorCategory: InviteEmailErrorCategory;
    readonly deadLetter: boolean;
  }): Promise<boolean>;
  suppressDelivery(fence: InviteEmailAttemptFence, errorCategory?: InviteEmailErrorCategory | null): Promise<boolean>;
}

export type InviteEmailDisposition =
  | 'idle' | 'delivered' | 'suppressed' | 'retryable' | 'dead_letter' | 'lease_lost';

export interface ProcessInviteEmailInput {
  readonly repository: InviteEmailDeliveryRepository;
  readonly sender: InviteEmailSender;
  readonly loginUrl: string;
  readonly leaseDurationMs: number;
  readonly inviteId?: string;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface ProcessInviteEmailResult {
  readonly disposition: InviteEmailDisposition;
  readonly attemptCount: number;
}

export function inviteEmailBackoffMs(attemptCount: number): number {
  return Math.min(
    INVITE_EMAIL_BASE_BACKOFF_MS * (2 ** Math.max(0, attemptCount - 1)),
    INVITE_EMAIL_MAX_BACKOFF_MS,
  );
}

export async function processOne(input: ProcessInviteEmailInput): Promise<ProcessInviteEmailResult> {
  const now = input.now ?? (() => new Date());
  const claim = await input.repository.claimDue({
    limit: 1,
    leaseDurationMs: input.leaseDurationMs,
    ...(input.inviteId !== undefined ? { inviteId: input.inviteId } : {}),
  });
  if (!claim) return { disposition: 'idle', attemptCount: 0 };
  const fence: InviteEmailAttemptFence = {
    deliveryId: claim.deliveryId,
    attemptCount: claim.attemptCount,
  };
  const context = await input.repository.loadContext(claim.inviteId);
  if (!context || context.status !== 'pending') {
    const transitioned = await input.repository.suppressDelivery(fence);
    return { disposition: transitioned ? 'suppressed' : 'lease_lost', attemptCount: claim.attemptCount };
  }
  if (context.invitedAccountId !== null) {
    const suppressed = await input.repository.isRecipientSuppressed(context.invitedAccountId);
    if (suppressed) {
      const transitioned = await input.repository.suppressDelivery(fence);
      return { disposition: transitioned ? 'suppressed' : 'lease_lost', attemptCount: claim.attemptCount };
    }
  }

  const displayName = context.inviterDisplayName?.trim() || INVITE_EMAIL_MISSING_DISPLAY_NAME;
  const rendered = renderInviteEmailTemplate({
    inviterDisplayName: displayName,
    collectionTitle: context.collectionTitle,
    role: context.role,
    expiresAtUtcDate: utcDate(context.expiresAt),
    loginUrl: input.loginUrl,
  });
  if (!rendered.ok) {
    const transitioned = await input.repository.failDelivery(fence, {
      nextAttemptAt: now(),
      errorCategory: 'invalid_contract',
      deadLetter: true,
    });
    return { disposition: transitioned ? 'dead_letter' : 'lease_lost', attemptCount: claim.attemptCount };
  }

  const fresh = await input.repository.loadContext(claim.inviteId);
  if (!fresh || fresh.status !== 'pending') {
    const transitioned = await input.repository.suppressDelivery(fence);
    return { disposition: transitioned ? 'suppressed' : 'lease_lost', attemptCount: claim.attemptCount };
  }

  let sendResult;
  try {
    sendResult = await input.sender.sendInviteEmail({
      to: context.email,
      message: {
        subject: rendered.subject,
        textBody: rendered.textBody,
        htmlBody: rendered.htmlBody,
      },
      idempotencyKey: claim.deliveryId,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch {
    return finalizeFailure(input.repository, fence, claim.attemptCount, now(), 'other');
  }

  if (sendResult.outcome === 'queued') {
    const transitioned = await input.repository.completeDelivery(fence, sendResult.providerMessageId);
    return { disposition: transitioned ? 'delivered' : 'lease_lost', attemptCount: claim.attemptCount };
  }
  if (/not configured/iu.test(sendResult.redactedReason)) {
    const transitioned = await input.repository.suppressDelivery(fence, 'not_configured');
    return { disposition: transitioned ? 'suppressed' : 'lease_lost', attemptCount: claim.attemptCount };
  }
  return finalizeFailure(
    input.repository, fence, claim.attemptCount, now(), 'provider_unavailable',
  );
}

async function finalizeFailure(
  repository: InviteEmailDeliveryRepository,
  fence: InviteEmailAttemptFence,
  attemptCount: number,
  now: Date,
  errorCategory: InviteEmailErrorCategory,
): Promise<ProcessInviteEmailResult> {
  const deadLetter = attemptCount >= INVITE_EMAIL_MAX_ATTEMPTS;
  const transitioned = await repository.failDelivery(fence, {
    nextAttemptAt: new Date(now.getTime() + inviteEmailBackoffMs(attemptCount)),
    errorCategory: deadLetter ? 'retry_exhausted' : errorCategory,
    deadLetter,
  });
  return {
    disposition: transitioned ? (deadLetter ? 'dead_letter' : 'retryable') : 'lease_lost',
    attemptCount,
  };
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
