import type { BookmarkSubscriptionsDatabaseSchema } from './bookmark-subscription-tables.js';
import type { CaptureDecisionTable } from '../collections/capture-records.js';
import type { ClassificationEvidenceDatabaseSchema } from './classification-evidence-table.js';
import type { ClassificationProfileDatabaseSchema } from './classification-profile-tables.js';
import type { ClassificationAutoTagDatabaseSchema } from './classification-auto-tag-table.js';
import type { ClassificationRunDatabaseSchema } from './classification-run-tables.js';
import type { CreditDatabaseSchema } from './credit-tables.js';
import type { CollectionTable, NodeTable } from './collection-tables.js';
export type { CollectionTable, NodeTable } from './collection-tables.js';
import { Kysely, PostgresDialect, type Generated, type GeneratedAlways } from 'kysely';
import { Pool, type PoolConfig } from 'pg';
import { cancelPostgresBackend } from './postgres-cancellation.js';
import { PostgresControlClient } from './postgres-control-client.js';
import type { OutboxDatabaseSchema } from './outbox-tables.js'; import type { ReportsDatabaseSchema } from './reports-tables.js'; import type { GovernanceDatabaseSchema } from './governance-tables.js';
import { TransactionPhaseDialect, type TransactionPhaseFaultInjector } from './transaction-phase-driver.js';
export type { OutboxEventTable } from './outbox-tables.js';
export interface DatabaseSchema extends BookmarkSubscriptionsDatabaseSchema, OutboxDatabaseSchema, ReportsDatabaseSchema, GovernanceDatabaseSchema, ClassificationRunDatabaseSchema, ClassificationAutoTagDatabaseSchema, ClassificationProfileDatabaseSchema, ClassificationEvidenceDatabaseSchema, CreditDatabaseSchema {
  collection_classification_settings: import('./classification-tables.js').ClassificationSettingsTable;
  classification_provider_executions: import('./classification-tables.js').ClassificationExecutionTable;
  classification_call_attempts: import('./classification-tables.js').ClassificationCallAttemptTable;
  classification_spend_budgets: import('./classification-tables.js').ClassificationSpendBudgetTable;
  account_credentials: import('./account-credentials-tables.js').AccountCredentialTable; account_credential_grants: import('./account-credential-grant-tables.js').AccountCredentialGrantTable; account_credential_plan_authorizations: import('./account-credential-grant-tables.js').AccountCredentialPlanAuthorizationTable; mcp_report_plans: import('./account-credential-grant-tables.js').McpReportPlanTable; ledger_archive_segments: import('./ledger-archive-tables.js').LedgerArchiveSegmentTable;
  ledger_archive_export_jobs: import('./ledger-archive-export-job-tables.js').LedgerArchiveExportJobTable;
  ledger_payload_purge_jobs: import('./ledger-payload-purge-tables.js').LedgerPayloadPurgeJobTable;
  ledger_payload_purge_receipts: import('./ledger-payload-purge-tables.js').LedgerPayloadPurgeReceiptTable;
  sync_history_floors: import('./sync-history-floor-tables.js').SyncHistoryFloorTable;
  operation_payloads: import('./operation-payload-tables.js').OperationPayloadTable;
  operation_lookup_facts: import('./operation-payload-tables.js').OperationLookupFactTable;
  product_command_receipts: ProductCommandReceiptTable;
  publisher_idempotency: PublisherIdempotencyTable;
  accounts: AccountTable;
  bookmark_preferences: BookmarkPreferencesTable;
  bookmark_capture_decisions: CaptureDecisionTable;
  bookmark_capture_edits: import('../collections/capture-records.js').CaptureEditTable;
  bookmark_capture_feedback: import('../collections/capture-records.js').CaptureFeedbackTable;
  bookmark_capture_learning: import('../collections/capture-records.js').CaptureLearningTable;
  bookmark_capture_tasks: import('../collections/capture-records.js').CaptureTaskTable;
  classification_evidence_erasure: { owner_subject_id: string; source: string; command_id: string; node_id: string };
  profiles: ProfileTable;
  profile_handles: ProfileHandleTable;
  account_identities: AccountIdentityTable;
  sessions: SessionTable;
  oidc_login_transactions: OidcLoginTransactionTable;
  auth_users: AuthUserTable;
  auth_accounts: AuthAccountTable;
  auth_sessions: AuthSessionTable;
  auth_verifications: AuthVerificationTable;
  auth_user_account_map: AuthUserAccountMapTable;
  known_auth_session_metadata: KnownAuthSessionMetadataTable;
  legacy_oidc_identity_archive: LegacyOidcIdentityArchiveTable;
  resource_id_ledger: ResourceIdLedgerTable;
  collections: CollectionTable;
  nodes: NodeTable;
  bookmark_icons: BookmarkIconTable;
  account_favicon_policies: import('./favicon-tables.js').AccountFaviconPolicyTable;
  bookmark_icon_sources: import('./favicon-tables.js').BookmarkIconSourceTable;
  favicon_jobs: import('./favicon-tables.js').FaviconJobTable;
  favicon_pending_deletions: import('./favicon-tables.js').FaviconPendingDeletionTable;
  favicon_job_items: import('./favicon-tables.js').FaviconJobItemTable; favicon_source_restores: import('./favicon-tables.js').FaviconSourceRestoreTable;
  collection_link_health: CollectionLinkHealthTable;
  collection_readable_replicas: CollectionReadableReplicaTable;
  collection_classify_inbox_decision: CollectionClassifyInboxDecisionTable;
  collection_export_jobs: CollectionExportJobTable;
  collection_organize_plans: CollectionOrganizePlanTable;
  collection_tree_versions: CollectionTreeVersionTable;
  collection_version_restore_receipts: CollectionVersionRestoreReceiptTable;
  annotations: AnnotationTable;
  relations: RelationTable;
  saved_resources: SavedResourceTable;
  follows: FollowTable;
  collection_follows: CollectionFollowTable;
  community_votes: CommunityVoteTable;
  community_bookmark_generations: CommunityBookmarkGenerationTable;
  community_vote_targets: CommunityVoteTargetTable;
  community_rank_snapshots: CommunityRankSnapshotTable;
  community_rank_entries: CommunityRankEntryTable;
  community_comments: CommunityCommentTable;
  community_comment_curations: CommunityCommentCurationTable;
  community_comment_settings: CommunityCommentSettingsTable;
  library_sidebar_orders: LibrarySidebarOrderTable;
  social_feed_items: SocialFeedItemTable;
  social_feed_watermarks: SocialFeedWatermarkTable;
  social_public_activity: SocialPublicActivityTable;
  notification_preferences: NotificationPreferenceTable;
  notifications: NotificationTable;
  notification_deliveries: NotificationDeliveryTable;
  sync_devices: SyncDeviceTable;
  sync_replica_id_ledger: SyncReplicaIdLedgerTable;
  sync_replica_generations: SyncReplicaGenerationTable;
  sync_replicas: SyncReplicaTable;
  sync_extension_credentials: SyncExtensionCredentialTable;
  sync_sessions: SyncSessionTable;
  sync_session_scopes: SyncSessionScopeTable;
  sync_session_bindings: SyncSessionBindingTable;
  sync_session_idempotency_receipts: SyncSessionIdempotencyReceiptTable;
  sync_pull_cursor_evidence: SyncPullCursorEvidenceTable;
  sync_pull_cursor_recovery_proofs: SyncPullCursorRecoveryProofTable;
  sync_pull_cursor_lineage: SyncPullCursorLineageTable;
  sync_pull_page_evidence: import('./sync-pull-page-evidence-tables.js').SyncPullPageEvidenceTable;
  sync_ack_receipts: SyncAckReceiptTable;
  sync_recovery_capabilities: SyncRecoveryCapabilityTable;
  sync_bootstrap_snapshot_pages: SyncBootstrapSnapshotPageTable;
  sync_recovery_ack_receipts: SyncRecoveryAckReceiptTable;
  sync_replica_retirement_receipts: SyncReplicaRetirementReceiptTable;
  sync_sequence_lanes: SyncSequenceLaneTable;
  sync_sequence_operation_claims: SyncSequenceOperationClaimTable;
  sync_sequence_receipts: SyncSequenceReceiptTable;
  sync_collection_effect_cutovers: SyncCollectionEffectCutoverTable;
  sync_operation_effects: SyncOperationEffectTable;
  sync_operation_effect_pages: SyncOperationEffectPageTable;
  sync_node_revision_history: SyncNodeRevisionHistoryTable;
  sync_node_tombstones: SyncNodeTombstoneTable;
  sync_collection_purge_state: SyncCollectionPurgeStateTable;
  sync_purged_node_id_watermarks: SyncPurgedNodeIdWatermarkTable;
  sync_conflicts: SyncConflictTable;
  sync_conflict_resolution_receipts: SyncConflictResolutionReceiptTable;
  reading_progress: ReadingProgressTable;
  collection_members: CollectionMemberTable;
  collection_invites: CollectionInviteTable;
  collection_invite_deliveries: CollectionInviteDeliveryTable;
  collection_policies: CollectionPolicyTable;
  resource_revisions: ResourceRevisionTable;
  children_revisions: ChildrenRevisionTable;
  content_revisions: ContentRevisionTable;
  policy_revisions: PolicyRevisionTable;
  operations: OperationTable;
  audit_events: AuditEventTable;
  audit_event_payloads: AuditEventPayloadTable;
  collection_mutation_projection_applied: CollectionMutationProjectionAppliedTable;
  collection_mutation_projection_resources: CollectionMutationProjectionResourceTable;
  collection_mutation_projection_watermarks: CollectionMutationProjectionWatermarkTable;
  mcp_change_plans: McpChangePlanTable;
  mcp_approvals: McpApprovalTable;
  mcp_commit_receipts: McpCommitReceiptTable;
  generation_keys: GenerationKeysTable;
  blob_records: BlobRecordsTable;
  blob_generations: BlobGenerationsTable;
  upload_intents: UploadIntentsTable;
  attachments: AttachmentsTable;
  publication_insight_events: PublicationInsightEventTable;
  publication_insight_daily: PublicationInsightDailyTable;
}
export interface ProductCommandReceiptTable {
  principal_id: string;
  command_scope: string;
  command_id: string;
  request_fingerprint: string;
  target_identity: string | null;
  result_status: number | null;
  result_headers: Record<string, string> | null;
  result_media_type: string | null;
  result_bytes: Buffer | null;
  result_digest: string | null;
  contract_version: string;
  claimed_at: Date;
  completed_at: Date | null;
  result_expires_at: Date | null;
  result_purged_at: Date | null;
  compact_claim: boolean;
}
/** Publisher admission ownership — isolated from product_command_receipts. */
export interface PublisherIdempotencyTable {
  namespace: string;
  principal_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  target_identity: string | null;
  result_status: number | null;
  result_headers: Record<string, string> | null;
  result_media_type: string | null;
  result_bytes: Buffer | null;
  result_digest: string | null;
  contract_version: string;
  claimed_at: Date;
  completed_at: Date | null;
  result_expires_at: Date | null;
}
export interface AccountTable {
  id: string;
  subject_id: string;
  status: 'active' | 'disabled' | 'deleted';
  email: string | null;
  security_epoch: bigint;
  security_epoch_bumped_at: Generated<Date | null>;
  created_at: Date;
  deleted_at: Date | null;
}

