import type { SocialCollectionChangeConsumerEvent, SocialFeedAttemptFence } from './feed-worker.js';

export type PublicActivityProjectDisposition = 'applied' | 'duplicate' | 'withdrawn' | 'ineligible' | 'lease_lost';

export interface ProjectPublicActivityInput {
  readonly event: SocialCollectionChangeConsumerEvent;
  readonly attempt: SocialFeedAttemptFence;
  readonly signal: AbortSignal;
}

export interface ProjectPublicActivityResult {
  readonly disposition: PublicActivityProjectDisposition;
  readonly itemCount: number;
}

export interface PublicActivityWorkerRepository {
  projectCollectionChange(input: ProjectPublicActivityInput): Promise<ProjectPublicActivityResult>;
}
