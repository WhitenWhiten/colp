/**
 * Constants still imported by the phase-4a expand migrations.
 * The attachments module is otherwise gone; snapshots stay empty.
 */

export const ATTACHMENTS_CONSTRAINT_NAMES = {
  generationKeysPkey: 'generation_keys_pkey',
  generationKeysKeyUnique: 'generation_keys_key_unique',
  generationKeysFingerprintUnique: 'generation_keys_key_fingerprint_unique',
  generationKeysReasonCheck: 'generation_keys_created_reason_check',
  blobRecordsLogicalStateCheck: 'blob_records_logical_state_check',
  blobRecordsVerifiedFactsCheck: 'blob_records_verified_facts_check',
  blobRecordsCurrentGenerationFk: 'blob_records_current_generation_fk',
  blobGenerationsStateCheck: 'blob_generations_generation_state_check',
  blobGenerationsDeletedFactsCheck: 'blob_generations_deleted_facts_check',
  blobGenerationsCorruptFactsCheck: 'blob_generations_contract_corrupt_facts_check',
  blobGenerationsQuarantineFactsCheck: 'blob_generations_quarantine_facts_check',
  blobGenerationsBlobFk: 'blob_generations_blob_fk',
  blobGenerationsGenerationKeyFk: 'blob_generations_generation_key_fk',
  blobGenerationsBlobGenerationUnique: 'blob_generations_blob_generation_unique',
  blobGenerationsKeyUnique: 'blob_generations_key_unique',
  blobGenerationsKeyFingerprintUnique: 'blob_generations_key_fingerprint_unique',
  blobGenerationsMetadataAllowlistCheck: 'blob_generations_metadata_allowlist_check',
  blobGenerationsMetadataShapeCheck: 'blob_generations_metadata_shape_check',
  blobGenerationsOneActivePerBlob: 'blob_generations_one_active_per_blob',
  uploadIntentsGenerationUnique: 'upload_intents_generation_id_unique',
  uploadIntentsBlobFk: 'upload_intents_blob_fk',
  uploadIntentsGenerationFk: 'upload_intents_generation_fk',
  uploadIntentsIdempotencyUnique: 'upload_intents_blob_idempotency_unique',
  blobRecordsAttachmentBindingUnique: 'blob_records_attachment_binding_id_unique',
  blobRecordsAttachedBindingFactsCheck: 'blob_records_attached_binding_facts_check',
  blobRecordsAttachedBindingGenerationCheck: 'blob_records_attached_binding_generation_check',
  attachmentsLogicalStateCheck: 'attachments_logical_state_check',
  attachmentsSizeCheck: 'attachments_size_check',
  attachmentsSanitizedFilenameCheck: 'attachments_sanitized_filename_check',
  attachmentsRetirementFactsCheck: 'attachments_retirement_facts_check',
  attachmentsDeletionFactsCheck: 'attachments_deletion_facts_check',
  attachmentsActiveStateFactsCheck: 'attachments_active_state_facts_check',
  attachmentsLedgerFk: 'attachments_attachment_id_fk',
  attachmentsBlobFk: 'attachments_blob_id_fk',
  attachmentsCollectionFk: 'attachments_collection_id_fk',
  attachmentsBlobUnique: 'attachments_blob_id_unique',
} as const;

export const ALLOWED_OBSERVED_METADATA_KEYS: readonly string[] = Object.freeze(['probe', 'nonce']);
