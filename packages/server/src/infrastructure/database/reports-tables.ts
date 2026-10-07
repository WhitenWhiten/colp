import type { GeneratedAlways } from 'kysely';

export interface ReportsDatabaseSchema {
  digest_series: DigestSeriesTable;
  digest_editions: DigestEditionTable;
  digest_members: DigestMemberTable;
  digest_follows: DigestFollowTable;
  digest_schedules: DigestScheduleTable;
  digest_runs: DigestRunTable;
  digest_audit_events: DigestAuditEventTable;
  digest_source_invalidation_progress: DigestSourceInvalidationProgressTable;
}

export interface DigestSeriesTable {
  id: string;
  owner_subject_id: string;
  title: string;
  summary: string | null;
  slug: string | null;
  visibility: 'private' | 'protected' | 'unlisted' | 'public';
  allow_search_indexing: boolean;
  state: 'active' | 'archived';
  readonly owner_publication_restricted?: boolean;
  resource_revision: string;
  content_revision: string;
  policy_revision: string;
  commit_ordinal: bigint;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  tags: unknown;
  language: string | null;
}

export interface DigestEditionTable {
  id: string;
  series_id: string;
  source_collection_id: string;
  issue_key: string;
  edition_ordinal: bigint;
  title_snapshot: string;
  summary_snapshot: string | null;
  source_content_revision: string;
  source_policy_revision: string | null;
  resource_revision: string;
  period_start: Date | null;
  period_end: Date | null;
  state: 'draft' | 'published' | 'withdrawn' | 'detached';
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  withdrawn_at: Date | null;
  detached_at: Date | null;
}

export interface DigestMemberTable {
  series_id: string;
  subject_id: string;
  role: 'owner' | 'editor' | 'viewer';
  granted_at: Date;
  revoked_at: Date | null;
}

export interface DigestFollowTable {
  series_id: string;
  follower_profile_id: string;
  followed_at: Date;
  unfollowed_at: Date | null;
}

export interface DigestScheduleTable {
  id: string;
  series_id: string;
  enabled: boolean;
  rrule: string;
  dtstart: Date;
  time_zone: string;
  catch_up_policy: 'skip' | 'one';
  max_catch_up: number;
  next_run_at: Date | null;
  resource_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface DigestRunTable {
  id: string;
  schedule_id: string;
  schedule_revision: string | null;
  occurrence_key: string;
  scheduled_for: Date;
  state: 'pending' | 'leased' | 'succeeded' | 'retryable' | 'failed' | 'cancelled';
  lease_owner: string | null;
  lease_until: Date | null;
  lease_generation: bigint;
  attempt_count: number;
  next_attempt_at: Date | null;
  last_error_class: string | null;
  issue_key: string | null;
  command_id: string | null;
  edition_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DigestAuditEventTable {
  event_id: GeneratedAlways<bigint>;
  series_id: string | null;
  edition_id: string | null;
  principal_id: string;
  principal_type: string;
  action: string;
  changed: unknown;
  occurred_at: Date;
  details: Record<string, unknown>;
}

export interface DigestSourceInvalidationProgressTable {
  domain_event_id: string;
  collection_id: string;
  after_slug: string | null;
  created_at: Date;
  updated_at: Date;
}
