import { types as nodeTypes } from 'node:util';

import { assertPlainStructuredData, assertPlainStructuredSource } from '../shared/plain-structured-data.js';

import type { StrictNode } from '../types/index.js';
import { deepFreeze } from './deep-freeze.js';
import { resolveNodeReadOnly, type NodeReadOnlySource } from './node-mutation-policy.js';
import {
  isNonEmptyId,
  malformedStringIdSet,
  sameStringIdSet,
  snapshotGuardedNodeMutation,
  type GuardedNodeWriteMutation,
} from './node-write-mutation.js';

export type { GuardedNodeKind, GuardedNodeWriteMutation } from './node-write-mutation.js';

export const DEFAULT_NODE_WRITE_LIMITS: ResolvedNodeWriteLimits = Object.freeze({
  maxDepth: 256,
  maxVisitedNodes: 10_000,
});

export const MAX_NODE_WRITE_LIMITS: ResolvedNodeWriteLimits = Object.freeze({
  maxDepth: 4_096,
  maxVisitedNodes: 100_000,
});

export interface NodeWriteLimits {
  readonly maxDepth?: number;
  readonly maxVisitedNodes?: number;
}

export interface ResolvedNodeWriteLimits {
  readonly maxDepth: number;
  readonly maxVisitedNodes: number;
}

export interface NodeWriteCollectionIdentity {
  readonly id: string;
  readonly rootNodeId: string;
}

export interface NodeWriteChildrenPage {
  readonly nodes: readonly StrictNode[];
  /** True when additional immediate children exist beyond this bounded page. */
  readonly hasMore: boolean;
}

/** All reads must use the same transaction or locked snapshot as the writer. */
export interface NodeWriteResolver {
  resolveCollection(collectionId: string): Promise<NodeWriteCollectionIdentity | undefined>;
  resolveNode(nodeId: string): Promise<StrictNode | undefined>;
  /** Query at most `limit` immediate children and report whether more exist. */
  resolveChildren(parentId: string, limit: number): Promise<NodeWriteChildrenPage>;
}

export interface NodeWriteUnitOfWork<Context extends NodeWriteResolver> {
  /** Commit only if the callback resolves. */
  run<Result>(work: (context: Context) => Promise<Result>): Promise<Result>;
}

export type NodeWriteGuardDenialCode =
  | 'invalid_node_mutation'
  | 'authorization_denied'
  | 'collection_unresolved'
  | 'node_unresolved'
  | 'node_already_exists'
  | 'node_ancestry_unresolved'
  | 'parent_cycle'
  | 'node_ancestry_cycle'
  | 'node_ancestry_too_deep'
  | 'node_subtree_cycle'
  | 'node_subtree_unresolved'
  | 'node_subtree_too_deep'
  | 'node_subtree_too_large'
  | 'node_collection_mismatch'
  | 'invalid_parent_kind'
  | 'root_invariant'
  | 'invalid_node_constraints'
  | 'node_read_only'
  | 'node_policy_denied'
  | 'folder_not_empty'
  | 'affected_nodes_mismatch';

export interface NodeWriteGuardDenial {
  readonly allowed: false;
  readonly code: NodeWriteGuardDenialCode;
  readonly reason: string;
  readonly nodeId?: string;
  readonly collectionId?: string;
  readonly atNodeId?: string;
  readonly source?: Exclude<NodeReadOnlySource, 'none'>;
}

export type NodeWriteGuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface NodeWriteGuardHooks<Context extends NodeWriteResolver, Candidate, Result = never> {
  /** Perform the adapter's wire and semantic validation before authorization. */
  validate(
    context: Context,
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
  ): Promise<NodeWriteGuardDecision>;
  /** Deny unauthorized or concealed operations before authoritative graph expansion. */
  preAuthorize(
    context: Context,
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
  ): Promise<NodeWriteGuardDecision>;
  /** Authorize this operation for the current principal. */
  authorize(
    context: Context,
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
    affectedNodeId: string,
    plan: GuardedNodeWritePlan,
  ): Promise<NodeWriteGuardDecision>;
  /** Apply operation-specific mutation policy to every authorized participant. */
  evaluatePolicy(
    context: Context,
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
    nodeId: string,
    plan: GuardedNodeWritePlan,
  ): Promise<NodeWriteGuardDecision>;
  /**
   * Gives an already-authorized HTTP precondition boundary precedence over a
   * deferred business denial. It must not persist business state.
   */
  beforeDeferredDenial?(
    context: Context,
    candidate: Readonly<Candidate>,
    mutation: GuardedNodeWriteMutation,
    plan: GuardedNodeWritePlan,
  ): Promise<NodeWritePersistenceResult<Result> | undefined>;
}

