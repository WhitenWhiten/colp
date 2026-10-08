/**
 * Publisher module — application admission harness only (P1-11).
 *
 * Owns `publisher_idempotency` namespace claim + exact replay envelope.
 * Calls shared collections write / Canonical Mutation paths; does not mount
 * HTTP routes, Manifest Profile, Sync/MCP/Admin placeholders, or Product
 * command receipts (`product_command_receipts`).
 */
export {
  PRODUCT_COMMAND_RECEIPT_TABLE,
  PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE,
  PUBLISHER_IDEMPOTENCY_TABLE,
  PUBLISHER_MIN_REPLAY_WINDOW_SECONDS,
  PUBLISHER_INTERNAL_RESULT_MEDIA_TYPE,
  PUBLISHER_INTERNAL_RESULT_SCHEMA_VERSION,
  PUBLISHER_PRINCIPAL_TYPE,
  admitPublisherMutation,
  adaptPublisherIdempotencyAsProductReceipts,
  buildPublisherProductIsolationProbe,
  createMemoryPublisherIdempotencyPort,
  executePublisherCanonicalMutation,
  executePublisherCanonicalMutationHarness,
  projectPublisherInternalResult,
  publisherCanonicalJson,
  publisherMutationFingerprint,
  publisherProductReceiptIsolationContract,
  schedulePublisherReceiptPurge,
  runPublisherCreateOwnedCollectionHarness,
  type AdmitPublisherMutationInput,
  type AdmitPublisherMutationResult,
  type BuildIsolationCollisionProbeInput,
  type ExecutePublisherCanonicalMutationInput,
  type ExecutePublisherCanonicalMutationResult,
  type MemoryPublisherReceipt,
  type PublisherAsProductReceiptOptions,
  type PublisherCanonicalMutationHarnessPorts,
  type PublisherCreateOwnedCollectionHarnessInput,
  type PublisherCreateOwnedCollectionHarnessPorts,
  type PublisherIdempotencyBinding,
  type PublisherIdempotencyClaim,
  type PublisherIdempotencyPort,
  type PublisherIdempotencyPortFactory,
  type PublisherReceiptMaintenancePort,
  type PublisherReceiptMaintenancePortFactory,
  type PublisherReceiptPurgeSchedule,
  type PublisherInternalResultContract,
  type PublisherProductIsolationProbe,
  type PublisherStoredResult,
} from './application/index.js';
