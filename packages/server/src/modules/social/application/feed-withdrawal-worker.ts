import type { SocialFeedAttemptFence } from './feed-worker.js';

export interface SocialFeedWithdrawalEvent {
  readonly eventId: string;
  readonly eventVersion: 1;
  readonly actorProfileId: string;
  readonly targetProfileId: string;
  readonly occurredAt: Date;
}

export interface ProjectSocialFeedWithdrawalInput {
  readonly event: SocialFeedWithdrawalEvent;
  readonly attempt: SocialFeedAttemptFence;
  /** Page size; a full page returns `continued` so remaining visible rows are the cursor. */
  readonly maxRecipients: number;
  readonly signal: AbortSignal;
}

export interface ProjectSocialFeedWithdrawalResult {
  /**
   * Full page → `continued`. Empty with no remaining visible matches → `duplicate`.
   * Partial with no remaining matches → `applied`. A skip-locked remainder still
   * visible to a later reader → `continued` (must not complete the outbox).
   * Lease/fence miss → `lease_lost`.
   */
  readonly disposition: 'applied' | 'duplicate' | 'lease_lost' | 'continued';
  readonly withdrawnCount: number;
}

/** R5-06 fenced Unfollow withdrawal boundary. */
export interface SocialFeedWithdrawalWorkerRepository {
  project(
    input: ProjectSocialFeedWithdrawalInput,
  ): Promise<ProjectSocialFeedWithdrawalResult>;
}