export interface GuardedNodeWritePlan {
  readonly mutation: GuardedNodeWriteMutation;
  readonly collectionId: string;
  /** Existing and proposed Node identities that require an ACL decision. */
  readonly authorizationNodeIds: readonly string[];
  /** Node records or child sets that persistence is authorized to change. */
  readonly modifiedNodeIds: readonly string[];
  /** Exact deletion range; excludes surviving Parents whose child set changes. */
  readonly deletedNodeIds: readonly string[];
  readonly deletedNodeCount: number;
}

export interface NodeWritePersistenceResult<Result> {
  readonly result: Result;
  readonly modifiedNodeIds: readonly string[];
  readonly deletedNodeIds: readonly string[];
  readonly deletedNodeCount: number;
}

export type GuardedNodeWritePersistenceWriter<Context extends NodeWriteResolver, Candidate, Result> = (
  context: Context,
  candidate: Readonly<Candidate>,
  plan: GuardedNodeWritePlan,
) => Promise<NodeWritePersistenceResult<Result>>;

export class NodeWriteGuardError extends Error {
  readonly denial: NodeWriteGuardDenial;

  constructor(denial: NodeWriteGuardDenial) {
    super(denial.reason);
    this.name = 'NodeWriteGuardError';
    this.denial = denial;
  }
}

/** Resolve deployment limits without permitting values above the package ceiling. */
export function resolveNodeWriteLimits(limits: NodeWriteLimits = {}): ResolvedNodeWriteLimits {
  return Object.freeze({
    maxDepth: boundedLimit(
      'maxDepth',
      limits.maxDepth,
      DEFAULT_NODE_WRITE_LIMITS.maxDepth,
      MAX_NODE_WRITE_LIMITS.maxDepth,
    ),
    maxVisitedNodes: boundedLimit(
      'maxVisitedNodes',
      limits.maxVisitedNodes,
      DEFAULT_NODE_WRITE_LIMITS.maxVisitedNodes,
      MAX_NODE_WRITE_LIMITS.maxVisitedNodes,
    ),
  });
}

/**
 * Validate, authorize, plan, and persist one ordinary Node mutation in a single
 * unit of work. Collection + Root creation is deliberately outside this API.
 *
 * Mutation ID lexical form is **non-empty string only** at this boundary (via
 * {@link snapshotGuardedNodeMutation}); Wire OpaqueId grammar is not enforced
 * here. Adapters that require protocol OpaqueId checks must apply them in
 * `hooks.validate` (or upstream at schema/publisher decode) before planning.
 * Parent-cycle and other wire-facing helpers may use stricter OpaqueId rules
 * independently; this API does not.
 */
