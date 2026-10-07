export interface CatalogPreferencesTable {
  account_id: string;
  hidden_owner_account_ids: unknown;
  hidden_tags: unknown;
  hidden_title_keywords: unknown;
  preferred_languages: unknown;
  revision: string;
  updated_at: Date;
}

export interface ModerationCaseTable {
  id: string;
  reporter_account_id: string;
  target_kind: string;
  target_id: string;
  parent_id: string | null;
  target_json: unknown;
  target_fingerprint: string;
  category: string;
  description: string;
  status: string;
  public_resolution: string | null;
  assigned_to_account_id: string | null;
  internal_note: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

export interface ModerationEvidenceTable {
  id: string;
  case_id: string;
  target_json: unknown;
  captured_at: Date;
  source_revision: string | null;
  title: string | null;
  body_text: string | null;
  source_url: string | null;
  truncated: boolean;
  record_bytes: number;
  retain_until: Date;
}

export interface ModerationRoleTable {
  account_id: string;
  reviewer: boolean;
  moderator: boolean;
  updated_at: Date;
}

export interface ModerationActionTable {
  id: string;
  case_id: string;
  target_kind: string;
  target_id: string;
  parent_id: string | null;
  target_json: unknown;
  target_fingerprint: string;
  action: string;
  reason: string;
  actor_account_id: string;
  state: string;
  revision: string;
  created_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  revoked_by_account_id: string | null;
}

export interface ModerationAppealTable {
  id: string;
  action_id: string;
  appellant_account_id: string;
  description: string;
  status: string;
  resolution: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  decided_by_account_id: string | null;
}

/**
 * Durable avatar object → account attribution. A row is written when an
 * object first becomes a (same-origin) avatar URL and is kept after the URL
 * is replaced or cleared, so account restrict_publication keeps blocking
 * historical object URLs even when object-store cleanup failed.
 */
export interface AvatarObjectTable {
  object_id: string;
  account_id: string;
  created_at: Date;
}

/**
 * Durable bookmark favicon object → (collection, node) attribution, kept
 * after the icon row is replaced or deleted for the same fail-closed reason.
 */
export interface BookmarkIconObjectTable {
  object_id: string;
  collection_id: string;
  node_id: string;
  created_at: Date;
}

export interface GovernanceDatabaseSchema {
  catalog_preferences: CatalogPreferencesTable;
  moderation_cases: ModerationCaseTable;
  moderation_evidence: ModerationEvidenceTable;
  moderation_roles: ModerationRoleTable;
  moderation_actions: ModerationActionTable;
  moderation_appeals: ModerationAppealTable;
  avatar_objects: AvatarObjectTable;
  bookmark_icon_objects: BookmarkIconObjectTable;
}
