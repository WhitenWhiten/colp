import type { Generated } from 'kysely';

export interface CollectionTable {
  id: string;
  owner_subject_id: string;
  is_library: Generated<boolean>;
  title: string;
  summary: string | null;
  kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
  visibility: 'private' | 'protected' | 'public' | 'unlisted';
  allow_search_indexing: Generated<boolean>;
  search_text: Generated<string>;
  /** R10 Directory q filter text: plain lower() over the NFC title/summary contract. */
  directory_search_text: Generated<string>;
  search_vector: Generated<unknown>;
  publication_slug: Generated<string | null>;
  published_at: Generated<Date | null>;
  root_node_id: string;
  root_node_is_root: boolean;
  resource_revision: string;
  content_revision: string;
  policy_revision: string;
  /**
   * ADR-0021 / 02 §4.2: coarse authorization-cache generation.
   * Invalidates caches; mutation still re-checks policy_revision under the
   * collection row lock. Not Wire/payload authority.
   */
  authz_cache_version: Generated<bigint>;
  commit_ordinal: bigint;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  /** P-04: live nodes (`deleted_at IS NULL`); maintained by the nodes trigger. */
  live_node_count: Generated<number>;
  /** ADR-0007 expand: canonical resource payload (nullable until dual-write contract). */
  payload_json: Record<string, unknown> | null;
  payload_schema_version: number | null;
  payload_authority_status: 'pending' | 'backfilled' | 'malformed' | null;
}

export interface NodeTable {
  id: string;
  collection_id: string;
  parent_id: string | null;
  kind: 'folder' | 'bookmark' | 'separator';
  is_root: boolean;
  folder_role: Generated<string | null>;
  title: string | null;
  url: string | null;
  search_url_host: Generated<string | null>;
  search_text: Generated<string>;
  search_vector: Generated<unknown>;
  description: string | null;
  tags: unknown | null;
  visibility: 'inherit' | 'protected' | 'private';
  position_token: string | null;
  resource_revision: string;
  children_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_commit_ordinal: bigint | null;
  /** ADR-0007 expand: canonical resource payload (nullable until dual-write contract). */
  payload_json: Record<string, unknown> | null;
  payload_schema_version: number | null;
  payload_authority_status: 'pending' | 'backfilled' | 'malformed' | null;
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
  cause: 'web' | 'sync' | 'agent-plan' | 'restore' | 'undo' | `agent-plan:${string}` | `automation:${string}`;
  label: string;
  etag: string;
  node_count: number;
  tree_json: unknown;
  change_summary_json: unknown;
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

export interface LibrarySidebarOrderTable {
  subject_id: string;
  section: 'mine' | 'shared' | 'following';
  collection_ids: unknown;
  updated_at: Generated<Date>;
}