export async function executeGuardedNodeWrite<Candidate, Context extends NodeWriteResolver, Result>(
  candidate: Candidate,
  mutation: GuardedNodeWriteMutation,
  unitOfWork: NodeWriteUnitOfWork<Context>,
  hooks: NodeWriteGuardHooks<Context, Candidate, Result>,
  write: GuardedNodeWritePersistenceWriter<Context, Candidate, Result>,
  limits: NodeWriteLimits = {},
): Promise<Result> {
  const checkedCandidate = immutableSnapshot(candidate);
  const checkedMutation = snapshotGuardedNodeMutation(mutation);
  const checkedLimits = resolveNodeWriteLimits(limits);

  return requirePromise(unitOfWork.run(async (context) => {
    const validation = await requirePromise(
      hooks.validate(context, checkedCandidate, checkedMutation),
      'Node write validation hook',
    );
    assertDecision(validation, 'Node write validation hook');
    if (!validation.allowed) {
      throw guardError('invalid_node_mutation', validation.reason);
    }

    const preAuthorization = await requirePromise(
      hooks.preAuthorize(context, checkedCandidate, checkedMutation),
      'Node write pre-authorization hook',
    );
    assertDecision(preAuthorization, 'Node write pre-authorization hook');
    if (!preAuthorization.allowed) {
      throw guardError('authorization_denied', preAuthorization.reason);
    }

    const planning = await buildPlan(context, checkedMutation, checkedLimits);
    for (const affectedNodeId of planning.plan.authorizationNodeIds) {
      const authorization = await requirePromise(
        hooks.authorize(context, checkedCandidate, checkedMutation, affectedNodeId, planning.plan),
        'Node write authorization hook',
      );
      assertDecision(authorization, 'Node write authorization hook');
      if (!authorization.allowed) {
        throw guardError('authorization_denied', authorization.reason, {
          nodeId: affectedNodeId,
          collectionId: planning.plan.collectionId,
          atNodeId: affectedNodeId,
        });
      }
    }
    for (const policyNodeId of planning.plan.authorizationNodeIds) {
      const policy = await requirePromise(
        hooks.evaluatePolicy(context, checkedCandidate, checkedMutation, policyNodeId, planning.plan),
        'Node write member policy hook',
      );
      assertDecision(policy, 'Node write member policy hook');
      if (!policy.allowed) {
        throw guardError('node_policy_denied', policy.reason, {
          nodeId: policyNodeId,
          collectionId: planning.plan.collectionId,
          atNodeId: policyNodeId,
        });
      }
    }
    for (const [node, subjectNodeId] of planning.policyNodes.values()) {
      checkReadOnly(node, subjectNodeId, planning.plan.collectionId);
    }
    for (const [nodeId, candidate] of planning.authorizationOnlyNodes) {
      if (candidate.state === 'malformed') {
        throw guardError('node_ancestry_unresolved', 'An authorized position identity is malformed.', {
          nodeId,
          collectionId: planning.plan.collectionId,
          atNodeId: nodeId,
        });
      }
    }

    if (planning.deferredDenial !== undefined) {
      if (hooks.beforeDeferredDenial !== undefined) {
        const early = await requirePromise(
          hooks.beforeDeferredDenial(context, checkedCandidate, checkedMutation, planning.plan),
          'Node write pre-denial hook',
        );
        if (early !== undefined) {
          assertWriterOutcome(early, planning.plan);
          return early.result;
        }
      }
      throw new NodeWriteGuardError(planning.deferredDenial);
    }

    const outcome = await requirePromise(
      write(context, checkedCandidate, planning.plan),
      'Node write persistence writer',
    );
    assertWriterOutcome(outcome, planning.plan);
    return outcome.result;
  }), 'Node write unit of work');
}

interface PlanningState<Context extends NodeWriteResolver> {
  readonly context: Context;
  readonly limits: ResolvedNodeWriteLimits;
  readonly nodes: Map<string, StrictNode | undefined>;
  readonly policyNodes: Map<string, readonly [node: StrictNode, subjectNodeId: string]>;
  /** Nodes whose authoritative path to the Collection Root is already validated. */
  readonly validatedAncestry: Set<string>;
}

interface PlanningResult {
  readonly plan: GuardedNodeWritePlan;
  readonly policyNodes: ReadonlyMap<string, readonly [node: StrictNode, subjectNodeId: string]>;
  readonly authorizationOnlyNodes: ReadonlyMap<string, AuthorizationOnlyNode>;
  readonly deferredDenial?: NodeWriteGuardDenial;
}

type AuthorizationOnlyNode =
  | { readonly state: 'missing' }
  | { readonly state: 'malformed' }
  | { readonly state: 'resolved'; readonly node: StrictNode };