export interface BookmarkPreferencesTable {
  subscription_on_unfollow: 'keep' | 'remove';
  subscription_on_unsubscribe: 'keep' | 'remove';
  subscription_default_check_interval_minutes: 5 | 15 | 60 | null;
  subscription_default_digest_mode: 'latest' | 'recent';
  subscription_default_edition_limit: number;
  capture_mode: 'manual' | 'automatic';
  result_panel_auto_dismiss_ms: number;
  learn_from_corrections: boolean;
  resume_classification_when_online: boolean;
  ai_tag_mode: 'off' | 'suggest' | 'add';

  account_id: string;
  bookmark_insert_position: 'top' | 'bottom';
  folders_first: boolean;
  revision: string;
  updated_at: Date;
}

export interface ProfileTable {
  account_id: string;
  display_name: string;
  avatar_url: string | null;
  about: Generated<string>;
  search_display_name: Generated<string>;
  search_display_vector: Generated<unknown>;
  updated_at: Date;
}

export interface ProfileHandleTable {
  handle: string;
  account_id: string;
  search_handle: Generated<string>;
  created_at: Date;
}

export interface AccountIdentityTable {
  id: string;
  account_id: string;
  issuer: string;
  subject: string;
  created_at: Date;
}

export interface SessionTable {
  id: string;
  account_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  csrf_token_hash: string;
  token_hash: string;
  security_epoch: bigint;
  rotated_from_session_id: string | null;
  last_seen_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

/**
 * Contracted OIDC login transaction: protected digests + PKCE ciphertext only.
 * Raw state/nonce/code_verifier columns are removed (cannot store browser secrets).
 */
export interface OidcLoginTransactionTable {
  /** Keyed digest of browser state (primary key). */
  state_hash: string;
  /** Keyed digest of browser nonce. */
  nonce_hash: string;
  /** Authenticated ciphertext of PKCE code_verifier. */
  pkce_verifier_ciphertext: Buffer;
  /** Encryption key reference id (not the key material). */
  encryption_key_id: string;
  /** Encryption key version for rotation. */
  encryption_key_version: number;
  return_to: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  code_challenge_method: string;
}

/**
 * B1 expand: Better Auth 1.6.29 authentication user (library schema
 * transcription, migration 202609050900_better_auth_schema). Column names are
 * the Better Auth runtime contract (quoted camelCase) and must not be renamed.
 */
export interface AuthUserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** G2 username plugin. Null for email-only rows created before a username was set. */
  username: string | null;
}

