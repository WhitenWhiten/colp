import { isOpaqueId } from '../shared/resource-identity.js';

export const DEFAULT_MAX_PARENT_ANCESTRY_DEPTH = 256;
export const MAX_PARENT_ANCESTRY_DEPTH = 4_096;

export type NodeParentMutation =
  | {
      readonly kind: 'create-node';
      readonly nodeId: string;
      readonly collectionId: string;
      readonly parentId: string | null;
    }
  | {
      readonly kind: 'reparent-node' | 'move-node' | 'restore-node';
      readonly nodeId: string;
      readonly parentId: string | null;
    };

export interface ParentCycleCollectionIdentity {
  readonly id: string;
}

export interface ParentCycleNodeIdentity {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string | null;
}

/**
 * Reads authoritative state from the transaction or locked snapshot that will
 * perform the mutation. Restorable Nodes must be resolvable by `resolveNode`.
 */
export interface ParentCycleResolver {
  resolveCollection(collectionId: string): Promise<ParentCycleCollectionIdentity | undefined>;
  resolveNode(nodeId: string): Promise<ParentCycleNodeIdentity | undefined>;
}

export interface ParentCycleGuardOptions {
  readonly maxDepth?: number;
}

export type ParentCycleDenialCode =
  | 'parent_cycle'
  | 'parent_ancestry_cycle'
  | 'parent_ancestry_unresolved'
  | 'parent_ancestry_malformed'
  | 'parent_collection_mismatch'
  | 'parent_ancestry_too_deep'
  | 'node_already_exists'
  | 'node_unresolved'
  | 'collection_unresolved';

export interface ParentCycleDenial {
  readonly allowed: false;
  readonly code: ParentCycleDenialCode;
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly collectionId?: string;
  readonly atNodeId?: string;
  readonly ancestry?: readonly string[];
  readonly reason: string;
}

export type ParentCycleGuardResult =
  | {
      readonly allowed: true;
      readonly nodeId: string;
      readonly parentId: string | null;
      readonly collectionId: string;
    }
  | ParentCycleDenial;

export interface ParentCycleUnitOfWork<Context extends ParentCycleResolver> {
  /** Commit only if the callback resolves; its Context must own all guard reads and the write. */
  run<Result>(work: (context: Context) => Promise<Result>): Promise<Result>;
}

export type ParentCyclePersistenceWriter<Context extends ParentCycleResolver, Result> = (
  context: Context,
  mutation: NodeParentMutation,
  guardResult: Extract<ParentCycleGuardResult, { readonly allowed: true }>,
) => Promise<Result>;

export class ParentCycleGuardError extends Error {
  readonly denial: ParentCycleDenial;

  constructor(denial: ParentCycleDenial) {
    super(denial.reason);
    this.name = 'ParentCycleGuardError';
    this.denial = denial;
  }
}

/** Evaluate a proposed parent edge against authoritative transaction-local ancestry. */
export async function evaluateParentCycleGuard(
  mutation: NodeParentMutation,
  resolver: ParentCycleResolver,
  options: ParentCycleGuardOptions = {},
): Promise<ParentCycleGuardResult> {
  mutation = snapshotMutation(mutation);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PARENT_ANCESTRY_DEPTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_PARENT_ANCESTRY_DEPTH) {
    throw new RangeError(
      `Parent ancestry maxDepth must be a positive safe integer no greater than ${MAX_PARENT_ANCESTRY_DEPTH}.`,
    );
  }
  if (!validId(mutation.nodeId) || !validParentId(mutation.parentId)) {
    return denial(mutation, 'parent_ancestry_malformed', 'The proposed Node or Parent identity is malformed.');
  }

  let collectionId: string;
  if (mutation.kind === 'create-node') {
    if (!validId(mutation.collectionId)) {
      return denial(mutation, 'parent_ancestry_malformed', 'The proposed Collection identity is malformed.');
    }
    const collection = await requirePromise(
      resolver.resolveCollection(mutation.collectionId),
      'Parent cycle Collection resolver',
    );
    if (!validCollectionIdentity(collection, mutation.collectionId)) {
      return denial(mutation, 'collection_unresolved', 'The authoritative Collection identity could not be resolved.');
    }
    const collision = await requirePromise(
      resolver.resolveNode(mutation.nodeId),
      'Parent cycle Node resolver',
    );
    if (collision !== undefined) {
      return denial(mutation, 'node_already_exists', 'The proposed Node identity already exists.', {
        collectionId: mutation.collectionId,
        atNodeId: mutation.nodeId,
      });
    }
    collectionId = mutation.collectionId;
  } else {
    const authoritativeNode = await requirePromise(
      resolver.resolveNode(mutation.nodeId),
      'Parent cycle Node resolver',
    );
    if (!validNodeIdentity(authoritativeNode, mutation.nodeId)) {
      return denial(mutation, authoritativeNode === undefined ? 'node_unresolved' : 'parent_ancestry_malformed',
        authoritativeNode === undefined
          ? 'The authoritative Node identity could not be resolved.'
          : 'The authoritative Node identity or ancestry is malformed.');
    }
    collectionId = authoritativeNode.collectionId;
    const collection = await requirePromise(
      resolver.resolveCollection(collectionId),
      'Parent cycle Collection resolver',
    );
    if (!validCollectionIdentity(collection, collectionId)) {
      return denial(mutation, 'collection_unresolved', 'The authoritative Collection identity could not be resolved.', {
        collectionId,
      });
    }
  }

  if (mutation.parentId === null) {
    return Object.freeze({ allowed: true, nodeId: mutation.nodeId, parentId: null, collectionId });
  }

  const ancestry = [mutation.nodeId];
  const visited = new Map<string, number>();
  let currentId = mutation.parentId;
  for (let depth = 0; ; depth += 1) {
    ancestry.push(currentId);
    if (currentId === mutation.nodeId) {
      return denial(mutation, 'parent_cycle', 'The proposed parent relationship would create a cycle.', {
        collectionId,
        atNodeId: currentId,
        ancestry,
      });
    }
    const previousIndex = visited.get(currentId);
    if (previousIndex !== undefined) {
      return denial(mutation, 'parent_ancestry_cycle', 'The authoritative parent ancestry already contains a cycle.', {
        collectionId,
        atNodeId: currentId,
        ancestry: ancestry.slice(previousIndex),
      });
    }
    visited.set(currentId, ancestry.length - 1);
    if (depth >= maxDepth) {
      return denial(mutation, 'parent_ancestry_too_deep', 'The authoritative parent ancestry exceeds the configured traversal bound.', {
        collectionId,
        atNodeId: currentId,
      });
    }

    const current = await requirePromise(
      resolver.resolveNode(currentId),
      'Parent cycle Node resolver',
    );
    if (current === undefined) {
      return denial(mutation, 'parent_ancestry_unresolved', 'The complete authoritative parent ancestry could not be resolved.', {
        collectionId,
        atNodeId: currentId,
      });
    }
    if (!validNodeIdentity(current, currentId)) {
      return denial(mutation, 'parent_ancestry_malformed', 'The authoritative parent ancestry is malformed.', {
        collectionId,
        atNodeId: currentId,
      });
    }
    if (current.collectionId !== collectionId) {
      return denial(mutation, 'parent_collection_mismatch', 'The proposed Parent belongs to another Collection.', {
        collectionId,
        atNodeId: currentId,
      });
    }
    if (current.parentId === null) {
      return Object.freeze({
        allowed: true,
        nodeId: mutation.nodeId,
        parentId: mutation.parentId,
        collectionId,
      });
    }
    currentId = current.parentId;
  }
}

