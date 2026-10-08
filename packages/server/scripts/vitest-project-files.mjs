/**
 * Exclusive Vitest project ownership lists shared by plain Node shard scripts
 * and TypeScript Vitest configs. Keep path ownership in one executable source
 * so a moved test cannot silently drift between duplicated basename arrays.
 */

/** @type {readonly string[]} */
export const BROWSER_INCLUDE = Object.freeze([
  'tests/unit/phase4a/phase4a-i03-browser-isolation.test.ts',
  'tests/unit/phase4a/phase4a-i11-browser-isolation.test.ts',
  'tests/unit/phase4a/phase4a-i12-browser-projection.test.ts',
  'tests/unit/phase4a/phase4a-i16-browser-delivery.test.ts',
  'tests/unit/phase4a/phase4a-r06-browser-projection.test.ts',
  'tests/unit/phase4a/phase4a-p09-browser-projection.test.ts',
  'tests/integration/phase4a/phase4a-p08-browser-postgres.integration.test.ts',
]);

/** @type {readonly string[]} */
export const REDIS_INCLUDE = Object.freeze([
  'tests/integration/redis/effect-page-admission-security.integration.test.ts',
  'tests/integration/phase4a/phase4a-rl03-redis.integration.test.ts',
  'tests/integration/phase4a/phase4a-rl04-http-redis.integration.test.ts',
  'tests/integration/phase4a/phase4a-rl05-redis-atomicity.integration.test.ts',
  'tests/integration/phase4a/phase4a-rl05-redis-isolation.integration.test.ts',
  'tests/integration/phase4a/phase4a-rl05-redis-failure.integration.test.ts',
  'tests/integration/phase4a/phase4a-rl05-redis-maxmemory.integration.test.ts',
  'tests/integration/phase4a/phase4a-rl06-multi-replica-http-redis.integration.test.ts',
  'tests/integration/phase4a/phase4a-rl06-outage-recovery-http-redis.integration.test.ts',
  'tests/integration/phase4a/phase4a-p09-redis-postgres.integration.test.ts',
  'tests/integration/phase4a/phase4a-p10-recovery-http-redis.integration.test.ts',
  'tests/integration/phase4a/phase4a-p10-pitr-capacity-http-redis.integration.test.ts',
]);

/** @type {readonly string[]} */
export const EVIDENCE_INCLUDE = Object.freeze([
  'tests/unit/phase0/phase0-exit-evidence.test.ts',
  'tests/unit/phase1/phase1-compatibility-evidence.test.ts',
  'tests/unit/phase2/phase2-closeout-contract.test.ts',
  'tests/unit/phase3/phase3-multi-device-recovery-evidence.test.ts',
  'tests/unit/phase3/phase3-sync-http-documentation.test.ts',
  'tests/unit/reading-progress/library-management-acceptance-contract.test.ts',
  'tests/unit/phase5/phase5-evidence-class.test.ts',
  'tests/unit/phase5/phase5-evidence-root.test.ts',
  'tests/unit/phase5/phase5-feed-acceptance-contract.test.ts',
  'tests/unit/phase5/phase5-feed-operations-acceptance-contract.test.ts',
  'tests/unit/phase5/phase5-follow-acceptance-contract.test.ts',
  'tests/unit/phase5/phase5-free-social-acceptance-contract.test.ts',
  'tests/unit/phase5/phase5-free-social-dependencies.test.ts',
  'tests/unit/phase5/phase5-email-acceptance-contract.test.ts',
  'tests/unit/phase5/phase5-notification-acceptance-contract.test.ts',
  'tests/unit/phase5/phase5-notification-operations-acceptance-contract.test.ts',
  'tests/unit/phase5/phase5-real-negative-controls.test.ts',
  'tests/unit/postgres/postgres-evidence-mode.test.ts',
  'tests/unit/sync/sync-evidence-maintenance-config.test.ts',
  'tests/unit/sync/sync-evidence-maintenance-migration-static.test.ts',
  'tests/unit/sync/sync-pull-cursor-evidence-batch.test.ts',
  'tests/integration/phase0/phase0-exit-evidence.integration.test.ts',
  'tests/integration/postgres/postgres-editor-paging-evidence.integration.test.ts',
  'tests/integration/sync/sync-evidence-maintenance-postgres.integration.test.ts',
]);

