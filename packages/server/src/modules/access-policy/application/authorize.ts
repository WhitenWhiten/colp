import { evaluateAccess } from '../domain/evaluate.js';
import type {
  ActorPrincipal,
  CollectionCapability,
  PolicyDecision,
  ResourcePolicyFacts,
} from '../domain/types.js';
import type { AccessPolicyFactsPort } from './ports.js';

export interface AuthorizeCapabilityInput {
  readonly collectionId: string;
  readonly actor: ActorPrincipal;
  readonly capability: CollectionCapability;
  /**
   * Optional expected policy revision for TOCTOU recheck after collection lock.
   * When provided, merged into loaded facts before evaluation.
   * Mismatch → deny with reasonCategory `policy_revision_mismatch`
   * (callers may map to Product `snapshot_expired` later).
   */
  readonly expectedPolicyRevision?: string;
}

/**
 * Loads authoritative facts via the transaction-bound port and evaluates capability.
 * Collection absence is mapped to conceal / resource_missing (no exception).
 * Coarse transport gates must still re-invoke this inside the write UoW.
 */
export async function authorizeCapability(
  ports: AccessPolicyFactsPort,
  input: AuthorizeCapabilityInput,
): Promise<PolicyDecision> {
  const facts = await ports.loadCollectionFacts({
    collectionId: input.collectionId,
    actorSubjectId: input.actor.subjectId,
  });

  if (!facts) {
    return {
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
      policyRevision: null,
      effectiveRole: null,
    };
  }

  const factsForEval: ResourcePolicyFacts =
    input.expectedPolicyRevision !== undefined
      ? { ...facts, expectedPolicyRevision: input.expectedPolicyRevision }
      : facts;

  return evaluateAccess(factsForEval, input.actor, input.capability);
}
