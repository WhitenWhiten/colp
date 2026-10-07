/** Membership roles stored on collection_members.role. */
export type MembershipRole = 'owner' | 'editor' | 'viewer';

/** Collection visibility stored on collections.visibility. */
export type CollectionVisibility = 'private' | 'protected' | 'public' | 'unlisted';

/**
 * Closed set of Phase 1 route capabilities.
 * Content mutations = create/update/move/delete node + update collection metadata.
 */
export type CollectionCapability =
  | 'read_editor'
  | 'update_collection_metadata'
  | 'create_node'
  | 'update_node'
  | 'move_node'
  | 'delete_node'
  | 'manage_members'
  | 'manage_publication';

export type PolicyOutcome = 'allow' | 'deny' | 'conceal';

/**
 * Stable low-cardinality reason categories for audit and Product mapping.
 * Callers may map a subset to different Product codes later (e.g. snapshot_expired).
 */
export type PolicyReasonCategory =
  | 'allowed'
  | 'resource_missing'
  | 'not_a_member'
  | 'insufficient_role'
  | 'policy_revision_mismatch';

/**
 * Authenticated actor for authorization.
 * Phase 1 Product uses account subjectId matching collection_members.subject_id
 * and/or collections.owner_subject_id.
 */
export interface ActorPrincipal {
  readonly principalId: string;
  readonly subjectId: string;
  readonly kind: 'account' | 'service';
}

/**
 * Authoritative facts loaded by the caller (or facts port) inside a transaction.
 * The pure evaluator never queries the database.
 *
 * Field semantics (do not conflate):
 * - ownerSubjectId — stable collection ownership (not membership)
 * - membershipRole — revocable ACL grant for actor.subjectId
 * - visibility — collection wire/publication field
 * - policyRevision — fence for authorization/projection TOCTOU
 */
export interface ResourcePolicyFacts {
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly visibility: CollectionVisibility;
  readonly policyRevision: string;
  /** Membership role for actor.subjectId; null when no membership row. */
  readonly membershipRole: MembershipRole | null;
  /** True when collections.deleted_at is set. */
  readonly deleted: boolean;
  /**
   * Optional expected policy revision for TOCTOU recheck after collection row lock.
   * When present and different from policyRevision, evaluation yields deny with
   * reasonCategory `policy_revision_mismatch` (callers may map to snapshot_expired).
   */
  readonly expectedPolicyRevision?: string;
}

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly reasonCategory: PolicyReasonCategory;
  readonly policyRevision: string | null;
  readonly effectiveRole: MembershipRole | null;
}

/** Product-facing denial shape (no Fastify dependency). */
export type ProductDenialCode = 'insufficient_permission' | 'resource_not_found';

export type ProductDenialRecovery = 'user_action' | 'none';

export interface ProductDenial {
  readonly statusCode: 403 | 404;
  readonly code: ProductDenialCode;
  readonly recovery: ProductDenialRecovery;
}
