/**
 * Phase 4B MCP Read module facade (P4B-R02).
 *
 * Exposes the frozen feature-scoped configuration contract, the read-only
 * Manifest candidate, the route-scoped OAuth verifier that emits token-free
 * credential evidence, and the protected resource metadata contract. Route
 * registration lives in transport; no claim controller is exposed here.
 */
export * from './config.js';
export * from './change-signal-source.js';
export * from './collection-resources.js';
export * from './discovery.js';
export * from './manifest-candidate.js';
export * from './node-resources.js';
export * from './account-context.js';
export * from './oauth-verifier.js';
export * from './scope-requirements.js';
export * from './oauth-revocation-store.js';
export * from './account-security-boundary.js';
export * from './scope-implications.js';
export * from './operations.js';
export * from './protected-resource-metadata.js';
export * from './well-known-discovery.js';
export * from './read-profile-claim-gate.js';
export * from './write-profile-claim-gate.js';
export * from './request-context.js';
export * from './read-cache.js';
export * from './resource-identity.js';
export * from './results.js';
export * from './snapshot-resources.js';
export * from './read-tools.js';
export * from './write-dependency-gate.js';
export * from './change-plan-planner.js';
export * from './change-plan-service.js';
export * from './low-risk-node-create.js';
export * from './low-risk-node-update.js';
export * from './low-risk-collection-update.js';
export * from './low-risk-annotation-tools.js';
export * from './low-risk-change-get.js';
export * from './write-error-classifier.js';
export * from './node-create-catalog.js';
export * from './write-tools.js';
export * from './owned-collection-mcp.js';
export * from './owned-collection-read-mcp.js';
export * from './publication-slug.js';
export * from './set-visibility-revisions.js';
export * from './write-approval-api.js';
export * from './write-operations.js';
export * from './write-maintenance.js';
export * from './mcp-compat-protocol.js';
export * from './mcp-compat-operations.js';
export * from './application-context.js';
export * from './application-catalog.js';
export * from './application-results.js';
export * from './application-ports.js';
export * from './application-facade.js';
// Bootstrap composes the MCP write path with the same default own-data budget
// the direct/plan paths use; re-export the single authority instead of letting
// composition reach into the module internal.
export { MCP_OWN_DATA_DEFAULT_BUDGET } from './own-data.js';
