export type {
  ActorPrincipal,
  CollectionCapability,
  CollectionVisibility,
  MembershipRole,
  PolicyDecision,
  PolicyOutcome,
  PolicyReasonCategory,
  ProductDenial,
  ProductDenialCode,
  ProductDenialRecovery,
  ResourcePolicyFacts,
} from './types.js';

export {
  ALL_COLLECTION_CAPABILITIES,
  CONTENT_MUTATION_CAPABILITIES,
  capabilitiesForRole,
  roleGrantsCapability,
} from './capabilities.js';

export { evaluateAccess, resolveEffectiveRole } from './evaluate.js';
export { toProductDenial } from './concealment.js';
export { AccessPolicyError, CollaborationError, CollaborationPreconditionError, type AccessPolicyErrorCode, type CollaborationErrorCode } from './errors.js';
