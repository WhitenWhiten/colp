/**
 * CS-05 community reply notifications: the worker-facing event and
 * repository port behind the `community_comment_notification` durable
 * projection route.
 *
 * The `community.comment-created` event is appended inside the comment
 * transaction (one event per recipient: target owner + parent comment
 * author, minus the replying actor). The worker re-proves eligibility
 * inside its projection transaction — the comment still exists and is
 * effectively visible, the target still resolves on the pinned
 * generation, the recipient is still justified (parent author — immutable
 * — or current target owner), both accounts are active, and the
 * in_app + community preferences still allow delivery — before inserting
 * the `comment_reply` notification row. The dedupe key
 * (recipient, source_event_id, notification_type) makes replays exact.
 */
import type { CommunityTargetIdentity } from './community-target.js';

export interface CommunityNotificationAttemptFence {
  readonly outboxId: string;
  readonly leaseGeneration: string;
}

/** Normalized `community.comment-created` event after envelope validation. */
export interface CommunityCommentNotificationEvent {
  readonly kind: 'comment_created';
  readonly eventId: string;
  readonly eventVersion: 1;
  readonly commentId: string;
  readonly replyToId: string | null;
  readonly target: CommunityTargetIdentity;
  readonly targetGeneration: string;
  readonly actorAccountId: string;
  readonly recipientAccountId: string;
  readonly occurredAt: Date;
}

export interface ProjectCommunityNotificationInput {
  readonly event: CommunityCommentNotificationEvent;
  readonly attempt: CommunityNotificationAttemptFence;
  readonly signal: AbortSignal;
}

export interface ProjectCommunityNotificationResult {
  readonly disposition: 'applied' | 'duplicate' | 'ineligible'
    | 'preference_disabled' | 'lease_lost';
  readonly notificationCreated: boolean;
}

/** CS-05 transaction boundary. Implementations re-read authority and bind commit to attempt. */
export interface CommunityNotificationWorkerRepository {
  project(input: ProjectCommunityNotificationInput): Promise<ProjectCommunityNotificationResult>;
}
