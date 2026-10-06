import type { Node } from '../types/index.js';
import { deepFreeze } from './deep-freeze.js';

export interface NodeMutationPolicyLimits {
  readonly maxDepth?: number;
  readonly maxVisitedNodes?: number;
}

export interface ResolvedNodeMutationPolicyLimits {
  readonly maxDepth: number;
  readonly maxVisitedNodes: number;
}

export const DEFAULT_NODE_MUTATION_POLICY_LIMITS: ResolvedNodeMutationPolicyLimits = Object.freeze({
  maxDepth: 256,
  maxVisitedNodes: 10_000,
});

export const MAX_NODE_MUTATION_POLICY_LIMITS: ResolvedNodeMutationPolicyLimits = Object.freeze({
  maxDepth: 4_096,
  maxVisitedNodes: 100_000,
});

export type NodeReadOnlySource =
  | 'explicit-constraint'
  | 'managed-bookmarks-default'
  | 'invalid-constraint'
  | 'none';

export interface NodeReadOnlyResolution {
  readonly readOnly: boolean;
  readonly source: NodeReadOnlySource;
  readonly reason: string | null;
}

export type NodeMutationKind =
  | 'create-child'
  | 'update-node'
  | 'move-node'
  | 'reorder-children'
  | 'delete-node'
  | 'delete-subtree'
  | 'restore-node';

export type NodeMutation =
  | { readonly kind: 'create-child'; readonly parent: Node }
  | { readonly kind: 'update-node'; readonly node: Node }
  | { readonly kind: 'move-node'; readonly node: Node; readonly targetParent: Node }
  | { readonly kind: 'reorder-children'; readonly parent: Node }
  | { readonly kind: 'delete-node'; readonly node: Node }
  | { readonly kind: 'delete-subtree'; readonly node: Node }
  | { readonly kind: 'restore-node'; readonly node: Node; readonly parent: Node };

export interface NodeMutationPolicyResolver {
  /** Resolve authoritative state from the transaction that will perform the mutation. */
  resolveNode(nodeId: string): Promise<Node | undefined>;
  /** Authoritative descendants excluding the root. Prefer a lazy iterable so
   * the guard can stop at its visit budget without materializing the subtree. */
  resolveDescendants(nodeId: string): Promise<Iterable<Node> | AsyncIterable<Node>>;
}

export type NodeMutationPolicyResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: 'node_read_only' | 'node_ancestry_unresolved' | 'invalid_node_constraints';
      readonly nodeId: string;
      readonly reason: string;
      readonly source?: Exclude<NodeReadOnlySource, 'none'>;
    };

export interface NodeMutationPolicyUnitOfWork<Context extends NodeMutationPolicyResolver> {
  /** Commit only if the callback resolves; Context owns every policy read and the mutation write. */
  run<Result>(work: (context: Context) => Promise<Result>): Promise<Result>;
}

export type NodeMutationPolicyWriter<Context extends NodeMutationPolicyResolver, Result> = (
  context: Context,
  mutation: NodeMutation,
  policy: Extract<NodeMutationPolicyResult, { readonly allowed: true }>,
) => Promise<Result>;

export class NodeMutationPolicyError extends Error {
  readonly denial: Exclude<NodeMutationPolicyResult, { readonly allowed: true }>;

  constructor(denial: Exclude<NodeMutationPolicyResult, { readonly allowed: true }>) {
    super(denial.reason);
    this.name = 'NodeMutationPolicyError';
    this.denial = denial;
  }
}

/** Resolve a Node's own constraint. Ancestor inheritance is applied by the mutation evaluator. */
export function resolveNodeReadOnly(node: Node): NodeReadOnlyResolution {
  const constraints = (node as { readonly constraints?: unknown }).constraints;
  if (constraints !== undefined) {
    if (constraints === null || typeof constraints !== 'object' || Array.isArray(constraints)) {
      return { readOnly: true, source: 'invalid-constraint', reason: 'Node constraints are malformed.' };
    }

    const record = constraints as Record<string, unknown>;
    const readOnly = record.readOnly;
    const reason = record.reason;
    if (
      Object.keys(record).some((key) => key !== 'readOnly' && key !== 'reason') ||
      typeof readOnly !== 'boolean' ||
      (reason !== undefined && reason !== null && typeof reason !== 'string')
    ) {
      return { readOnly: true, source: 'invalid-constraint', reason: 'Node constraints are malformed.' };
    }
    return {
      readOnly,
      source: 'explicit-constraint',
      reason: typeof reason === 'string' ? reason : null,
    };
  }

  if (node.kind === 'folder' && node.folderRole === 'managed-bookmarks') {
    return {
      readOnly: true,
      source: 'managed-bookmarks-default',
      reason: null,
    };
  }

  return { readOnly: false, source: 'none', reason: null };
}

