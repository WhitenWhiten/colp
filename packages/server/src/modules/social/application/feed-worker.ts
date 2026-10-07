import { SOCIAL_IDENTITY_MAX_LENGTH } from '../../commands/index.js';

export interface SocialFeedAttemptFence {
  readonly outboxId: string;
  readonly leaseGeneration: string;
}

export interface SocialCollectionChangeConsumerEvent {
  readonly eventId: string;
  readonly eventVersion: 1 | 2;
  readonly collectionId: string;
  readonly ownerProfileId: string;
  readonly publicationRevision: string;
  readonly discoverabilityRecheckKey: string;
  readonly producerDiscoverability: 'public_candidate' | 'remove' | null;
  readonly commitOrdinal: string;
  readonly occurredAt: Date;
}

export interface ProjectSocialCollectionChangeInput {
  readonly event: SocialCollectionChangeConsumerEvent;
  readonly attempt: SocialFeedAttemptFence;
  readonly maxRecipients: number;
  readonly signal: AbortSignal;
}

export interface ProjectSocialCollectionChangeResult {
  readonly disposition: 'applied' | 'obsolete' | 'lease_lost' | 'continued';
  readonly itemCount: number;
}

/** Follow-created Feed consumer event; recipient is always the followed Profile owner. */
export interface SocialFollowActivityConsumerEvent {
  readonly eventId: string;
  readonly eventVersion: 1;
  readonly actorProfileId: string;
  readonly targetProfileId: string;
  readonly occurredAt: Date;
}

export interface ProjectSocialFollowActivityInput {
  readonly event: SocialFollowActivityConsumerEvent;
  readonly attempt: SocialFeedAttemptFence;
  readonly signal: AbortSignal;
}

export interface ProjectSocialFollowActivityResult {
  readonly disposition: 'applied' | 'duplicate' | 'ineligible' | 'lease_lost';
  readonly itemCount: number;
}

export interface RebuildSocialFeedScopeInput {
  readonly aggregateScope: string;
  /** Retained-event page size per batch; the repository persists a durable continuation. */
  readonly maxEvents: number;
  readonly maxRecipients: number;
  /** Whole-rebuild fan-out fence used by bounded operations. */
  readonly maxTotalRecipients?: number;
  readonly signal?: AbortSignal;
}

export interface RebuildSocialFeedScopeResult {
  readonly eventCount: number;
  readonly itemCount: number;
  readonly highCommitOrdinal: string;
}

/** P5-11 worker persistence boundary. Implementations re-read Follow and Publication authority. */
export interface SocialFeedWorkerRepository {
  projectCollectionChange(
    input: ProjectSocialCollectionChangeInput,
  ): Promise<ProjectSocialCollectionChangeResult>;
  projectFollowActivity(
    input: ProjectSocialFollowActivityInput,
  ): Promise<ProjectSocialFollowActivityResult>;
  rebuildCollectionScope(
    input: RebuildSocialFeedScopeInput,
  ): Promise<RebuildSocialFeedScopeResult>;
}

export async function rebuildSocialFeedProjection(input: {
  readonly repository: SocialFeedWorkerRepository;
  readonly aggregateScope: string;
  readonly maxEvents: number;
  readonly maxRecipientsPerEvent: number;
  readonly maxTotalRecipients?: number;
  readonly signal?: AbortSignal;
}): Promise<RebuildSocialFeedScopeResult> {
  assertBound(input.maxEvents, 'maxEvents', 10_000);
  assertBound(input.maxRecipientsPerEvent, 'maxRecipientsPerEvent', 1_000);
  if (input.maxTotalRecipients !== undefined) {
    assertBound(input.maxTotalRecipients, 'maxTotalRecipients', 1_000_000);
  }
  if (typeof input.aggregateScope !== 'string' || input.aggregateScope.length < 1
      || input.aggregateScope.length > SOCIAL_IDENTITY_MAX_LENGTH
      || input.aggregateScope.trim() !== input.aggregateScope) {
    throw new TypeError('aggregateScope is invalid');
  }
  input.signal?.throwIfAborted();
  return input.repository.rebuildCollectionScope({
    aggregateScope: input.aggregateScope,
    maxEvents: input.maxEvents,
    maxRecipients: input.maxRecipientsPerEvent,
    ...(input.maxTotalRecipients === undefined
      ? {} : { maxTotalRecipients: input.maxTotalRecipients }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export function assertSocialFeedFanoutBound(value: number): void {
  assertBound(value, 'maxRecipientsPerEvent', 1_000);
}

function assertBound(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be between 1 and ${max}`);
  }
}
