import type { PolicyDecision, ProductDenial } from './types.js';

/**
 * Maps a PolicyDecision to a Product-facing denial (403/404 codes).
 * Returns null when the decision is allow.
 *
 * Phase 1 mapping:
 * - conceal → 404 resource_not_found (recovery none)
 * - deny → 403 insufficient_permission (recovery user_action)
 *
 * Callers that need specialized Product codes (e.g. snapshot_expired for
 * policy_revision_mismatch) should inspect reasonCategory before using this helper.
 */
export function toProductDenial(decision: PolicyDecision): ProductDenial | null {
  if (decision.outcome === 'allow') return null;

  if (decision.outcome === 'conceal') {
    return {
      statusCode: 404,
      code: 'resource_not_found',
      recovery: 'none',
    };
  }

  return {
    statusCode: 403,
    code: 'insufficient_permission',
    recovery: 'user_action',
  };
}
