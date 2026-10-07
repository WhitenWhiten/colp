import { CanonicalMutationInvariantError, type CanonicalMutationInput } from '../../modules/collections/index.js';
import type { CanonicalMutationAction, CanonicalMutationPlan } from '../../modules/collections/index.js';
import type { SidecarUpdateFacts } from './canonical-sidecar-mutation-postgres.js';

export interface CascadedAnnotationRow {
  readonly id: string;
  readonly collection_id: string;
  readonly subject_type: 'collection' | 'node';
  readonly subject_id: string;
  readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
  readonly resource_revision: string;
  readonly payload_json: Record<string, unknown>;
}

export interface CascadedAnnotationPlan extends CascadedAnnotationRow {
  readonly revision: string;
  readonly deletedAt: Date;
}

export interface CascadedRelationRow {
  readonly id: string;
  readonly collection_id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
  readonly resource_revision: string;
  readonly payload_json: Record<string, unknown>;
}

export interface CascadedRelationPlan extends CascadedRelationRow {
  readonly revision: string;
  readonly deletedAt: Date;
}


interface CascadeFacts {
  readonly annotations: readonly CascadedAnnotationPlan[];
  readonly relations: readonly CascadedRelationPlan[];
}
/** The complete, immutable transaction execution plan, selected once by the planner. */
export type PostgresCanonicalPlanFacts = CascadeFacts & (
  | { readonly resourceKind: 'collection'; readonly action: 'update' }
  | { readonly resourceKind: 'node'; readonly action: CanonicalMutationAction; readonly restoredPositionToken?: string; readonly consumedDeleteOperationId?: string }
  | { readonly resourceKind: 'annotation' | 'relation'; readonly action: 'create' | 'update' | 'delete'; readonly updateFacts?: SidecarUpdateFacts }
);

export function postgresPlanFacts(plan: CanonicalMutationPlan<PostgresCanonicalPlanFacts> | undefined): PostgresCanonicalPlanFacts {
  if (!plan?.facts) throw new Error('PostgreSQL canonical stage requires its explicit planner result');
  return plan.facts;
}

export type ResourceKind = 'collection' | 'node' | 'annotation' | 'relation';
export function resourceKind(input: CanonicalMutationInput): ResourceKind {
  const kind = input.mutation.target.resourceKind;
  if (kind !== 'collection' && kind !== 'node' && kind !== 'annotation' && kind !== 'relation') {
    throw new CanonicalMutationInvariantError('invalid_canonical_mutation', `unsupported canonical resource kind: ${kind}`);
  }
  return kind;
}