async function buildPlan<Context extends NodeWriteResolver>(
  context: Context,
  mutation: GuardedNodeWriteMutation,
  limits: ResolvedNodeWriteLimits,
): Promise<PlanningResult> {
  const state: PlanningState<Context> = {
    context,
    limits,
    nodes: new Map(),
    policyNodes: new Map(),
    validatedAncestry: new Set(),
  };

  let collectionId: string;
  let modifiedNodeIds: readonly string[];
  let additionalAuthorizationNodeIds: readonly string[] = [];
  const authorizationOnlyNodes = new Map<string, AuthorizationOnlyNode>();
  let deletedNodeIds: readonly string[] = [];
  let deferredDenial: NodeWriteGuardDenial | undefined;

  switch (mutation.kind) {
    case 'create-node': {
      const collection = await resolveCollection(context, mutation.collectionId);
      if ((await resolveNode(state, mutation.nodeId, true)) !== undefined) {
        throw guardError('node_already_exists', 'The proposed Node identity already exists.', {
          nodeId: mutation.nodeId,
          collectionId: mutation.collectionId,
          atNodeId: mutation.nodeId,
        });
      }
      const parent = await requireNode(state, mutation.parentId);
      assertCollection(parent, collection.id, mutation.nodeId);
      assertStructuralParent(parent, collection, mutation.nodeId);
      await checkPolicyAndAncestry(state, parent, collection, mutation.nodeId);
      collectionId = collection.id;
      modifiedNodeIds = [mutation.nodeId, parent.id];
      break;
    }
    case 'update-node': {
      const node = await requireNode(state, mutation.nodeId);
      const collection = await collectionForNode(context, node);
      await checkPolicyAndAncestry(state, node, collection, node.id);
      collectionId = collection.id;
      modifiedNodeIds = [node.id];
      break;
    }
    case 'move-node':
    case 'reparent-node':
    case 'restore-node': {
      const node = await requireNode(state, mutation.nodeId);
      const collection = await collectionForNode(context, node);
      if (node.kind === 'root' || node.parentId === null) {
        throw guardError('root_invariant', 'Ordinary Node placement cannot move or restore a Collection Root.', {
          nodeId: node.id,
          collectionId: collection.id,
          atNodeId: node.id,
        });
      }
      const parent = await requireNode(state, mutation.parentId);
      assertCollection(parent, collection.id, node.id);
      assertStructuralParent(parent, collection, node.id);
      if (mutation.kind === 'move-node') {
        const sourceParent = await requireNode(state, node.parentId);
        assertCollection(sourceParent, collection.id, node.id);
        assertStructuralParent(sourceParent, collection, node.id);
      }
      await checkPolicyAndAncestry(state, node, collection, node.id);
      await checkPolicyAndAncestry(state, parent, collection, node.id, node.id);
      if (mutation.kind === 'move-node') {
        const anchorIds = unique([
          ...(mutation.afterId === undefined || mutation.afterId === null ? [] : [mutation.afterId]),
          ...(mutation.beforeId === undefined || mutation.beforeId === null ? [] : [mutation.beforeId]),
        ]);
        // Authorize the requested position identities before the Publisher
        // boundary resolves/discloses their authoritative placement. Their
        // existence, target membership and adjacency are concurrency context,
        // not Core graph structure.
        additionalAuthorizationNodeIds = anchorIds;
        for (const anchorId of anchorIds) {
          const candidate = await resolveNode(state, anchorId, true);
          authorizationOnlyNodes.set(anchorId, snapshotAuthorizationOnlyNode(candidate, anchorId));
        }
      }
      collectionId = collection.id;
      modifiedNodeIds = mutation.kind === 'restore-node'
        ? [node.id, parent.id]
        : [node.id, node.parentId, parent.id];
      break;
    }
    case 'reorder-children': {
      const parent = await requireNode(state, mutation.parentId);
      const collection = await collectionForNode(context, parent);
      assertStructuralParent(parent, collection, parent.id);
      await checkPolicyAndAncestry(state, parent, collection, parent.id);
      const children = await resolveChildren(state, parent, collection, 'node_subtree_unresolved');
      const expected = new Set(children.map((child) => child.id));
      if (
        mutation.childIds.length !== expected.size
        || expected.size !== children.length
        || !mutation.childIds.every((id) => expected.has(id))
      ) {
        throw guardError('invalid_node_mutation', 'The reorder list must contain every immediate child exactly once.', {
          nodeId: parent.id,
          collectionId: collection.id,
          atNodeId: parent.id,
        });
      }
      for (const child of children) {
        await checkPolicyAndAncestry(state, child, collection, child.id);
      }
      collectionId = collection.id;
      modifiedNodeIds = [parent.id, ...mutation.childIds];
      break;
    }
    case 'delete-node': {
      const node = await requireNode(state, mutation.nodeId);
      const collection = await collectionForNode(context, node);
      assertOrdinaryNode(node, collection);
      await checkPolicyAndAncestry(state, node, collection, node.id);
      if (node.kind === 'folder') {
        const children = await resolveChildren(state, node, collection, 'node_subtree_unresolved');
        if (children.length > 0) {
          additionalAuthorizationNodeIds = children.map((child) => child.id);
          deferredDenial = guardError('folder_not_empty', 'A non-empty Folder requires delete-subtree.', {
            nodeId: node.id,
            collectionId: collection.id,
            atNodeId: node.id,
          }).denial;
        }
      }
      collectionId = collection.id;
      modifiedNodeIds = [node.id, node.parentId];
      deletedNodeIds = [node.id];
      break;
    }
    case 'delete-subtree': {
      const node = await requireNode(state, mutation.nodeId);
      const collection = await collectionForNode(context, node);
      assertOrdinaryNode(node, collection);
      const subtree = await collectSubtree(state, node, collection);
      for (const participant of subtree) {
        await checkPolicyAndAncestry(state, participant, collection, participant.id);
      }
      collectionId = collection.id;
      deletedNodeIds = subtree.map((participant) => participant.id);
      modifiedNodeIds = [node.parentId, ...deletedNodeIds];
      break;
    }
    default:
      throw new TypeError('Unknown guarded Node mutation kind.');
  }

  const authorizationNodeIds = Object.freeze(unique([...modifiedNodeIds, ...additionalAuthorizationNodeIds]));
  const uniqueModified = Object.freeze(unique(modifiedNodeIds));
  const uniqueDeleted = Object.freeze(unique(deletedNodeIds));
  const plan = Object.freeze({
    mutation,
    collectionId,
    authorizationNodeIds,
    modifiedNodeIds: uniqueModified,
    deletedNodeIds: uniqueDeleted,
    deletedNodeCount: uniqueDeleted.length,
  });
  return Object.freeze({
    plan,
    policyNodes: state.policyNodes,
    authorizationOnlyNodes,
    ...(deferredDenial === undefined ? {} : { deferredDenial }),
  });
}

