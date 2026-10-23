/**
 * Exclusive Vitest project ownership lists shared by discovery contracts
 * and TypeScript Vitest configs. Keep path ownership in one executable source
 * so a moved test cannot silently drift between duplicated basename arrays.
 */

/** @type {readonly string[]} */
export const BROWSER_INCLUDE = Object.freeze([
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
  'tests/unit/collections/bookmark-favicon-openapi-contract.test.ts',
  'tests/unit/openapi/openapi-additive-baseline-chain.test.ts',
  'tests/unit/openapi/openapi-additive-baseline-chain-late.test.ts',
  'tests/unit/openapi/openapi-ci-gates-contract.test.ts',
  'tests/unit/openapi/openapi-contract.test.ts',
  'tests/unit/openapi/openapi-schema-examples.test.ts',
  'tests/unit/phase2/phase2-publication-acceptance.test.ts',
  'tests/unit/phase2/phase2-source-identity.test.ts',
  'tests/unit/phase2b/phase2b-acceptance-contract.test.ts',
  'tests/unit/phase4b/phase4b-mcp-compat-real-clients.test.ts',
  'tests/unit/phase4b/phase4b-mcp-protected-resource.test.ts',
]);
