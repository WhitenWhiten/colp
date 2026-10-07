/**
 * FO-01 favicon policy/source tables. Kept out of the already-grandfathered
 * `runtime.ts` body so the DatabaseSchema only references them by import type.
 */

/** FO-01 account-scoped favicon policy singleton (lazy row, virtual revision 1). */
export interface AccountFaviconPolicyTable {
  account_id: string;
  new_default: 'capture' | 'online' | 'none';
  provider_template: string;
  fill_missing: boolean;
  force_all_online: boolean;
  revision: number;
  updated_at: Date;
}

/** FO-01 per-node explicit icon source state; uploaded enters via real upload only. */
export interface BookmarkIconSourceTable {
  node_id: string;
  collection_id: string;
  source_mode: 'inherit' | 'online' | 'uploaded' | 'none';
  revision: number;
  updated_at: Date;
}

/** FO-02 durable favicon job (worker-owned, lease-fenced). */
export interface FaviconJobTable {
  id: string;
  account_id: string;
  owner_subject_id: string;
  operation: 'refresh_one' | 'fill_missing' | 'refresh_online' | 'apply_force_online' | 'restore_sources';
  policy_revision: number;
  status: 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'superseded';
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  error_node_id: string | null;
  error_reason: 'fetch_failed' | 'invalid_image' | 'unsafe_source' | 'stale_policy'
    | 'source_changed' | 'permission_changed' | 'storage_unavailable' | null;
  collection_id: string | null;
  node_id: string | null;
  source_url: string | null;
  source_revision: number | null;
  node_resource_revision: string | null;
  object_id: string | null;
  object_content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/x-icon' | null;
  object_byte_size: number | null;
  object_digest_sha256: Buffer | null;
  attempts: number;
  next_attempt_at: Date | null;
  lease_owner: string | null;
  lease_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** FO-02 durable GC pending-deletion ledger (retention window = deletable_at - retired_at). */
export interface FaviconPendingDeletionTable {
  object_id: string;
  node_id: string;
  collection_id: string;
  retired_at: Date;
  deletable_at: Date;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_until: Date | null;
  created_at: Date;
}

/**
 * FO-03 per-node item ledger of a batch favicon job. Each row carries the
 * async identity the contract requires and its own attempt/backoff state, so
 * a restarted worker resumes at the exact item and a job never re-enqueues a
 * node (PRIMARY KEY (job_id, node_id)).
 */
export interface FaviconJobItemTable {
  job_id: string;
  node_id: string;
  collection_id: string;
  source_url: string;
  source_revision: number;
  node_resource_revision: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  error_reason: 'fetch_failed' | 'invalid_image' | 'unsafe_source' | 'stale_policy'
    | 'source_changed' | 'permission_changed' | 'storage_unavailable' | null;
  attempts: number;
  next_attempt_at: Date | null;
  object_id: string | null;
  object_content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/x-icon' | null;
  object_byte_size: number | null;
  object_digest_sha256: Buffer | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * FO-03 per-node pre-force source state. apply_force_online writes a row for
 * every covered node; the GC reference recheck treats a live row as a hard
 * reference so the original object survives the force window; restore_sources
 * consumes the row and deletes it.
 */
export interface FaviconSourceRestoreTable {
  node_id: string;
  collection_id: string;
  account_id: string;
  original_source_mode: 'inherit' | 'online' | 'uploaded' | 'none';
  original_object_id: string | null;
  original_content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/x-icon' | null;
  original_byte_size: number | null;
  original_digest_sha256: Buffer | null;
  source_revision: number;
  created_at: Date;
  updated_at: Date;
}