async function checkPolicyAndAncestry<Context extends NodeWriteResolver>(
  state: PlanningState<Context>,
  startingNode: StrictNode,
  collection: NodeWriteCollectionIdentity,
  subjectNodeId: string,
  forbiddenAncestorId?: string,
): Promise<void> {
  const ancestry = new Set<string>();
  let current = startingNode;
  let depth = 0;

  while (true) {
    assertCollection(current, collection.id, subjectNodeId);
    if (current.id === forbiddenAncestorId) {
      throw guardError('parent_cycle', 'The proposed parent relationship would create a cycle.', {
        nodeId: subjectNodeId,
        collectionId: collection.id,
        atNodeId: current.id,
      });
    }
    if (ancestry.has(current.id)) {
      throw guardError('node_ancestry_cycle', 'The authoritative Node ancestry contains a cycle.', {
        nodeId: subjectNodeId,
        collectionId: collection.id,
        atNodeId: current.id,
      });
    }
    if (forbiddenAncestorId === undefined && state.validatedAncestry.has(current.id)) {
      for (const nodeId of ancestry) state.validatedAncestry.add(nodeId);
      return;
    }
    ancestry.add(current.id);
    if (!state.policyNodes.has(current.id)) {
      state.policyNodes.set(current.id, Object.freeze([current, subjectNodeId]));
    }

    if (current.parentId === null) {
      if (current.kind !== 'root' || current.id !== collection.rootNodeId) {
        throw guardError('root_invariant', 'The authoritative ancestry does not terminate at the Collection Root.', {
          nodeId: subjectNodeId,
          collectionId: collection.id,
          atNodeId: current.id,
        });
      }
      for (const nodeId of ancestry) state.validatedAncestry.add(nodeId);
      return;
    }
    if (depth >= state.limits.maxDepth) {
      throw guardError('node_ancestry_too_deep', 'The authoritative Node ancestry exceeds maxDepth.', {
        nodeId: subjectNodeId,
        collectionId: collection.id,
        atNodeId: current.id,
      });
    }
    depth += 1;
    const parent = await requireNode(state, current.parentId, 'node_ancestry_unresolved', subjectNodeId);
    assertStructuralParent(parent, collection, subjectNodeId);
    current = parent;
  }
}

async function collectSubtree<Context extends NodeWriteResolver>(
  state: PlanningState<Context>,
  root: StrictNode,
  collection: NodeWriteCollectionIdentity,
): Promise<readonly StrictNode[]> {
  const result: StrictNode[] = [];
  const visited = new Set([root.id]);
  const queue: Array<readonly [node: StrictNode, depth: number]> = [[root, 0]];

  for (let index = 0; index < queue.length; index += 1) {
    const [current, depth] = queue[index]!;
    result.push(current);
    const children = await resolveChildren(state, current, collection, 'node_subtree_unresolved');
    for (const child of children) {
      if (visited.has(child.id)) {
        throw guardError('node_subtree_cycle', 'The authoritative Node subtree contains a cycle.', {
          nodeId: root.id,
          collectionId: collection.id,
          atNodeId: child.id,
        });
      }
      if (depth >= state.limits.maxDepth) {
        throw guardError('node_subtree_too_deep', 'The authoritative Node subtree exceeds maxDepth.', {
          nodeId: root.id,
          collectionId: collection.id,
          atNodeId: child.id,
        });
      }
      visited.add(child.id);
      queue.push([child, depth + 1]);
    }
  }
  return Object.freeze(result);
}

