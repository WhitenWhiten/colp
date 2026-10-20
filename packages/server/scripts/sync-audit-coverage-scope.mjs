/** Current sync-audit owners. This scope does not import retired phase1-3 files. */
export const SYNC_AUDIT_OWNERS = Object.freeze([
  { path: 'src/modules/sync/sync-bookmark-metadata.ts', kind: 'pure' },
  { path: 'src/infrastructure/sync/sync-conflict-content.ts', kind: 'pure' },
  { path: 'src/infrastructure/sync/sync-conflict-decision.ts', kind: 'pure' },
  { path: 'src/modules/sync/sync-node-update.ts', kind: 'transaction' },
  { path: 'src/modules/sync/sync-node-restore.ts', kind: 'transaction' },
  { path: 'src/infrastructure/sync/sync-conflict-postgres.ts', kind: 'transaction' },
  { path: 'src/infrastructure/sync/sync-conflict-resolution-postgres.ts', kind: 'transaction' },
  { path: 'src/infrastructure/sync/product-sync-center-postgres.ts', kind: 'transaction' },
  { path: 'src/infrastructure/sync/managed-ancestry-policy.ts', kind: 'transaction' },
  { path: 'src/infrastructure/sync/sync-node-restore-postgres.ts', kind: 'transaction' },
  { path: 'src/infrastructure/sync/postgres/sync-push-create-update-postgres.ts', kind: 'transaction' },
  // New transaction logic uses the new-owner policy, not a guessed legacy ratchet.
  { path: 'src/infrastructure/sync/sync-retire-reauthorization-postgres.ts', kind: 'transaction', minimum: 80 },
]);

export const SYNC_AUDIT_UNIT_TESTS = Object.freeze([
  'tests/unit/sync/sync-node-update.test.ts',
  'tests/unit/sync/sync-node-create.test.ts',
  'tests/unit/sync/sync-node-restore.test.ts',
  'tests/unit/sync/sync-bookmark-url-semantics.test.ts',
  'tests/unit/sync/sync-bookmark-metadata-regressions.test.ts',
  'tests/unit/sync/sync-bookmark-metadata-only.test.ts',
  'tests/unit/sync/sync-conflict-content.test.ts',
  'tests/unit/sync/sync-conflict-url-decision.test.ts',
  'tests/unit/sync/sync-conflict-decision.test.ts',
  'tests/unit/sync/sync-conflict-permission-decision.test.ts',
  'tests/unit/sync/sync-conflict-intent-retention.test.ts',
  'tests/unit/sync/sync-conflict-capabilities.test.ts',
  'tests/unit/sync/sync-conflict-resolution.test.ts',
  'tests/unit/sync/sync-conflict-aad.test.ts',
  'tests/unit/collections/managed-ancestry-policy.test.ts',
  'tests/unit/product/product-sync-center-http.test.ts',
  'tests/unit/product/product-sync-center-contract.test.ts',
  'tests/unit/sync/sync-retire-http.test.ts',
]);

export const SYNC_AUDIT_POSTGRES_TESTS = Object.freeze([
  'tests/integration/sync/sync-node-update-postgres.integration.test.ts',
  'tests/integration/sync/sync-conflict-resolution-regressions.integration.test.ts',
  'tests/integration/product/product-sync-center-postgres.integration.test.ts',
  'tests/integration/sync/kns-06-mount-restore-trash-postgres.integration.test.ts',
  'tests/integration/sync/sync-retire-reauthorization-postgres.integration.test.ts',
  'tests/integration/sync/sync-retire-session-liveness-postgres.integration.test.ts',
  'tests/integration/sync/sync-retire-effect-page-http-postgres.integration.test.ts',
]);
export const SYNC_AUDIT_METRICS = Object.freeze(['statements', 'branches', 'functions', 'lines']);
export const SYNC_AUDIT_REPORT_DIRECTORY = 'coverage/sync-audit';