/**
 * Run the guard and persistence in one unit of work. This is suitable as the
 * persistence callback supplied to `executeValidatedWrite`.
 */
export async function executeParentCycleGuardedWrite<
  Context extends ParentCycleResolver,
  Result,
>(
  mutation: NodeParentMutation,
  unitOfWork: ParentCycleUnitOfWork<Context>,
  write: ParentCyclePersistenceWriter<Context, Result>,
  options: ParentCycleGuardOptions = {},
): Promise<Result> {
  mutation = snapshotMutation(mutation);
  const maxDepth = options.maxDepth;
  const guardOptions: ParentCycleGuardOptions = maxDepth === undefined
    ? Object.freeze({})
    : Object.freeze({ maxDepth });
  return requirePromise(unitOfWork.run(async (context) => {
    const result = await evaluateParentCycleGuard(mutation, context, guardOptions);
    if (!result.allowed) throw new ParentCycleGuardError(result);
    return requirePromise(write(context, mutation, result), 'Parent cycle persistence writer');
  }), 'Parent cycle unit of work');
}

function validId(value: unknown): value is string {
  return isOpaqueId(value);
}

function snapshotMutation(mutation: NodeParentMutation): NodeParentMutation {
  switch (mutation.kind) {
    case 'create-node':
      return Object.freeze({
        kind: mutation.kind,
        nodeId: mutation.nodeId,
        collectionId: mutation.collectionId,
        parentId: mutation.parentId,
      });
    case 'reparent-node':
    case 'move-node':
    case 'restore-node':
      return Object.freeze({
        kind: mutation.kind,
        nodeId: mutation.nodeId,
        parentId: mutation.parentId,
      });
    default:
      throw new TypeError('Unknown Node parent mutation kind.');
  }
}

function validParentId(value: unknown): value is string | null {
  return value === null || validId(value);
}

function validCollectionIdentity(
  value: ParentCycleCollectionIdentity | undefined,
  expectedId: string,
): value is ParentCycleCollectionIdentity {
  return value !== undefined && validId(value.id) && value.id === expectedId;
}

function validNodeIdentity(
  value: ParentCycleNodeIdentity | undefined,
  expectedId: string,
): value is ParentCycleNodeIdentity {
  return value !== undefined
    && value.id === expectedId
    && validId(value.id)
    && validId(value.collectionId)
    && validParentId(value.parentId);
}

function requirePromise<Result>(candidate: Promise<Result>, source: string): Promise<Result> {
  if (!(candidate instanceof Promise)) {
    throw new TypeError(`${source} must return a Promise.`);
  }
  return candidate;
}

function denial(
  mutation: NodeParentMutation,
  code: ParentCycleDenialCode,
  reason: string,
  details: {
    readonly collectionId?: string;
    readonly atNodeId?: string;
    readonly ancestry?: readonly string[];
  } = {},
): ParentCycleDenial {
  const ancestry = details.ancestry === undefined ? undefined : Object.freeze([...details.ancestry]);
  return Object.freeze({
    allowed: false,
    code,
    nodeId: mutation.nodeId,
    parentId: mutation.parentId,
    ...(details.collectionId === undefined ? {} : { collectionId: details.collectionId }),
    ...(details.atNodeId === undefined ? {} : { atNodeId: details.atNodeId }),
    ...(ancestry === undefined ? {} : { ancestry }),
    reason,
  });
}