async function resolveChildren<Context extends NodeWriteResolver>(
  state: PlanningState<Context>,
  parent: StrictNode,
  collection: NodeWriteCollectionIdentity,
  denialCode: 'node_subtree_unresolved',
): Promise<readonly StrictNode[]> {
  const remaining = Math.max(0, state.limits.maxVisitedNodes - state.nodes.size);
  const page = immutableSnapshot(await requirePromise(
    callResolver<NodeWriteChildrenPage>(
      state.context,
      'resolveChildren',
      [parent.id, remaining],
      'Node write children resolver',
    ),
    'Node write children resolver',
  )) as NodeWriteChildrenPage;
  if (
    page === null
    || typeof page !== 'object'
    || Array.isArray(page)
    || !Array.isArray(page.nodes)
    || typeof page.hasMore !== 'boolean'
  ) {
    throw new TypeError('Node write children resolver must resolve to a bounded children page.');
  }
  if (page.hasMore || page.nodes.length > remaining) {
    throw guardError('node_subtree_too_large', 'Node traversal exceeds maxVisitedNodes.', {
      nodeId: parent.id,
      collectionId: collection.id,
      atNodeId: parent.id,
    });
  }
  const candidate = page.nodes;
  if (candidate.length > 0 && parent.kind !== 'root' && parent.kind !== 'folder') {
    throw guardError('invalid_parent_kind', 'Only a Root or Folder can have authoritative children.', {
      nodeId: parent.id,
      collectionId: collection.id,
      atNodeId: parent.id,
    });
  }
  const seen = new Set<string>();
  const children: StrictNode[] = [];
  for (const child of candidate) {
    if (!validNode(child) || child.parentId !== parent.id) {
      throw guardError(denialCode, 'The authoritative immediate child set is malformed or incomplete.', {
        nodeId: parent.id,
        collectionId: collection.id,
        atNodeId: isNonEmptyId((child as { readonly id?: unknown })?.id)
          ? (child as { readonly id: string }).id
          : parent.id,
      });
    }
    assertCollection(child, collection.id, parent.id);
    if (seen.has(child.id)) {
      throw guardError('node_subtree_cycle', 'The authoritative child set contains a duplicate Node.', {
        nodeId: parent.id,
        collectionId: collection.id,
        atNodeId: child.id,
      });
    }
    seen.add(child.id);
    const resolved = await resolveNode(state, child.id);
    if (resolved === undefined || resolved !== child && !sameNodeIdentity(resolved, child)) {
      throw guardError(denialCode, 'The child resolver and Node resolver disagree on authoritative identity.', {
        nodeId: parent.id,
        collectionId: collection.id,
        atNodeId: child.id,
      });
    }
    children.push(resolved);
  }
  return Object.freeze(children);
}

function checkReadOnly(
  node: StrictNode,
  subjectNodeId: string,
  collectionId: string,
): void {
  const resolution = resolveNodeReadOnly(node);
  if (resolution.source === 'invalid-constraint') {
    throw guardError('invalid_node_constraints', resolution.reason ?? 'Node constraints are malformed.', {
      nodeId: subjectNodeId,
      collectionId,
      atNodeId: node.id,
      source: resolution.source,
    });
  }
  if (resolution.readOnly) {
    throw guardError('node_read_only', resolution.reason ?? 'The Node is read-only.', {
      nodeId: subjectNodeId,
      collectionId,
      atNodeId: node.id,
      source: resolution.source as Exclude<NodeReadOnlySource, 'none'>,
    });
  }
}

async function resolveCollection<Context extends NodeWriteResolver>(
  context: Context,
  collectionId: string,
): Promise<NodeWriteCollectionIdentity> {
  const resolved = await requirePromise(
    callResolver<NodeWriteCollectionIdentity | undefined>(
      context,
      'resolveCollection',
      [collectionId],
      'Node write Collection resolver',
    ),
    'Node write Collection resolver',
  );
  const collection = resolved === undefined ? undefined : immutableSnapshot(resolved);
  if (
    collection === undefined
    || !isNonEmptyId(collection.id)
    || !isNonEmptyId(collection.rootNodeId)
    || collection.id !== collectionId
  ) {
    throw guardError('collection_unresolved', 'The authoritative Collection identity could not be resolved.', {
      collectionId,
    });
  }
  return Object.freeze({ id: collection.id, rootNodeId: collection.rootNodeId });
}

