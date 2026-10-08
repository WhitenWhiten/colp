export * from './replica-postgres.js';
export * from './replica-lifecycle-postgres.js';
export * from './sync-session-postgres.js';
export * from './sync-session-http-postgres.js';
export * from './sync-bootstrap-snapshot-postgres.js';
export * from './sync-sequence-postgres.js';
export * from './sync-push-postgres.js';
export * from './sync-node-tombstone-postgres.js';
export * from './sync-node-restore-postgres.js';
export * from './sync-tombstone-purge-postgres.js';
export * from './postgres/sync-evidence-maintenance-postgres.js';
export * from './sync-conflict-postgres.js';
export * from './sync-conflict-resolution-postgres.js';
export * from './postgres/sync-pull-postgres.js';
export * from './sync-effect-page-postgres.js';
export * from './postgres/sync-ack-postgres.js';
export * from './postgres/sync-recovery-postgres.js';
export {
  isJoseSyncCredentialRevoked,
  type JoseSyncCredentialRevocationQuery,
} from './postgres/sync-jose-credential-revocation-postgres.js';
export * from './sync-retire-postgres.js';
export * from './product-sync-center-postgres.js';
export * from './sync-operations-telemetry-postgres.js';
export { defaultProductionServerBudget, defaultServerTransportBudget } from './sync-transport-budget.js';
export { createSyncPullCursorKeyring, createSyncRecoveryCapabilityKeyring,
  createSyncPullCursorLineageKeyring,
  SyncSessionIssueError, applySyncEvidenceMaintenanceMetrics } from '../../modules/sync/index.js';
// FIX-L-036 (SYNC-R20): the shared lease/retention bounds constants are
// re-exported so bootstrap/config.ts can validate environment limits against
// the single source of truth without importing the sync module facade directly.
export { REPLICA_LEASE_BOUNDS, TOMBSTONE_RETENTION_BOUNDS } from '../../modules/sync/index.js';
// FIX-L-033 (SYNC-R17): the Sync attachment-projection policy port is
// re-exported so composition roots can type their adapter wiring without
// importing the sync module facade directly.
export type { AttachmentExposurePolicyPort } from '../../modules/sync/index.js';
// E2: bootstrap composes the MCP subtree-delete tombstone writer through this surface.
export { recordMcpDeleteSubtreeTombstones } from './mcp-delete-subtree-tombstone-postgres.js';