/** B1 expand + T-02: Better Auth 1.7.1 credential / provider account rows. */
export interface AuthAccountTable {
  id: string;
  accountId: string;
  providerId: string;
  issuer: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  password: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** B1 expand: Better Auth 1.6.29 browser session carrier. */
export interface AuthSessionTable {
  id: string;
  expiresAt: Date;
  token: string;
  /** Keyed equality lookup for the encrypted token; null only on legacy rows. */
  tokenLookupHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}

/** B1 expand: Better Auth 1.6.29 OTP / reset proof storage. */
export interface AuthVerificationTable {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * B1 expand: bidirectional 1:1 mapping between a Better Auth user and a
 * Know-N business account (G1 ADR §15). auth_user_id is the primary key;
 * account_id has its own UNIQUE.
 */
export interface AuthUserAccountMapTable {
  auth_user_id: string;
  account_id: string;
  created_at: Date;
}

/**
 * B1 expand: Know-N idle/absolute/epoch/CSRF facts for a Better Auth session
 * plus the predecessor CAS single-winner claim (G1 ADR §13, R1/R2/R3).
 */
export interface KnownAuthSessionMetadataTable {
  auth_session_id: string;
  /** sha256 digest of the logical BA token (never of its encrypted DB envelope). */
  session_token_hash: string;
  account_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  security_epoch: bigint;
  csrf_token_hash: string;
  predecessor_session_id: string | null;
  last_seen_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

/**
 * B1 expand: permanent legacy OIDC identity archive (issuer/subject/account
 * evidence facts only; no access/refresh token, code or secret column).
 */
export interface LegacyOidcIdentityArchiveTable {
  id: GeneratedAlways<bigint>;
  issuer: string;
  subject: string;
  account_id: string;
  migration_source: string;
  email_verified_claim: boolean;
  migrated_at: Date;
  retention_until: Date;
}

export interface ResourceIdLedgerTable {
  resource_id: string;
  resource_type: string;
  reserved_at: Generated<Date>;
  committed_at: Date | null;
}


export interface PublicationInsightEventTable {
  id: string;
  collection_id: string;
  event_type: 'collection_view' | 'preview_open' | 'resource_open';
  node_id: string | null;
  visitor_hash: Buffer;
  occurred_at: Date;
}

export interface PublicationInsightDailyTable {
  collection_id: string;
  day: Date;
  event_type: 'collection_view' | 'preview_open' | 'resource_open';
  node_id: Generated<string>;
  count: bigint;
}


export interface BookmarkIconTable {
  node_id: string;
  collection_id: string;
  object_id: string;
  content_type: string;
  byte_size: number;
  digest_sha256: Buffer;
  created_at: Date;
  updated_at: Date;
}

export interface CollectionLinkHealthTable {
  node_id: string;
  collection_id: string;
  status: 'pending' | 'healthy' | 'redirect' | 'broken';
  http_status: number | null;
  final_url: string | null;
  checked_at: Date | null;
  error_class: string | null;
  lease_owner: string | null;
  lease_until: Date | null;
}

export interface CollectionReadableReplicaTable {
  node_id: string;
  collection_id: string;
  status: 'pending' | 'ready' | 'failed' | 'unsupported';
  source_url: string;
  title: string | null;
  byline: string | null;
  word_count: number;
  sections: unknown;
  failure_code: string | null;
  etag: string;
  extracted_at: Date | null;
  updated_at: Date;
  enqueued_at: Date | null;
  lease_owner: string | null;
  lease_until: Date | null;
  enqueue_command_id: string | null;
}

export interface CollectionClassifyInboxDecisionTable {
  node_id: string;
  collection_id: string;
  account_subject_id: string;
  status: 'accepted' | 'skipped';
  suggestion_id: string | null;
  decided_at: Date;
}

export interface CollectionExportJobTable {
  job_id: string;
  owner_subject_id: string;
  status: 'pending' | 'running' | 'ready' | 'failed' | 'expired';
  object_key: string | null;
  byte_size: number | null;
  expires_at: Date;
  ready_at: Date | null;
  lease_owner: string | null;
  lease_until: Date | null;
  error_class: string | null;
  created_at: Date;
}

export interface CollectionOrganizePlanTable {
  plan_id: string;
  account_id: string;
  collection_id: string;
  collection_revision: string;
  planner_id: string;
  status: 'open' | 'applied' | 'expired';
  expires_at: Date;
  etag: string;
  truncated: boolean;
  actions: unknown;
  applied_action_ids: unknown;
  apply_receipt: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface CollectionTreeVersionTable {
  version_id: string;
  account_id: string;
  collection_id: string;
  content_revision: string;
  kind: 'manual' | 'pre_restore' | 'pre_mutation';
  label: string;
  etag: string;
  node_count: number;
  tree_json: unknown;
  created_at: Date;
}

export interface CollectionVersionRestoreReceiptTable {
  command_id: string;
  version_id: string;
  collection_id: string;
  account_id: string;
  inner_commands: unknown;
  result_json: unknown;
  created_at: Date;
}

export interface AnnotationTable {
  id: string;
  collection_id: string;
  subject_type: 'collection' | 'node';
  subject_id: string;
  creator_principal_id: string;
  type: 'note' | 'summary' | 'tldr' | 'highlight' | 'rating' | 'custom';
  format: 'plain' | 'markdown' | 'html' | 'json' | null;
  value_json: unknown;
  annotation_search_text: Generated<string | null>;
  annotation_search_vector: Generated<unknown | null>;
  visibility: 'public' | 'unlisted' | 'protected' | 'private';
  resource_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_commit_ordinal: bigint | null;
  payload_json: Record<string, unknown>;
  payload_schema_version: number;
  payload_authority_status: 'backfilled';
}

export interface RelationTable {
  id: string;
  collection_id: string;
  from_node_id: string;
  to_node_id: string;
  type: 'related' | 'precedes' | 'follows' | 'supports' | 'contradicts'
    | 'duplicate_of' | 'derived_from' | 'mentions' | 'custom';
  label: string | null;
  visibility: 'public' | 'unlisted' | 'protected' | 'private';
  resource_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_commit_ordinal: bigint | null;
  payload_json: Record<string, unknown>;
  payload_schema_version: number;
  payload_authority_status: 'backfilled';
}

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

export interface LibrarySidebarOrderTable {
  subject_id: string;
  section: 'mine' | 'shared' | 'following';
  collection_ids: unknown;
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

export interface SyncNodeRevisionHistoryTable {
  collection_id: string;
  resource_id: string;
  revision: string;
  kind: 'folder' | 'bookmark' | 'separator';
  payload_json: Record<string, unknown>;
  commit_ordinal: bigint;
  operation_id: string | null;
  recorded_at: Generated<Date>;
}

export interface SyncNodeTombstoneTable {
  collection_id: string;
  target_id: string;
  root_target_id: string;
  operation_id: string;
  scope: 'single' | 'subtree';
  delete_revision: string;
  delete_commit_ordinal: bigint;
  delete_cursor: string;
  deleted_at: Date;
  purge_after: Date;
  affected_count: number;
  payload_json: Record<string, unknown>;
  payload_purged_at: Generated<Date | null>;
  purge_state_revision: Generated<bigint | null>;
  created_at: Generated<Date>;
}

export interface SyncCollectionEffectCutoverTable {
  collection_id: string;
  effect_cutover_ordinal: bigint;
  created_at: Generated<Date>;
}

export interface SyncOperationEffectTable {
  effect_id: string;
  collection_id: string;
  operation_id: string;
  origin_replica_id: string;
  origin_sequence: bigint;
  commit_ordinal: bigint;
  protocol_version: '0.2';
  terminal_status: 'applied' | 'rebased';
  operation_digest: string;
  effect_json: Record<string, unknown>;
  effect_digest: string;
  created_at: Generated<Date>;
}

export interface SyncOperationEffectPageTable {
  effect_id: string;
  page_number: number;
  page_count: number;
  member_count: number;
  page_json: Record<string, unknown>;
  page_digest: string;
  previous_page_digest: string | null;
  created_at: Generated<Date>;
}

export interface SyncCollectionPurgeStateTable {
  collection_id: string;
  purged_through_commit_ordinal: Generated<bigint>;
  purged_through_stream_kind: Generated<number>;
  purged_through_stable_id: Generated<string>;
  state_revision: Generated<bigint>;
  lease_owner: Generated<string | null>;
  lease_token: Generated<string | null>;
  lease_generation: Generated<bigint>;
  lease_expires_at: Generated<Date | null>;
  attempt_count: Generated<bigint>;
  last_attempt_at: Generated<Date | null>;
  last_completed_at: Generated<Date | null>;
  updated_at: Generated<Date>;
}

export interface SyncPurgedNodeIdWatermarkTable {
  collection_id: string;
  target_id: string;
  delete_commit_ordinal: bigint;
  delete_revision: string;
  delete_operation_id: string;
  purge_state_revision: bigint;
  purged_at: Date;
}

export interface SyncConflictTable {
  conflict_id: string;
  collection_id: string;
  replica_id: string;
  session_id: string;
  operation_id: string;
  target_id: string;
  base_revision: string;
  trusted_base_revision: string | null;
  current_revision: string;
  conflict_type: 'concurrent_field_update' | 'unprovable_base' | 'untrusted_base' | 'delete_update';
  conflicting_fields: readonly string[];
  base_projection: Record<string, unknown>;
  current_projection: Record<string, unknown>;
  incoming_projection: Record<string, unknown>;
  private_payload_ciphertext: Buffer;
  private_payload_iv: Buffer;
  private_payload_auth_tag: Buffer;
  private_payload_key_version: number;
  private_payload_digest: string;
  allowed_resolutions: readonly ('server' | 'incoming' | 'custom' | 'both')[];
  pull_wire_json: Record<string, unknown>;
  sync_stream_kind: Generated<number>;
  status: 'open' | 'resolved';
  revision: string;
  commit_ordinal: bigint;
  created_at: Generated<Date>;
  resolved_by_operation_id: Generated<string | null>;
  resolved_by_principal_id: Generated<string | null>;
  resolution: Generated<'server' | 'incoming' | 'custom' | 'both' | null>;
  resolution_result_json: Generated<Record<string, unknown> | null>;
  resolved_at: Generated<Date | null>;
}

export interface SyncConflictResolutionReceiptTable {
  principal_id: string;
  conflict_id: string;
  conflict_revision: string;
  idempotency_key: string;
  request_digest: string;
  resolution: 'server' | 'incoming' | 'custom' | 'both';
  result_json: Record<string, unknown> | null;
  result_digest: string | null;
  operation_id: string | null;
  claimed_at: Generated<Date>;
  completed_at: Date | null;
}

export interface SyncDeviceTable {
  device_id: string;
  account_id: string;
  device_name: string;
  created_at: Date;
}

export interface SyncReplicaIdLedgerTable {
  replica_id: string;
  account_id: string;
  device_id: string;
  collection_id: string;
  initial_lease_generation: bigint;
  binding_mode: 'whole-profile' | 'mounted-folder';
  browser_profile_id: string;
  browser_generation: string;
  reserved_at: Date;
}

export interface SyncReplicaGenerationTable {
  replica_id: string;
  lease_generation: bigint;
  lease_id: string;
  issued_at: Date;
}

export interface SyncReplicaTable {
  replica_id: string;
  account_id: string;
  device_id: string;
  collection_id: string;
  replica_name: string;
  kind: 'browser_extension' | 'desktop_client' | 'mobile_client' | 'server' | 'importer' | 'other';
  lease_generation: bigint;
  lease_id: string;
  binding_mode: 'whole-profile' | 'mounted-folder';
  browser_profile_id: string;
  browser_generation: string;
  adapter_profile: string;
  adapter_version: string;
  capabilities_json: Record<string, unknown>;
  checkpoint_cursor: string | null;
  checkpoint_commit_ordinal: bigint | null;
  checkpoint_stream_kind: Generated<number | null>;
  checkpoint_stable_id: Generated<string | null>;
  status: 'active' | 'expired' | 'recovery_required' | 'retired';
  created_at: Date;
  last_seen_at: Date;
  lease_expires_at: Date;
  retired_at: Date | null;
  lifecycle_revision: Generated<bigint>;
  wire_json: Record<string, unknown>;
}

export interface SyncPullCursorEvidenceTable {
  evidence_id: GeneratedAlways<bigint>;
  cursor: string | null;
  cursor_digest: string;
  session_id: string;
  account_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  policy_revision: string;
  protocol_version: '0.1' | '0.2';
  tuple_commit_ordinal: bigint;
  tuple_stream_kind: number;
  tuple_stable_id: string;
  cursor_expires_at: Date;
  issued_at: Generated<Date>;
  upper_commit_ordinal: bigint;
  upper_stream_kind: number;
  upper_stable_id: string;
  collection_revision: string;
  page_limit: number;
  purge_commit_ordinal: bigint;
  purge_stream_kind: number;
  purge_stable_id: string;
}

export interface SyncPullCursorRecoveryProofTable {
  proof_id: GeneratedAlways<bigint>;
  cursor_digest: string;
  authority_session_id: string;
  authority_lifecycle_revision: bigint;
  account_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  policy_revision: string;
  protocol_version: '0.1' | '0.2';
  page_limit: number;
  tuple_commit_ordinal: bigint;
  tuple_stream_kind: number;
  tuple_stable_id: string;
  upper_commit_ordinal: bigint;
  upper_stream_kind: number;
  upper_stable_id: string;
  purge_commit_ordinal: bigint;
  purge_stream_kind: number;
  purge_stable_id: string;
  cursor_expires_at: Date;
  proof_expires_at: Date;
  issued_at: Date;
  consumed_at: Date | null;
}

export interface SyncAckReceiptTable {
  principal_id: string;
  idempotency_key: string;
  request_digest: string;
  session_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  cursor_digest: string;
  result_json: Record<string, unknown>;
  result_digest: string;
  claimed_at: Date;
  completed_at: Date;
}

export interface SyncRecoveryCapabilityTable {
  capability_digest: string; session_id: string; account_id: string; replica_id: string;
  collection_id: string; old_lease_generation: bigint; purge_commit_ordinal: bigint;
  purge_stream_kind: number; purge_stable_id: string; snapshot_id: string;
  snapshot_revision: string; snapshot_page_count: number; snapshot_node_count: number;
  snapshot_cursor: string; purpose: 'sync-recovery-bootstrap-ack'; version: number;
  key_version: string; issued_at: Generated<Date>; expires_at: Date; consumed_at: Date | null;
}

/**
 * FIX-L-035: digest-only signed lineage that outlives cursor evidence and
 * recovery proofs so a legitimately expired long-offline cursor can be
 * distinguished from a random/tampered one. Never stores the full cursor.
 */
export interface SyncPullCursorLineageTable {
  lineage_id: GeneratedAlways<bigint>;
  cursor_digest: string;
  session_id: string;
  account_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  policy_revision: string;
  protocol_version: '0.1' | '0.2';
  page_limit: number;
  tuple_commit_ordinal: bigint;
  tuple_stream_kind: number;
  tuple_stable_id: string;
  cursor_expires_at: Date;
  lineage_expires_at: Date;
  issued_at: Date;
  key_version: string;
  receipt: string;
}

export interface SyncBootstrapSnapshotPageTable {
  snapshot_id: string; session_id: string; replica_id: string; old_lease_generation: bigint;
  page_sequence: number; page_start_offset: number; page_end_offset: number; complete: boolean;
  response_digest: string; served_at: Generated<Date>;
}

export interface SyncRecoveryAckReceiptTable {
  replica_id: string; idempotency_key: string; principal_id: string; request_digest: string;
  capability_digest: string; session_id: string; collection_id: string; snapshot_id: string;
  snapshot_revision: string; old_lease_generation: bigint; new_lease_generation: bigint;
  new_lease_id: string; result_json: Record<string, unknown>; result_digest: string; completed_at: Date;
}

export interface SyncReplicaRetirementReceiptTable {
  replica_id: string;
  idempotency_key: string;
  principal_id: string;
  request_digest: string;
  session_id: string;
  collection_id: string;
  lease_generation: bigint;
  retired_lifecycle_revision: bigint;
  result_digest: string;
  completed_at: Date;
}

export interface SyncExtensionCredentialTable {
  issuer: string;
  credential_id: string;
  credential_digest: string;
  subject: string;
  account_id: string;
  client_id: string;
  audience: string;
  scopes_json: unknown;
  credential_issued_at: Date;
  credential_expires_at: Date;
  evidence_expires_at: Date;
  security_epoch: bigint;
  revoked_at: Date | null;
  first_seen_at: Date;
  last_verified_at: Date;
}

export interface SyncSessionTable {
  session_id: string;
  account_id: string;
  principal_subject_id: string;
  credential_issuer: string;
  credential_id: string;
  oauth_client_id: string;
  origin: string | null;
  session_scope: 'collection';
  protocol_version: '0.1' | '0.2';
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  lease_id: string;
  lifecycle_revision: bigint;
  policy_revision: string;
  account_security_epoch: bigint;
  issued_at: Date;
  expires_at: Date;
  status: 'active' | 'terminated';
  termination_reason: 'credential_revoked' | 'scope_reduced' | 'bootstrap_rejected'
    | 'administrative' | 'lease_expired' | null;
  terminated_at: Date | null;
  secret_digest: string;
  capability_digest: string;
  binding_json: Record<string, unknown>;
}

export interface SyncSessionScopeTable {
  session_id: string;
  scope: 'sync:bootstrap' | 'sync:pull' | 'sync:push';
}

export interface SyncSessionBindingTable {
  session_id: string;
  account_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  lease_id: string;
  lifecycle_revision: bigint;
  policy_revision: string;
  binding_mode: 'whole-profile' | 'mounted-folder';
  browser_profile_id: string;
  browser_generation: string;
  created_at: Date;
}

export interface SyncSessionIdempotencyReceiptTable {
  principal_id: string;
  session_scope: 'collection';
  idempotency_key: string;
  request_fingerprint: string;
  collection_id: string;
  replica_id: string;
  session_id: string;
  result_ciphertext: Buffer;
  result_iv: Buffer;
  result_auth_tag: Buffer;
  result_key_version: number;
  result_digest: string;
  claimed_at: Date;
  completed_at: Date;
}

export interface SyncSequenceLaneTable {
  replica_id: string;
  collection_id: string;
  sequence_scope: string;
  next_sequence: bigint;
  retention_policy: 'replica_lifetime';
  retained_through_retirement: true;
  created_at: Date;
  updated_at: Date;
}

export interface SyncSequenceOperationClaimTable {
  operation_id: string;
  replica_id: string;
  collection_id: string;
  sequence_scope: string;
  sequence_number: bigint;
  canonical_digest: string; digest_algorithm: 'known.sync-sequence.v1' | 'known.sync-sequence.logical.v2';
  retention_policy: 'replica_lifetime';
  retained_through_retirement: true;
  claimed_at: Date;
}

export interface SyncSequenceReceiptTable {
  replica_id: string;
  collection_id: string;
  sequence_scope: string;
  sequence_number: bigint;
  operation_id: string;
  canonical_digest: string; digest_algorithm: 'known.sync-sequence.v1' | 'known.sync-sequence.logical.v2';
  session_id: string;
  lease_generation: bigint;
  server_batch_id: string;
  media_type: string;
  endpoint_identity: string;
  status: 'applied' | 'rebased' | 'noop' | 'conflicted' | 'rejected' | 'deferred';
  result_json: Record<string, unknown>;
  result_digest: string;
  terminal: GeneratedAlways<boolean>;
  retention_policy: 'replica_lifetime';
  retained_through_retirement: true;
  created_at: Date;
  updated_at: Date;
  finalized_at: Date | null;
}

export interface CollectionMemberTable {
  collection_id: string;
  subject_id: string;
  role: 'owner' | 'editor' | 'viewer';
  granted_at: Date;
  /** P-10: denormalized collections.updated_at; trigger/default fill it on insert. */
  collection_updated_at: Generated<Date>;
}

export interface CollectionInviteTable {
  id: string;
  collection_id: string;
  role: 'editor' | 'viewer';
  email_normalized: string;
  invited_subject_id: string | null;
  invited_by_subject_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  expires_at: Date;
  created_at: Generated<Date>;
  resolved_at: Date | null;
  accepted_subject_id: string | null;
  collection_title_snapshot: string;
}

export interface CollectionInviteDeliveryTable {
  delivery_id: string;
  invite_id: string;
  state: 'pending' | 'leased' | 'retryable' | 'delivered' | 'suppressed' | 'dead_letter';
  attempt_count: number;
  state_revision: bigint;
  next_attempt_at: Date;
  leased_until: Date | null;
  delivered_at: Date | null;
  suppressed_at: Date | null;
  dead_lettered_at: Date | null;
  last_error_category:
    | 'unknown_future_version'
    | 'invalid_contract'
    | 'retry_exhausted'
    | 'dependency'
    | 'provider_unavailable'
    | 'other'
    | 'not_configured'
    | null;
  provider_message_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CollectionPolicyTable {
  collection_id: string;
  policy_json: Record<string, unknown>;
  updated_at: Date;
}

export interface ResourceRevisionTable {
  collection_id: string;
  resource_id: string;
  revision: string;
  ordinal: bigint;
  created_at: Date;
}

export interface ChildrenRevisionTable {
  collection_id: string;
  parent_id: string;
  revision: string;
  ordinal: bigint;
}

export interface ContentRevisionTable {
  collection_id: string;
  revision: string;
  ordinal: bigint;
  created_at: Date;
}

export interface PolicyRevisionTable {
  collection_id: string;
  revision: string;
  ordinal: bigint;
  created_at: Date;
}

export interface OperationTable {
  operation_id: string;
  collection_id: string;
  commit_ordinal: bigint;
  operation_type: string;
  payload_source: 'hot' | 'archive';
  payload_locator: string;
  payload_digest_sha256: string;
  payload_bytes: bigint;
  payload_schema_version: 1;
  payload_bucket: Date;
  sync_wire_present: boolean;
  sync_stream_kind: Generated<number>;
  actor_principal_id: string | null;
  created_at: Date;
}

export interface AuditEventTable {
  id: GeneratedAlways<bigint>;
  operation_id: string | null;
  collection_id: string | null;
  principal_id: string | null;
  event_type: string;
  created_at: Date;
  payload_digest: string;
  payload_bytes: bigint;
  payload_schema_version: number;
  payload_bucket_locator: string;
  hot_payload_id: bigint | null;
  payload_archive_segment_id: string | null;
}

export interface AuditEventPayloadTable {
  event_id: bigint;
  details_json: Record<string, unknown>;
  created_at: Date;
}

/** Durable applied-event ledger for collection mutation projections (Task 12). */
export interface CollectionMutationProjectionAppliedTable {
  handler_name: string;
  domain_event_id: string;
  event_type: string;
  event_version: number;
  aggregate_id: string;
  aggregate_scope: string;
  commit_ordinal: bigint;
  disposition: 'applied' | 'stale_skipped';
  payload_json: Record<string, unknown>;
  applied_at: Date;
}

/** Materialised collection/node projection rows fenced by commit ordinal. */
export interface CollectionMutationProjectionResourceTable {
  collection_id: string;
  resource_type: 'collection' | 'node' | 'annotation' | 'relation';
  resource_id: string;
  last_handler_name: string;
  last_event_type: string;
  last_event_version: number;
  last_domain_event_id: string;
  last_commit_ordinal: bigint;
  state_json: Record<string, unknown>;
  deleted: boolean;
  updated_at: Date;
}

/** Per-handler, per-resource fence inside the projection transaction. */
export interface CollectionMutationProjectionWatermarkTable {
  handler_name: string;
  aggregate_id: string;
  last_commit_ordinal: bigint;
  last_domain_event_id: string;
  updated_at: Date;
}

/** Session-free durable MCP 2026-07-28 Change Plan authority (MCP-W02). */
export interface McpChangePlanTable {
  plan_id: string;
  binding_kind: 'authenticated';
  principal_id: string;
  client_id: string;
  credential_binding_id: string;
  resource_audience: string;
  security_epoch: string;
  binding_digest: string;
  binding_json: Record<string, unknown>;
  status: 'pending' | 'approved' | 'committing' | 'consumed' | 'cancelled' | 'expired';
  risk: 'low' | 'medium' | 'high';
  requires_approval: boolean;
  approval_method: string | null;
  approval_uri: string | null;
  summary: string;
  impact_json: Record<string, unknown>;
  required_scopes_json: readonly string[];
  base_revisions_json: Record<string, string>;
  operations_json: readonly unknown[];
  operations_digest: string;
  untrusted_note: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  retained_until: Date;
}

/** One-time server-bound MCP Approval decision (MCP-W02). */
export interface McpApprovalTable {
  plan_id: string;
  binding_digest: string;
  operations_digest: string;
  decided_at: Date;
  consumed_at: Date | null;
  retained_until: Date;
}

/** First Commit result replay receipt keyed by Plan + idempotency key (MCP-W02). */
export interface McpCommitReceiptTable {
  plan_id: string;
  idempotency_key: string;
  binding_digest: string;
  operations_digest: string;
  result_json: Record<string, unknown> | null;
  result_digest: string | null;
  claimed_at: Date;
  completed_at: Date | null;
  retained_until: Date;
}

export interface DatabaseRuntimeOptions {
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleTransactionTimeoutMs?: number;
  readonly applicationName?: string;
  readonly production?: boolean;
  /**
   * Explicit SSL override for the production gate: pass `false` to connect
   * without TLS (e.g. Postgres inside the same compose network with no
   * server-side TLS). Omit (or pass `true`) to keep the production default
   * of `ssl: { rejectUnauthorized: true }`.
   */
  readonly ssl?: boolean;
  /**
   * Optional driver-level fault injection (FIX-L-010): `afterCommitApplied`
   * runs after the COMMIT statement is applied by the server. Throwing there
   * simulates a REAL lost COMMIT acknowledgement and the unit of work reports
   * `commit_outcome_unknown`. Evidence probes and integration tests only;
   * never set in production.
   */
  readonly transactionPhaseFaultInjector?: TransactionPhaseFaultInjector;
}

export interface DatabaseRuntime {
  readonly db: Kysely<DatabaseSchema>;
  readonly pool: Pool;
  cancelBackend(backendPid: number): Promise<boolean>;
  verifyReady(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabasePoolConfig(
  databaseUrl: string,
  options: DatabaseRuntimeOptions = {},
): PoolConfig {
  return {
    connectionString: databaseUrl,
    max: options.maxConnections ?? 10,
    // PGC-06 (T-13): permanent LISTEN and long-checkout connections survive
    // NAT/firewall idle sweeps instead of dying silently until reconnect.
    keepAlive: true,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 2_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    lock_timeout: options.lockTimeoutMs ?? 5_000,
    idle_in_transaction_session_timeout: options.idleTransactionTimeoutMs ?? 15_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    application_name: options.applicationName ?? 'known-backend',
    ...(options.production && options.ssl !== false ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

export function createDatabaseRuntime(
  databaseUrl: string,
  options: DatabaseRuntimeOptions = {},
): DatabaseRuntime {
  const poolConfig = createDatabasePoolConfig(databaseUrl, options);
  const pool = new Pool(poolConfig);
  // Idle clients terminated by the server (pg_terminate_backend, failover,
  // admin restarts) emit 'error' on the pool itself; without a listener that
  // is an uncaught exception and kills the process. pg-pool drops the dead
  // client and replaces it on the next acquire; in-flight queries reject
  // individually and are handled by their callers.
  pool.on('error', () => undefined);
  // Checked-out clients (`pool.connect()` — kysely transactions, the outbox
  // inTransaction helper) have NO pg-pool error listener: `_acquireClient`
  // removes the idle listener on checkout. A backend terminated while such a
  // client is checked out (idle between statements) would emit an unhandled
  // 'error' and crash the whole process; the P4A-P05 reconnect evidence
  // proved exactly that. Attach a no-op listener to every new client so the
  // failure surfaces only through the query rejections callers already handle.
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });
  const db = new Kysely<DatabaseSchema>({
    dialect: new TransactionPhaseDialect(new PostgresDialect({ pool, controlClient: PostgresControlClient }), options.transactionPhaseFaultInjector),
  });
  let closePromise: Promise<void> | undefined;

  return {
    db,
    pool,
    cancelBackend: (backendPid) => cancelPostgresBackend(poolConfig, backendPid),
    async verifyReady(): Promise<void> {
      const schema = await pool.query<{
        authority_migration: boolean;
        authoritative_effect_migration: boolean;
        pull_recovery_proof_migration: boolean;
        receipts: string | null;
        operations: string | null;
        audit_events: string | null;
        effect_cutovers: string | null;
        operation_effects: string | null;
        operation_effect_pages: string | null;
        pull_recovery_proofs: string | null;
      }>(`select
        exists (select 1 from kysely_migration where name = '202607221600_authority_repair') as authority_migration,
        exists (select 1 from kysely_migration where name = '202607252700_sync_operation_effects') as authoritative_effect_migration,
        exists (select 1 from kysely_migration where name = '202607300100_sync_pull_recovery_proofs') as pull_recovery_proof_migration,
        to_regclass('product_command_receipts')::text as receipts,
        to_regclass('operations')::text as operations,
        to_regclass('audit_events')::text as audit_events,
        to_regclass('sync_collection_effect_cutovers')::text as effect_cutovers,
        to_regclass('sync_operation_effects')::text as operation_effects,
        to_regclass('sync_operation_effect_pages')::text as operation_effect_pages,
        to_regclass('sync_pull_cursor_recovery_proofs')::text as pull_recovery_proofs`);
      const state = schema.rows[0];
      if (!state
          || !state.authority_migration
          || !state.authoritative_effect_migration
          || !state.pull_recovery_proof_migration
          || !state.receipts
          || !state.operations
          || !state.audit_events
          || !state.effect_cutovers
          || !state.operation_effects
          || !state.operation_effect_pages
          || !state.pull_recovery_proofs) {
        throw new Error('database schema is not at the required Phase 3 Pull recovery proof migration');
      }

      const constraints = await pool.query<{ constraint_name: string }>(`select conname as constraint_name
        from pg_constraint
        where conname = any($1::text[])
          and connamespace = current_schema()::regnamespace`, [[
        'product_command_id_canonical_uuid_v4',
        'product_command_full_result_retention',
        'publisher_receipt_replay_window',
        'operations_collection_ordinal_unique',
        'resource_revisions_resource_ordinal_unique',
        'audit_events_operation_collection_fk',
        'nodes_position_token_colp_check',
        'operations_collection_operation_unique',
        'sync_sessions_protocol_version_check',
        'sync_pull_cursor_evidence_protocol_version_check',
        'sync_operation_effect_operation_fk',
        'sync_pull_cursor_recovery_proofs_retention_check',
      ]]);
      if (constraints.rowCount !== 12) {
        throw new Error('database is missing required Phase 3 authoritative effect constraints');
      }
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        await db.destroy();
        // Kysely initializes its driver lazily. If callers only used the exposed
        // pg Pool, destroy() has no initialized driver to close.
        if (!pool.ending) await pool.end();
      })();
      return closePromise;
    },
  };
}

/** Backward-compatible name retained from the bootstrap foundation. */
export const createDatabase = createDatabaseRuntime;

/** Phase 4A immutable generation ledger (P4A-I07 expand migration). */
export interface GenerationKeysTable {
  generation_id: string;
  key: string;
  key_fingerprint: string;
  blob_id: string;
  created_reason: 'allocate' | 'replacement';
  created_at: Date;
}

export interface BlobRecordsTable {
  blob_id: string;
  owner_subject_id: string;
  logical_state: 'issued' | 'uploaded' | 'verifying' | 'stored_private' | 'attached_private' | 'expired';
  current_generation_id: string | null;
  verified_size: number | null;
  verified_sha256: string | null;
  media_type: string | null;
  verification_policy_version: string | null;
  retention_deadline: Date | null;
  finalize_lease_owner: string | null;
  finalize_lease_expires_at: Date | null;
  // P4A-I13 future Attachment binding (expand migration
  // 202608080200_phase4a_i13_finalize_binding): unique binding identity +
  // DB-clock bound_at + immutable binding snapshot written by the
  // transaction-bound finalize handoff.
  attachment_binding_id: string | null;
  attached_at: Date | null;
  attachment_binding_generation_id: string | null;
  attachment_binding_etag: string | null;
  attachment_binding_policy_version: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BlobGenerationsTable {
  generation_id: string;
  blob_id: string;
  bucket: string;
  key: string;
  key_fingerprint: string;
  generation_state: 'allocated' | 'observed' | 'active' | 'orphaned' | 'retired' | 'deletion_pending' | 'deleted' | 'contract_corrupt' | 'quarantined';
  observed_etag: string | null;
  observed_size: number | null;
  observed_content_type: string | null;
  observed_metadata_keys: string[];
  observed_metadata_values: string[];
  retire_reason: 'replaced' | 'orphaned' | 'expired' | null;
  retired_at: Date | null;
  orphaned_at: Date | null;
  cleanup_attempt_token: string | null;
  cleanup_lease_owner: string | null;
  cleanup_lease_expires_at: Date | null;
  cleanup_lease_generation: bigint;
  confirmed_absent_at: Date | null;
  deleted_at: Date | null;
  contract_corrupt_at: Date | null;
  quarantined_at: Date | null;
  quarantined_reason: string | null;
  created_at: Date;
}

export interface UploadIntentsTable {
  intent_id: string;
  blob_id: string;
  generation_id: string;
  principal_id: string;
  collection_id: string;
  subject_identity: string;
  expected_size: number | null;
  expected_sha256: string | null;
  media_hint: string | null;
  policy_revision: string;
  idempotency_key: string;
  created_at: Date;
  expires_at: Date;
}

export interface AttachmentsTable {
  // P4A-P02 owner-private Attachment metadata (expand migration
  // 202608080500_phase4a_p02_attachment_metadata). The row is keyed by the
  // ledger-reserved Attachment id, bound 1:1 to the committed blob_records
  // binding (trigger), and stores ONLY owner-private snapshot facts — never
  // the R2 key/URL/credential or an unsanitized filename.
  attachment_id: string;
  blob_id: string;
  collection_id: string;
  owner_subject_id: string;
  sanitized_filename: string | null;
  media_type: string | null;
  size: number | null;
  logical_state: 'attached_private' | 'retired' | 'deleted';
  attached_at: Date;
  retired_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