async function collectionForNode<Context extends NodeWriteResolver>(
  context: Context,
  node: StrictNode,
): Promise<NodeWriteCollectionIdentity> {
  return resolveCollection(context, node.collectionId);
}

async function requireNode<Context extends NodeWriteResolver>(
  state: PlanningState<Context>,
  nodeId: string,
  code: 'node_unresolved' | 'node_ancestry_unresolved' = 'node_unresolved',
  subjectNodeId = nodeId,
): Promise<StrictNode> {
  const node = await resolveNode(state, nodeId);
  if (node === undefined) {
    throw guardError(code, 'The authoritative Node identity could not be resolved.', {
      nodeId: subjectNodeId,
      atNodeId: nodeId,
    });
  }
  return node;
}

async function resolveNode<Context extends NodeWriteResolver>(
  state: PlanningState<Context>,
  nodeId: string,
  allowMissing = false,
): Promise<StrictNode | undefined> {
  if (state.nodes.has(nodeId)) return state.nodes.get(nodeId);
  if (state.nodes.size >= state.limits.maxVisitedNodes) {
    throw guardError('node_subtree_too_large', 'Node traversal exceeds maxVisitedNodes.', {
      atNodeId: nodeId,
    });
  }
  const node = await requirePromise(
    callResolver<StrictNode | undefined>(
      state.context,
      'resolveNode',
      [nodeId],
      'Node write Node resolver',
    ),
    'Node write Node resolver',
  );
  if (node === undefined) {
    state.nodes.set(nodeId, undefined);
    return undefined;
  }
  if (allowMissing) return node;
  const checkedNode = immutableSnapshot(node) as StrictNode;
  if (!validNode(checkedNode) || checkedNode.id !== nodeId) {
    throw guardError('node_ancestry_unresolved', 'The authoritative Node identity is malformed.', {
      nodeId,
      atNodeId: nodeId,
    });
  }
  // Keep one immutable transaction-read view across asynchronous authorization
  // and policy ports. An adapter retaining and later mutating its row object
  // cannot change the read-only decision made for this write.
  state.nodes.set(nodeId, checkedNode);
  return checkedNode;
}

function snapshotAuthorizationOnlyNode(
  candidate: StrictNode | undefined,
  nodeId: string,
): AuthorizationOnlyNode {
  if (candidate === undefined) return Object.freeze({ state: 'missing' });
  try {
    const node = immutableSnapshot(candidate) as StrictNode;
    if (!validNode(node) || node.id !== nodeId) return Object.freeze({ state: 'malformed' });
    return Object.freeze({ state: 'resolved', node });
  } catch {
    // Defer malformed position-identity failures until after that identity has
    // passed affected-node authorization and concealment.
    return Object.freeze({ state: 'malformed' });
  }
}

function assertStructuralParent(
  parent: StrictNode,
  collection: NodeWriteCollectionIdentity,
  nodeId: string,
): void {
  if (parent.kind !== 'root' && parent.kind !== 'folder') {
    throw guardError('invalid_parent_kind', 'A Node Parent must be a Root or Folder.', {
      nodeId,
      collectionId: collection.id,
      atNodeId: parent.id,
    });
  }
  if (parent.kind === 'root' && parent.id !== collection.rootNodeId) {
    throw guardError('root_invariant', 'The Parent claims Root kind but is not the Collection Root.', {
      nodeId,
      collectionId: collection.id,
      atNodeId: parent.id,
    });
  }
}

function assertOrdinaryNode(node: StrictNode, collection: NodeWriteCollectionIdentity): asserts node is Exclude<StrictNode, { readonly kind: 'root' }> {
  if (node.kind === 'root' || node.parentId === null || node.id === collection.rootNodeId) {
    throw guardError('root_invariant', 'Ordinary Node deletion cannot delete a Collection Root.', {
      nodeId: node.id,
      collectionId: collection.id,
      atNodeId: node.id,
    });
  }
}

