import type { Generated, GeneratedAlways } from 'kysely';

export interface SavedResourceTable {
  id: GeneratedAlways<bigint>;
  account_id: string;
  resource_type: 'collection' | 'node';
  resource_id: string;
  saved_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FollowTable {
  actor_profile_id: string;
  target_profile_id: string;
  followed_at: Generated<Date>;
}

export interface CollectionFollowTable {
  collection_id: string;
  follower_profile_id: string;
  followed_at: Generated<Date>;
}

/**
 * CS-01 community voting: one row per (account, target). `target_generation`
 * pins the generation the vote was cast against; readers filter on the
 * target's CURRENT generation so votes never migrate across content changes.
 */
export interface CommunityVoteTable {
  target_kind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition';
  target_id: string;
  target_collection_id: string | null;
  target_series_id: string | null;
  target_generation: string;
  account_id: string;
  value: -1 | 1;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * CS-01 opaque generation authority for bookmark targets. Rows are minted by
 * the `community_bookmark_generation_fence` trigger on every bookmark INSERT
 * and every semantic `url`/`kind` mutation, so no writer can bypass fencing.
 */
export interface CommunityBookmarkGenerationTable {
  collection_id: string;
  node_id: string;
  generation: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * CS-02 first-accepted-vote authority per (target, generation). Written by
 * the vote command's upsert transaction; `first_vote_at` never falls back
 * to target creation time. Drives the hot-v1 age term.
 */
export interface CommunityVoteTargetTable {
  target_kind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition';
  target_id: string;
  target_collection_id: string | null;
  target_series_id: string | null;
  target_generation: string;
  first_vote_at: Date;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** CS-02 durable hot-ranking snapshot header; entries cascade on prune. */
export interface CommunityRankSnapshotTable {
  snapshot_id: Generated<bigint>;
  score_version: string;
  item_count: number;
  created_at: Generated<Date>;
}

/** CS-02 one ranked row inside a snapshot; position is 1-based and contiguous. */
export interface CommunityRankEntryTable {
  snapshot_id: bigint;
  position: number;
  target_kind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition';
  target_id: string;
  target_collection_id: string | null;
  target_series_id: string | null;
  target_generation: string;
  title: string;
  href: string;
  tags: unknown;
  language: string | null;
  up: number;
  down: number;
  first_vote_at: Date | null;
  hot: number;
}

/**
 * CS-03 durable comment/reply row. `comment_id` is ledger-reserved; the row
 * binds the closed target identity plus the `target_generation` it was
 * written against so a superseded bookmark generation conceals its thread.
 * `deleted` rows can never carry a body again (tombstone CHECK); `hidden`
 * may keep its body for a later unhide.
 */
export interface CommunityCommentTable {
  comment_id: string;
  target_kind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition';
  target_id: string;
  target_collection_id: string | null;
  target_series_id: string | null;
  target_generation: string;
  root_id: string;
  reply_to_id: string | null;
  depth: number;
  author_account_id: string;
  body: string | null;
  state: Generated<'visible' | 'deleted' | 'hidden'>;
  revision: Generated<bigint>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * CS-04 curator overlay: one row per comment, created on the first curator
 * write. `revision` is the independent curation ETag authority — it never
 * shares ordering with `community_comments.revision`. `hidden=false` keeps
 * the row (revision continuity for CAS) but removes the overlay.
 */
export interface CommunityCommentCurationTable {
  comment_id: string;
  hidden: boolean;
  reason: string;
  revision: Generated<bigint>;
  updated_by_account_id: string;
  updated_at: Generated<Date>;
}

/**
 * CS-04 per-target comment-area settings (generation-independent).
 * `revision` is the independent settings ETag authority; `locked=true`
 * rejects late comment writes on the target.
 */
export interface CommunityCommentSettingsTable {
  target_kind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition';
  target_id: string;
  target_collection_id: string | null;
  target_series_id: string | null;
  locked: boolean;
  reason: string;
  revision: Generated<bigint>;
  updated_by_account_id: string;
  updated_at: Generated<Date>;
}

export interface SocialFeedItemTable {
  feed_item_id: string;
  source_event_id: string;
  kind: 'collection_change' | 'follow_activity';
  recipient_profile_id: string;
  actor_profile_id: string;
  collection_id: string | null;
  source_event_version: number;
  source_commit_ordinal: bigint;
  publication_revision: string | null;
  discoverability_recheck_key: string;
  published_at: Date;
  retain_until: Date;
  state: Generated<'visible' | 'withdrawn'>;
  withdrawn_at: Date | null;
  withdrawal_reason: 'source_removed' | 'discoverability_revoked' | 'unfollowed' | null;
  created_at: Generated<Date>;
}

export interface SocialPublicActivityTable {
  activity_id: string;
  source_event_id: string;
  actor_profile_id: string;
  collection_id: string;
  kind: 'collection_change';
  published_at: Date;
  publication_revision: string;
  discoverability_recheck_key: string;
  state: Generated<'visible' | 'withdrawn'>;
  withdrawn_at: Date | null;
  withdrawal_reason: 'source_removed' | 'discoverability_revoked' | null;
  created_at: Generated<Date>;
}

export interface SocialFeedWatermarkTable {
  aggregate_scope: string;
  projection_state: Generated<'live' | 'rebuilding'>;
  last_commit_ordinal: Generated<bigint>;
  last_source_event_id: string | null;
  rebuild_generation: Generated<bigint>;
  rebuild_high_commit_ordinal: bigint | null; rebuild_high_source_event_id: string | null;
  rebuild_replayed_commit_ordinal: bigint | null;
  rebuild_started_at: Date | null;
  state_revision: Generated<bigint>;
  state_updated_at: Generated<Date>;
  fanout_source_event_id: string | null;
  fanout_commit_ordinal: bigint | null;
  fanout_after_recipient_profile_id: string | null;
  fanout_candidate_count: bigint | null;
  fanout_started_at: Date | null;
}

export interface NotificationPreferenceTable {
  recipient_account_id: string;
  // CS-05: 'community' is the community-notification representation channel.
  channel: 'in_app' | 'email' | 'community';
  enabled: boolean;
  state_revision: Generated<bigint>;
  updated_at: Generated<Date>;
}

export interface NotificationTable {
  notification_id: string;
  recipient_account_id: string;
  source_event_id: string;
  // CS-05: 'comment_reply' rows carry community reply notifications; the
  // legacy inbox/read adapters restrict every query to the two legacy kinds.
  notification_type: 'collection_change' | 'follow_activity' | 'comment_reply';
  actor_profile_id: string | null;
  subject_type: 'collection' | 'profile' | 'community_comment';
  subject_id: string;
  state: Generated<'unread' | 'read'>;
  read_at: Date | null;
  state_revision: Generated<bigint>;
  occurred_at: Date;
  retain_until: Date;
  created_at: Generated<Date>;
}

export interface NotificationDeliveryTable {
  delivery_id: string;
  notification_id: string;
  recipient_account_id: string;
  channel: 'email';
  state: Generated<'pending' | 'leased' | 'retryable' | 'delivered' | 'suppressed' | 'dead_letter'>;
  attempt_count: Generated<number>;
  state_revision: Generated<bigint>;
  next_attempt_at: Generated<Date>;
  leased_until: Date | null;
  delivered_at: Date | null;
  suppressed_at: Date | null;
  dead_lettered_at: Date | null;
  provider_message_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ReadingProgressTable {
  id: GeneratedAlways<bigint>;
  account_id: string;
  resource_type: 'collection' | 'node';
  resource_id: string;
  status: 'not_started' | 'in_progress' | 'completed';
  progress: string;
  revision: number;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