/** @type {readonly string[]} */
export const SYSTEM_INCLUDE = Object.freeze([
  'tests/unit/auth/better-auth-composition.test.ts',
  'tests/unit/auth/better-auth-fastify-adapter.test.ts',
  'tests/unit/auth/better-auth-no-legacy-import.test.ts',
  'tests/unit/auth/better-auth-oauth-issuer-flag.test.ts',
  'tests/unit/auth/better-auth-routes-postgres.test.ts',
  'tests/unit/auth/browser-auth-transport-better-auth.test.ts',
  'tests/unit/auth/legacy-oidc-deprecation.test.ts',
  'tests/unit/ci/import-dependency-graph.test.ts',
  'tests/unit/ci/integration-shard-contract.test.ts',
  'tests/unit/ci/shard-bucket-contract.test.ts',
  'tests/unit/collections/bookmark-favicon-openapi-contract.test.ts',
  'tests/unit/collections/classification-local-artifacts.test.ts',
  'tests/unit/feed/feed-openapi-contract.test.ts',
  'tests/unit/openapi/openapi-additive-baseline-chain.test.ts',
  'tests/unit/openapi/openapi-additive-baseline-chain-late.test.ts',
  'tests/unit/openapi/openapi-ci-gates-contract.test.ts',
  'tests/unit/openapi/openapi-contract.test.ts',
  'tests/unit/openapi/openapi-schema-examples.test.ts',
  'tests/unit/phase2/phase2-publication-acceptance.test.ts',
  'tests/unit/phase2/phase2-source-identity.test.ts',
  'tests/unit/phase2b/phase2b-acceptance-contract.test.ts',
  'tests/unit/phase4a/phase4a-browser-ci-routing.test.ts',
  'tests/unit/phase4a/phase4a-delivery-url-security-contract.test.ts',
  'tests/unit/phase4a/phase4a-i16-source-binding.test.ts',
  'tests/unit/phase4a/phase4a-p01-contract.test.ts',
  'tests/unit/phase4a/phase4a-p08-failure-detail.test.ts',
  'tests/unit/phase4a/phase4a-r05-source-control-plane.test.ts',
  'tests/unit/phase4a/phase4a-r07-atomic-publish.test.ts',
  'tests/unit/phase4a/phase4a-r07-failure-detail.test.ts',
  'tests/unit/phase4a/phase4a-secret-scan.test.ts',
  'tests/unit/phase4a/phase4a-validator-revision-contract.test.ts',
  'tests/unit/phase4a/phase4a-verification-remediation-contract.test.ts',
  'tests/unit/phase4b/phase4b-mcp-compat-real-clients.test.ts',
  'tests/unit/phase4b/phase4b-mcp-protected-resource.test.ts',
  'tests/unit/phase5/phase5-free-social-contract.test.ts',
  'tests/unit/phase5/phase5-remediation-contract.test.ts',
  'tests/unit/phase5/phase5-social-event-contract.test.ts',
]);

/**
 * PostgreSQL integration files whose ONLY owner is a dedicated acceptance,
 * coverage or evidence job — they are neither in a Vitest project include list
 * nor in a default shard. Named and enumerable on purpose: a dedicated owner is
 * a routing fact a contract can point at, not an anonymous exclusion spliced
 * into a larger list.
 *
 * @type {readonly string[]}
 */
export const DEDICATED_JOB_INTEGRATION_OWNERS = Object.freeze([
  'tests/integration/phase2/phase2-profile-conformance.integration.test.ts',
  'tests/integration/phase2/phase2-publication-acceptance.integration.test.ts',
  'tests/integration/product/product-command-receipt.integration.test.ts',
  'tests/integration/search/search-postgres-baseline.integration.test.ts',
  'tests/integration/search/search-product-http-postgres.integration.test.ts',
  'tests/integration/search/search-profile-annotation-plan.integration.test.ts',
  'tests/integration/search/search-profile-annotation-postgres.integration.test.ts',
  'tests/integration/reading-progress/reading-progress-commands-postgres.integration.test.ts',
  'tests/integration/reading-progress/reading-progress-migration-postgres.integration.test.ts',
  'tests/integration/reading-progress/reading-progress-product-http-postgres.integration.test.ts',
  'tests/integration/reading-progress/reading-progress-query-postgres.integration.test.ts',
  'tests/integration/reading-progress/saved-resource-commands-postgres.integration.test.ts',
  'tests/integration/reading-progress/saved-resource-migration-postgres.integration.test.ts',
  'tests/integration/reading-progress/saved-resource-product-http-postgres.integration.test.ts',
  'tests/integration/reading-progress/saved-resource-query-postgres.integration.test.ts',
  'tests/integration/phase2/phase2-publication-redis-evidence.integration.test.ts',
]);

/**
 * PostgreSQL integration files with a named owner outside the default shards.
 * Capability-owned browser/evidence/Redis files are composed from the project
 * lists above; the remaining files have dedicated acceptance or coverage jobs.
 * Use full paths so two domains can never exclude each other by basename.
 *
 * @type {readonly string[]}
 */
export const INTEGRATION_SHARD_EXCLUDE = Object.freeze([
  ...EVIDENCE_INCLUDE.filter((file) => file.startsWith('tests/integration/')),
  ...BROWSER_INCLUDE.filter((file) => file.startsWith('tests/integration/')),
  ...REDIS_INCLUDE,
  ...DEDICATED_JOB_INTEGRATION_OWNERS,
]);