/**
 * Evaluates every Node whose state or child set a mutation can affect. The resolver
 * must be transaction-bound so authorization cannot race the subsequent write.
 */
export async function evaluateNodeMutationPolicy(
  mutation: NodeMutation,
  resolver: NodeMutationPolicyResolver,
  limits: NodeMutationPolicyLimits = {},
): Promise<NodeMutationPolicyResult> {
  const resolvedLimits = resolveNodeMutationPolicyLimits(limits);
  const cache = new Map<string, Promise<Node | undefined>>();
  const authoritative: NodeMutationPolicyResolver = {
    resolveDescendants: id => resolver.resolveDescendants(id),
    resolveNode: id => {
      let value = cache.get(id);
      if (!value) { value = resolver.resolveNode(id); cache.set(id, value); }
      return value;
    },
  };
  const candidates = await mutationParticipants(mutation, authoritative, resolvedLimits.maxVisitedNodes);
  if (candidates === null) return unresolved(mutationNodeId(mutation));
  const traversal: NodeMutationTraversal = {
    limits: resolvedLimits,
    visitedNodes: new Set<string>(),
  };
  let collectionId: string | undefined;

  for await (const candidate of candidates) {
    // Mutation DTOs can be stale or caller-controlled. Always restart from the
    // authoritative row read by the transaction that will perform the write.
    if (!canVisitNode(traversal, candidate.id)) return unresolved(candidate.id);
    const participant = await authoritative.resolveNode(candidate.id);
    if (participant === undefined || participant.id !== candidate.id) {
      return unresolved(candidate.id);
    }
    if (!visitNode(traversal, participant.id)) return unresolved(candidate.id);
    if (collectionId !== undefined && participant.collectionId !== collectionId) {
      return unresolved(participant.id);
    }
    collectionId ??= participant.collectionId;
    const result = await evaluateNodeAndAncestors(participant, authoritative, traversal);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/** Evaluate authoritative policy state and persist through the same unit of work. */
export async function executeNodeMutationPolicyGuardedWrite<
  Context extends NodeMutationPolicyResolver,
  Result,
>(
  mutation: NodeMutation,
  unitOfWork: NodeMutationPolicyUnitOfWork<Context>,
  write: NodeMutationPolicyWriter<Context, Result>,
  limits: NodeMutationPolicyLimits = {},
): Promise<Result> {
  const checkedMutation = deepFreeze(structuredClone(mutation) as NodeMutation);
  const checkedLimits = resolveNodeMutationPolicyLimits(limits);
  return requirePromise(unitOfWork.run(async (context) => {
    const policy = await evaluateNodeMutationPolicy(checkedMutation, context, checkedLimits);
    if (!policy.allowed) throw new NodeMutationPolicyError(Object.freeze({ ...policy }));
    const allowed = Object.freeze({ allowed: true as const });
    return requirePromise(write(context, checkedMutation, allowed), 'Node mutation policy writer');
  }), 'Node mutation policy unit of work');
}

async function mutationParticipants(
  mutation: NodeMutation,
  resolver: NodeMutationPolicyResolver,
  maxVisitedNodes: number,
): Promise<Iterable<Node> | AsyncIterable<Node> | null> {
  switch (mutation.kind) {
    case 'create-child':
    case 'reorder-children':
      return [mutation.parent];
    case 'update-node':
    case 'delete-node':
      return [mutation.node];
    case 'move-node':
      return [mutation.node, mutation.targetParent];
    case 'restore-node':
      return [mutation.node, mutation.parent];
    case 'delete-subtree': {
      const descendants = await resolver.resolveDescendants(mutation.node.id);
      if (Array.isArray(descendants) && descendants.length + 1 > maxVisitedNodes) return null;
      return (async function* () {
        yield mutation.node;
        yield* descendants;
      })();
    }
  }
}

async function evaluateNodeAndAncestors(
  startingNode: Node,
  resolver: NodeMutationPolicyResolver,
  traversal: NodeMutationTraversal,
): Promise<NodeMutationPolicyResult> {
  const collectionId = startingNode.collectionId;
  const visited = new Set<string>();
  let node: Node | undefined = startingNode;
  let depth = 0;

  while (node !== undefined) {
    if (visited.has(node.id) || node.collectionId !== collectionId) {
      return unresolved(startingNode.id);
    }
    visited.add(node.id);

    const resolution = resolveNodeReadOnly(node);
    if (resolution.source === 'invalid-constraint') {
      return {
        allowed: false,
        code: 'invalid_node_constraints',
        nodeId: node.id,
        reason: resolution.reason ?? 'Node constraints are malformed.',
        source: resolution.source,
      };
    }
    if (resolution.readOnly) {
      return {
        allowed: false,
        code: 'node_read_only',
        nodeId: node.id,
        reason: resolution.reason ?? 'The node is read-only.',
        source:
          resolution.source === 'none' ? 'explicit-constraint' : resolution.source,
      };
    }

    if (node.parentId === null) {
      return { allowed: true };
    }
    if (depth >= traversal.limits.maxDepth) return unresolved(startingNode.id);
    const expectedParentId = node.parentId;
    if (!canVisitNode(traversal, expectedParentId)) return unresolved(startingNode.id);
    node = await resolver.resolveNode(expectedParentId);
    if (node === undefined || node.id !== expectedParentId) {
      return unresolved(startingNode.id);
    }
    if (!visitNode(traversal, node.id)) return unresolved(startingNode.id);
    depth += 1;
  }

  return unresolved(startingNode.id);
}

interface NodeMutationTraversal {
  readonly limits: ResolvedNodeMutationPolicyLimits;
  readonly visitedNodes: Set<string>;
}

export function resolveNodeMutationPolicyLimits(
  limits: NodeMutationPolicyLimits = {},
): ResolvedNodeMutationPolicyLimits {
  return Object.freeze({
    maxDepth: boundedLimit(
      'maxDepth',
      limits.maxDepth,
      DEFAULT_NODE_MUTATION_POLICY_LIMITS.maxDepth,
      MAX_NODE_MUTATION_POLICY_LIMITS.maxDepth,
    ),
    maxVisitedNodes: boundedLimit(
      'maxVisitedNodes',
      limits.maxVisitedNodes,
      DEFAULT_NODE_MUTATION_POLICY_LIMITS.maxVisitedNodes,
      MAX_NODE_MUTATION_POLICY_LIMITS.maxVisitedNodes,
    ),
  });
}

function boundedLimit(
  name: keyof ResolvedNodeMutationPolicyLimits,
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${ceiling}.`);
  }
  return resolved;
}

function visitNode(traversal: NodeMutationTraversal, nodeId: string): boolean {
  if (traversal.visitedNodes.has(nodeId)) return true;
  if (!canVisitNode(traversal, nodeId)) return false;
  traversal.visitedNodes.add(nodeId);
  return true;
}

function canVisitNode(traversal: NodeMutationTraversal, nodeId: string): boolean {
  return traversal.visitedNodes.has(nodeId)
    || traversal.visitedNodes.size < traversal.limits.maxVisitedNodes;
}

function mutationNodeId(mutation: NodeMutation): string {
  switch (mutation.kind) {
    case 'create-child':
    case 'reorder-children':
      return mutation.parent.id;
    case 'update-node':
    case 'delete-node':
    case 'delete-subtree':
    case 'move-node':
    case 'restore-node':
      return mutation.node.id;
  }
}

function unresolved(nodeId: string): NodeMutationPolicyResult {
  return {
    allowed: false,
    code: 'node_ancestry_unresolved',
    nodeId,
    reason: 'The complete authoritative node ancestry could not be resolved.',
  };
}

function requirePromise<Result>(candidate: Promise<Result>, label: string): Promise<Result> {
  if (!(candidate instanceof Promise)) throw new TypeError(`${label} must return a Promise.`);
  return candidate;
}
