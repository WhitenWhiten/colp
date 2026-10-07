/**
 * Per-file floors retired from the BT-07 grandfathered snapshot after reviewed
 * 2026-09-01 unit/PostgreSQL measurements. Each value is the observed
 * percentage minus the baseline's two-point instrumentation cushion (100%
 * observations use the repository-wide 97.5% ceiling).
 *
 * These files must remain explicit overrides: the generic new-file floor is
 * only 40/15/25/40 and would silently weaken the measured Publisher, Sync and
 * Bootstrap composition evidence if an entry were removed from this map.
 */
export const PHASE_1_3_MEASURED_FILE_COVERAGE_OVERRIDES = Object.freeze({
  'src/bootstrap/api-account-services.ts': {
    lines: 91.38, branches: 73, functions: 97.5, statements: 91.38,
  },
  'src/bootstrap/api-attachments-composition.ts': {
    lines: 65.28, branches: 68.83, functions: 33.71, statements: 65.28,
  },
  'src/bootstrap/api-auth-mailbox.ts': {
    lines: 97.5, branches: 91.75, functions: 97.5, statements: 97.5,
  },
  'src/bootstrap/api-email-composition.ts': {
    lines: 67.52, branches: 43.45, functions: 31.33, statements: 67.52,
  },
  'src/bootstrap/api-lifecycle.ts': {
    lines: 90.3, branches: 90.1, functions: 97.5, statements: 90.3,
  },
  'src/bootstrap/api-mcp-oauth-composition.ts': {
    lines: 95.46, branches: 93.45, functions: 97.5, statements: 95.46,
  },
  'src/bootstrap/api-mcp-surface-composition.ts': {
    lines: 76.53, branches: 66.88, functions: 26.57, statements: 76.53,
  },
  'src/bootstrap/api-postgres-ports.ts': {
    lines: 51.6, branches: 82.61, functions: 73, statements: 51.6,
  },
  'src/bootstrap/api-rate-limit-composition.ts': {
    lines: 44.55, branches: 21.8, functions: 97.5, statements: 44.55,
  },
  'src/bootstrap/delivery-main.ts': {
    lines: 48.86, branches: 50.23, functions: 75.77, statements: 48.86,
  },
  'src/bootstrap/sync-session-runtime.ts': {
    lines: 76.33, branches: 51.84, functions: 48, statements: 76.33,
  },
  'src/bootstrap/attachments-delivery-composition.ts': {
    lines: 94.42, branches: 41.75, functions: 97.5, statements: 94.42,
  },
  'src/bootstrap/attachments-object-storage-composition.ts': {
    lines: 97.5, branches: 97.5, functions: 97.5, statements: 97.5,
  },
  'src/bootstrap/attachments-rate-limit-composition.ts': {
    lines: 78.43, branches: 65.85, functions: 83.71, statements: 78.43,
  },
  'src/bootstrap/attachments-worker-composition.ts': {
    lines: 92.17, branches: 78.48, functions: 92.11, statements: 92.17,
  },
  'src/bootstrap/cache-composition.ts': {
    lines: 88.24, branches: 81.54, functions: 97.5, statements: 88.24,
  },
  'src/bootstrap/composition.ts': {
    lines: 90.95, branches: 84.36, functions: 97.5, statements: 90.95,
  },
  'src/bootstrap/delivery.ts': {
    lines: 84.89, branches: 69.42, functions: 88.9, statements: 84.89,
  },
  'src/bootstrap/mcp-write-composition.ts': {
    lines: 91.38, branches: 86.54, functions: 76.72, statements: 91.38,
  },
  'src/bootstrap/public-profile-projection.ts': {
    lines: 89.37, branches: 80.35, functions: 97.5, statements: 89.37,
  },
  'src/infrastructure/publisher/canonical-unit-of-work.ts': {
    lines: 97.5, branches: 97.5, functions: 97.5, statements: 97.5,
  },
  'src/infrastructure/publisher/postgres-idempotency.ts': {
    lines: 70.3, branches: 50.17, functions: 85.5, statements: 70.3,
  },
  'src/infrastructure/sync/managed-ancestry-policy.ts': {
    lines: 97.5, branches: 83.71, functions: 97.5, statements: 97.5,
  },
  'src/infrastructure/sync/postgres/sync-ack-postgres.ts': {
    lines: 95.86, branches: 79.76, functions: 97.5, statements: 95.86,
  },
  'src/infrastructure/sync/postgres/sync-evidence-maintenance-postgres.ts': {
    lines: 88.19, branches: 90.18, functions: 97.5, statements: 88.19,
  },
  'src/infrastructure/sync/postgres/sync-pull-postgres.ts': {
    lines: 89.39, branches: 78.95, functions: 82.61, statements: 89.39,
  },
  'src/infrastructure/sync/postgres/sync-recovery-postgres.ts': {
    lines: 93.95, branches: 79.63, functions: 97.5, statements: 93.95,
  },
  'src/infrastructure/sync/product-sync-center-postgres.ts': {
    lines: 92.61, branches: 74.92, functions: 83.71, statements: 92.61,
  },
  'src/infrastructure/sync/replica-lifecycle-postgres.ts': {
    lines: 89.34, branches: 78.7, functions: 84.66, statements: 89.34,
  },
  'src/infrastructure/sync/replica-postgres.ts': {
    lines: 95.9, branches: 83.91, functions: 83, statements: 95.9,
  },
  'src/infrastructure/sync/sync-bootstrap-snapshot-postgres.ts': {
    lines: 86.33, branches: 67.64, functions: 88.47, statements: 86.33,
  },
  'src/infrastructure/sync/sync-effect-page-postgres.ts': {
    lines: 91.65, branches: 85.09, functions: 97.5, statements: 91.65,
  },
  'src/infrastructure/sync/sync-node-tombstone-postgres.ts': {
    lines: 93.55, branches: 88, functions: 97.5, statements: 93.55,
  },
  'src/infrastructure/sync/sync-operation-effects-postgres.ts': {
    lines: 88.64, branches: 75.57, functions: 97.5, statements: 88.64,
  },
  'src/infrastructure/sync/sync-operations-telemetry-postgres.ts': {
    lines: 96.19, branches: 88.62, functions: 97.5, statements: 96.19,
  },
  'src/infrastructure/sync/sync-retire-postgres.ts': {
    lines: 92.7, branches: 85.34, functions: 97.5, statements: 92.7,
  },
  'src/infrastructure/sync/sync-session-http-postgres.ts': {
    lines: 93.02, branches: 68.12, functions: 97.5, statements: 93.02,
  },
  'src/infrastructure/sync/sync-session-postgres.ts': {
    lines: 97.5, branches: 97.5, functions: 97.5, statements: 97.5,
  },
  'src/infrastructure/sync/sync-tombstone-purge-postgres.ts': {
    lines: 90.98, branches: 69.95, functions: 84.66, statements: 90.98,
  },
  'src/infrastructure/sync/sync-push-postgres.ts': {
    lines: 97.5, branches: 93.65, functions: 97.5, statements: 97.5,
  },
  'src/infrastructure/sync/sync-sequence-postgres.ts': {
    lines: 94.26, branches: 77.88, functions: 97.5, statements: 94.26,
  },
  'src/infrastructure/sync/sync-conflict-postgres.ts': {
    lines: 91.53, branches: 78.62, functions: 83, statements: 91.53,
  },
  'src/infrastructure/sync/sync-conflict-resolution-postgres.ts': {
    lines: 94.86, branches: 71.33, functions: 94.15, statements: 94.86,
  },
  'src/modules/sync/sync-route-authority.ts': {
    lines: 88.47, branches: 88, functions: 97.5, statements: 88.47,
  },
  'src/modules/sync/sync-session.ts': {
    lines: 89.94, branches: 78.26, functions: 91.75, statements: 89.94,
  },
  'src/modules/sync/sync-sequence.ts': {
    lines: 95.36, branches: 84.66, functions: 97.5, statements: 95.36,
  },
  'src/modules/sync/sync-conflict-resolution.ts': {
    lines: 96.29, branches: 87.28, functions: 97.5, statements: 96.29,
  },
} as const);
