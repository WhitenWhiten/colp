import { roleGrantsCapability } from './capabilities.js';
import type {
  ActorPrincipal,
  CollectionCapability,
  MembershipRole,
  PolicyDecision,
  ResourcePolicyFacts,
} from './types.js';

/**
 * Resolves the effective membership role for an actor.
 *
 * Ownership (`owner_subject_id`) is distinct from revocable membership:
 * - Matching owner subject always resolves to owner (bootstrap / ownership defense),
 *   even when no membership row exists or a stale lower role row is present.
 * - Otherwise the explicit membership role is used (null → non-member).
 */
export function resolveEffectiveRole(
  facts: ResourcePolicyFacts,
  actor: ActorPrincipal,
): MembershipRole | null {
  if (actor.subjectId === facts.ownerSubjectId) {
    return 'owner';
  }
  return facts.membershipRole;
}

/**
 * Pure policy facts evaluator. Never queries the database.
 *
 * Order:
 * 1. Soft-deleted collection → conceal (resource_missing)
 * 2. No effective role → conceal (private/protected/unlisted) or deny (public)
 * 3. expectedPolicyRevision mismatch → deny (policy_revision_mismatch)
 * 4. Role lacks capability → deny (insufficient_role)
 * 5. allow
 *
 * Product editor capabilities always require effective membership or matching
 * owner_subject. Visibility `public` alone never grants editor capabilities;
 * public non-members receive deny (403), not conceal.
 */
export function evaluateAccess(
  facts: ResourcePolicyFacts,
  actor: ActorPrincipal,
  capability: CollectionCapability,
): PolicyDecision {
  if (facts.deleted) {
    return {
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
      policyRevision: facts.policyRevision,
      effectiveRole: null,
    };
  }

  const effectiveRole = resolveEffectiveRole(facts, actor);

  if (effectiveRole === null) {
    // private/protected/unlisted: hide existence for non-members.
    // public: existence may be known → deny (still no editor capability).
    const concealExistence =
      facts.visibility === 'private'
      || facts.visibility === 'protected'
      || facts.visibility === 'unlisted';
    return {
      outcome: concealExistence ? 'conceal' : 'deny',
      reasonCategory: 'not_a_member',
      policyRevision: facts.policyRevision,
      effectiveRole: null,
    };
  }

  if (
    facts.expectedPolicyRevision !== undefined
    && facts.expectedPolicyRevision !== facts.policyRevision
  ) {
    return {
      outcome: 'deny',
      reasonCategory: 'policy_revision_mismatch',
      policyRevision: facts.policyRevision,
      effectiveRole,
    };
  }

  if (!roleGrantsCapability(effectiveRole, capability)) {
    return {
      outcome: 'deny',
      reasonCategory: 'insufficient_role',
      policyRevision: facts.policyRevision,
      effectiveRole,
    };
  }

  return {
    outcome: 'allow',
    reasonCategory: 'allowed',
    policyRevision: facts.policyRevision,
    effectiveRole,
  };
}
