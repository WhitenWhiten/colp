export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type CanonicalMutationAction = 'create' | 'update' | 'move' | 'delete' | 'restore';

export interface ResourceIdentity {
  readonly collectionId: string;
  readonly resourceId: string;
  readonly resourceKind: string;
}

/**
 * Caller-supplied resource data. Relational identity, graph, ordering and
 * revision fields are deliberately absent and are rebuilt by the write port.
 */
export interface ResourceOwnedFields {
  readonly kindFields: JsonObject;
  readonly extensions: JsonObject;
}

export interface RelativePosition {
  readonly afterId?: string;
  readonly beforeId?: string;
}

export interface RevisionEffects {
  readonly resource: boolean;
  readonly content: boolean;
  readonly policy: boolean;
  readonly childrenOf: readonly string[];
}

/** Admission intent for a canonical soft delete. Membership remains planner-owned. */
export interface CanonicalDeleteIntent {
  readonly scope: 'single' | 'subtree';
  readonly expectedContentRevision?: string;
}

/** Authoritative, transaction-bound delete membership selected by the planner. */
export interface CanonicalDeletePlan {
  /** Descendants are ordered before ancestors; the admitted target is last. */
  readonly orderedResourceIds: readonly string[];
}

export interface CanonicalResourceMutation {
  readonly action: CanonicalMutationAction;
  readonly target: ResourceIdentity;
  readonly parentId: string | null;
  readonly relativePosition?: RelativePosition;
  readonly fields?: ResourceOwnedFields;
  readonly expectedResourceRevision?: string;
  readonly deleteIntent?: CanonicalDeleteIntent;
  /** Transaction-local server facts required by a resource adapter, never caller DTO fields or event payload. */
  readonly trustedFacts?: JsonObject;
}

/**
 * Transaction-bound canonical plan produced from authoritative locked facts.
 * Admission callers cannot choose revision effects or the persisted position.
 */
export interface CanonicalPlannedResourceMutation extends CanonicalResourceMutation {
  readonly relativePosition?: RelativePosition;
  readonly revisionEffects: RevisionEffects;
  readonly deletePlan?: CanonicalDeletePlan;
}

export interface CanonicalMutationPlan<PlanFacts = unknown> {
  /** Immutable adapter execution facts, carried explicitly through every phase. */
  readonly facts?: PlanFacts;
  readonly operationId: string;
  readonly collectionId: string;
  readonly mutation: CanonicalPlannedResourceMutation;
}

export interface MutationActor {
  readonly principalId: string;
  readonly principalType: string;
}

export interface CanonicalMutationInput {
  /** The admission/coordinator is the sole owner of this identifier. */
  readonly operationId: string;
  readonly collectionId: string;
  readonly actor: MutationActor;
  readonly mutation: CanonicalResourceMutation;
  /** Infrastructure-owned public Sync projection, persisted atomically with the Operation payload. */
  readonly operationSyncWire?: JsonObject;
}

export interface AllocatedMutationState {
  readonly commitOrdinal: bigint;
  readonly resourceRevision?: string;
  /** Initial children revision allocated for a newly-created node. */
  readonly createdNodeChildrenRevision?: string;
  readonly contentRevision?: string;
  readonly policyRevision?: string;
  readonly childrenRevisions: Readonly<Record<string, string>>;
  readonly positionToken?: string;
  /** Bounded sibling window rewritten when the requested position gap is exhausted. */
  readonly rebalanceBoundaryTokens?: readonly string[];
  readonly rebalancedSiblings?: readonly {
    readonly resourceId: string;
    readonly positionToken: string;
    readonly resourceRevision: string;
  }[];
  /** One tombstone revision per planned deleted resource. */
  readonly deletedResourceRevisions?: Readonly<Record<string, string>>;
}

export interface CanonicalMutationResult {
  readonly operationId: string;
  readonly collectionId: string;
  readonly resourceId: string;
  readonly action: CanonicalMutationAction;
  readonly allocation: AllocatedMutationState;
}

export class CanonicalMutationInvariantError extends Error {
  readonly code: 'invalid_canonical_mutation' | 'resource_field_authority_violation';

  constructor(
    code: CanonicalMutationInvariantError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalMutationInvariantError';
    this.code = code;
  }
}
