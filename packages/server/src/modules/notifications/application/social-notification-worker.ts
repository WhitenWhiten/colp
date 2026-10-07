export interface SocialNotificationAttemptFence {
  readonly outboxId: string;
  readonly leaseGeneration: string;
}

export interface SocialFollowNotificationEvent {
  readonly kind: 'follow_created' | 'follow_removed';
  readonly eventId: string;
  readonly eventVersion: 1;
  readonly actorProfileId: string;
  readonly recipientProfileId: string;
  readonly occurredAt: Date;
}

export interface SocialFeedItemNotificationEvent {
  readonly kind: 'feed_item_published';
  readonly eventId: string;
  readonly eventVersion: 1;
  readonly feedItemId: string;
  readonly recipientProfileId: string;
  readonly sourceEventId: string;
  readonly collectionId: string;
  readonly discoverabilityRecheckKey: string;
  readonly occurredAt: Date;
}

export type SocialNotificationEvent = SocialFollowNotificationEvent | SocialFeedItemNotificationEvent;

export interface ProjectSocialNotificationInput {
  readonly event: SocialNotificationEvent;
  readonly attempt: SocialNotificationAttemptFence;
  readonly signal: AbortSignal;
}

export interface ProjectSocialNotificationResult {
  readonly disposition: 'applied' | 'duplicate' | 'ineligible'
    | 'preference_disabled' | 'lease_lost';
  readonly notificationCreated: boolean;
  readonly deliveryIntentCreated: boolean;
}

/** P5-17 transaction boundary. Implementations re-read authority and bind commit to attempt. */
export interface SocialNotificationWorkerRepository {
  project(input: ProjectSocialNotificationInput): Promise<ProjectSocialNotificationResult>;
}
