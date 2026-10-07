export type SocialFeedItemState = 'visible' | 'withdrawn';
export type SocialFeedWithdrawalReason = 'source_removed' | 'discoverability_revoked' | 'unfollowed';
export type SocialFeedProjectionState = 'live' | 'rebuilding';

export interface SocialFeedItemInput {
  readonly feedItemId: string;
  readonly sourceEventId: string;
  readonly kind: 'collection_change' | 'follow_activity';
  readonly recipientProfileId: string;
  readonly actorProfileId: string;
  /** Unbound for follow_activity items; the Follow recheck key replaces Collection authority. */
  readonly collectionId: string | null;
  readonly sourceEventVersion: number;
  readonly sourceCommitOrdinal: string;
  /** Unbound for follow_activity items, which have no publication revision. */
  readonly publicationRevision: string | null;
  readonly discoverabilityRecheckKey: string;
  readonly publishedAt: Date;
}

export interface SocialFeedItemRecord extends SocialFeedItemInput {
  readonly state: SocialFeedItemState;
  readonly withdrawnAt: Date | null;
  readonly withdrawalReason: SocialFeedWithdrawalReason | null;
  readonly retainUntil: Date;
  readonly createdAt: Date;
}

export interface SavedSocialFeedItem extends SocialFeedItemRecord {
  readonly inserted: boolean;
}

export interface SocialFeedWatermark {
  readonly aggregateScope: string;
  readonly projectionState: SocialFeedProjectionState;
  readonly lastCommitOrdinal: string;
  readonly lastSourceEventId: string | null;
  readonly rebuildGeneration: bigint;
  readonly rebuildHighCommitOrdinal: string | null;
  readonly rebuildReplayedCommitOrdinal: string | null;
  readonly rebuildStartedAt: Date | null;
  readonly stateRevision: bigint;
  readonly stateUpdatedAt: Date;
}

export interface SocialFeedWatermarkCas {
  readonly aggregateScope: string;
  readonly expectedStateRevision: bigint;
}

export interface AdvanceSocialFeedWatermark extends SocialFeedWatermarkCas {
  readonly nextCommitOrdinal: string;
  readonly sourceEventId: string;
}

export interface BeginSocialFeedRebuild extends SocialFeedWatermarkCas {
  readonly capturedHighCommitOrdinal: string;
  readonly capturedHighSourceEventId: string | null;
}

export interface AdvanceSocialFeedRebuild extends SocialFeedWatermarkCas {
  readonly replayedCommitOrdinal: string;
}

export interface ApplySocialFeedBatchInput {
  readonly items: readonly SocialFeedItemInput[];
  readonly watermark: AdvanceSocialFeedWatermark;
}

export interface AppliedSocialFeedBatch {
  readonly items: readonly SavedSocialFeedItem[];
  readonly watermark: SocialFeedWatermark;
}

export interface PurgeSocialFeedItemsInput {
  readonly cutoff: Date;
  readonly limit: number;
  /** Optional operations scope; omitted retains the original bounded global maintenance contract. */
  readonly aggregateScope?: string;
}

export interface PurgedSocialFeedItems {
  readonly deletedCount: number;
  readonly feedItemIds: readonly string[];
}

/** P5-10 persistence contract; P5-11 supplies the event consumer and lease binding. */
export interface SocialFeedProjectionRepository {
  applyBatch(input: ApplySocialFeedBatchInput): Promise<AppliedSocialFeedBatch | null>;
  withdrawItem(input: {
    readonly feedItemId: string;
    readonly reason: SocialFeedWithdrawalReason;
  }): Promise<boolean>;
  loadWatermark(aggregateScope: string): Promise<SocialFeedWatermark>;
  advanceWatermark(input: AdvanceSocialFeedWatermark): Promise<SocialFeedWatermark | null>;
  beginRebuild(input: BeginSocialFeedRebuild): Promise<SocialFeedWatermark | null>;
  advanceRebuild(input: AdvanceSocialFeedRebuild): Promise<SocialFeedWatermark | null>;
  completeRebuild(input: SocialFeedWatermarkCas): Promise<SocialFeedWatermark | null>;
  purgeExpiredItems(input: PurgeSocialFeedItemsInput): Promise<PurgedSocialFeedItems>;
}