function assertCollection(node: StrictNode, collectionId: string, subjectNodeId: string): void {
  if (node.collectionId !== collectionId) {
    throw guardError('node_collection_mismatch', 'The affected Node belongs to another Collection.', {
      nodeId: subjectNodeId,
      collectionId,
      atNodeId: node.id,
    });
  }
}

function assertWriterOutcome<Result>(
  outcome: NodeWritePersistenceResult<Result>,
  plan: GuardedNodeWritePlan,
): void {
  if (
    outcome === null
    || typeof outcome !== 'object'
    || !Array.isArray(outcome.modifiedNodeIds)
    || !Array.isArray(outcome.deletedNodeIds)
  ) {
    throw new TypeError('Node write persistence writer must return modified and deleted Node IDs and count.');
  }
  if (
    !Number.isSafeInteger(outcome.deletedNodeCount)
    || outcome.deletedNodeCount < 0
    || malformedStringIdSet(outcome.modifiedNodeIds)
    || malformedStringIdSet(outcome.deletedNodeIds)
  ) {
    throw guardError('affected_nodes_mismatch', 'The writer returned a malformed affected Node set.');
  }
  if (
    !sameStringIdSet(outcome.modifiedNodeIds, plan.modifiedNodeIds)
    || !sameStringIdSet(outcome.deletedNodeIds, plan.deletedNodeIds)
    || outcome.deletedNodeCount !== outcome.deletedNodeIds.length
    || outcome.deletedNodeCount !== plan.deletedNodeCount
  ) {
    throw guardError('affected_nodes_mismatch', 'The writer affected Node set differs from the authorized plan.', {
      collectionId: plan.collectionId,
    });
  }
}

function validNode(value: unknown): value is StrictNode {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Partial<StrictNode>;
  if (!isNonEmptyId(node.id) || !isNonEmptyId(node.collectionId)) return false;
  if (!['root', 'folder', 'bookmark', 'separator', 'alias'].includes(node.kind as string)) return false;
  return node.kind === 'root'
    ? node.parentId === null
    : isNonEmptyId(node.parentId);
}

function sameNodeIdentity(left: StrictNode, right: StrictNode): boolean {
  return left.id === right.id
    && left.collectionId === right.collectionId
    && left.kind === right.kind
    && left.parentId === right.parentId;
}

function assertDecision(value: unknown, label: string): asserts value is NodeWriteGuardDecision {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must resolve to an allow or deny decision.`);
  }
  const decision = value as { readonly allowed?: unknown; readonly reason?: unknown };
  if (decision.allowed === true) return;
  if (decision.allowed === false && typeof decision.reason === 'string' && decision.reason.length > 0) return;
  throw new TypeError(`${label} must explicitly allow or deny with a non-empty reason.`);
}

function boundedLimit(name: keyof ResolvedNodeWriteLimits, value: number | undefined, fallback: number, ceiling: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${ceiling}.`);
  }
  return resolved;
}

function guardError(
  code: NodeWriteGuardDenialCode,
  reason: string,
  details: Omit<NodeWriteGuardDenial, 'allowed' | 'code' | 'reason'> = {},
): NodeWriteGuardError {
  return new NodeWriteGuardError(Object.freeze({ allowed: false, code, reason, ...details }));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function immutableSnapshot<Value>(value: Value): Readonly<Value> {
  assertPlainStructuredSource(value);
  const snapshot = structuredClone(value) as Value;
  assertPlainStructuredData(snapshot);
  return deepFreeze(snapshot);
}


function requirePromise<Result>(candidate: Promise<Result>, label: string): Promise<Result> {
  if (!(candidate instanceof Promise)) throw new TypeError(`${label} must return a Promise.`);
  return candidate;
}

function callResolver<Result>(
  context: NodeWriteResolver,
  name: keyof NodeWriteResolver,
  args: readonly unknown[],
  label: string,
): Promise<Result> {
  if (context === null || typeof context !== 'object' || nodeTypes.isProxy(context)) {
    throw new TypeError(`${label} owner must be a non-Proxy object.`);
  }
  let owner: object | null = context;
  while (owner !== null) {
    if (nodeTypes.isProxy(owner)) throw new TypeError(`${label} prototype cannot be a Proxy.`);
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function'
        || nodeTypes.isProxy(descriptor.value)) {
        throw new TypeError(`${label} must be a non-Proxy data method.`);
      }
      const candidate = Reflect.apply(descriptor.value, context, args) as Promise<Result>;
      return requirePromise(candidate, label);
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  throw new TypeError(`${label} is required.`);
}
