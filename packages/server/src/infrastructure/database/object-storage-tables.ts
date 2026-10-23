
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
