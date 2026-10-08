import { createHash } from 'node:crypto';
import { snapshotMcpAuthorizationBinding, type McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import { authorizeCapability } from '../access-policy/index.js';
import { canonicalJson } from '../commands/index.js';
import {
  createCollectionNode, createCollectionNodeCommandScope,
  type CreateCollectionNodeResult, type LockedCollectionRow, type LockedNodeRow,
  type NodeCreateInput, type ProductCollectionCanonicalPorts,
} from '../collections/index.js';
import {
  Phase4bMcpLowRiskNodeCreateError, PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE, nodeCreateHint,
  type McpNodeCreatePayload,
  type Phase4bMcpLowRiskNodeCreateContext,
} from './node-create-contract.js';
import { phase4bMcpResolvedCreateVisibility } from './write-dependency-gate.js';

/** Closed application command: no transport mode, tool name or service/UoW wrapper. */
export interface Phase4bMcpNodeCreateCommand {
  readonly collectionId: string;
  readonly parentId?: string;
  readonly afterId: string | null;
  readonly beforeId: string | null;
  readonly node: McpNodeCreatePayload;
  readonly idempotencyKey: string;
  readonly expectedBaseRevisions: Readonly<Record<string, string>>;
}

interface CreateAdmissionPorts {
  readonly loadCollection: (collectionId: string) => Promise<LockedCollectionRow | null>;
  readonly getNode: (collectionId: string, nodeId: string) => Promise<LockedNodeRow | null>;
  readonly accessPolicy: ProductCollectionCanonicalPorts['accessPolicy'];
}

/** Execute in the caller's transaction; both direct tools and approved plans use this core. */
export async function executeMcpNodeCreate(
  ports: ProductCollectionCanonicalPorts,
  command: Phase4bMcpNodeCreateCommand,
  context: Phase4bMcpLowRiskNodeCreateContext,
): Promise<CreateCollectionNodeResult> {
  assertScope(context.scope);
  const accountSubjectId = requireAccountSubjectId(context.accountSubjectId);
  const binding = context.binding;
  const snapshot = await resolveCreateAdmission(ports, command, binding, accountSubjectId, { fence: false });
  return createCollectionNode({
    ...ports,
    receipts: {
      claim: async (receiptBinding, fingerprint) => {
        const claim = await ports.receipts.claim(receiptBinding, fingerprint);
        if (claim.kind === 'replay') {
          await assertCurrentPolicyForReplay(ports, command, binding, accountSubjectId);
        } else if (claim.kind === 'claimed') {
          await resolveCreateAdmission(ports, command, binding, accountSubjectId, { fence: true });
        }
        return claim;
      },
      complete: (receiptBinding, fingerprint, result) => ports.receipts.complete(receiptBinding, fingerprint, result),
    },
  }, {
    actor: { principalId: binding.principalId, principalType: 'account', subjectId: accountSubjectId },
    command: {
      commandId: command.idempotencyKey,
      fingerprint: computeNodeCreateFingerprint(command, binding),
      commandScope: createCollectionNodeCommandScope(command.collectionId),
    },
    collectionId: command.collectionId,
    parentId: snapshot.parentId,
    afterId: command.afterId,
    beforeId: command.beforeId,
    node: toNodeCreateInput(command.node, snapshot.appliedVisibility),
    operationId: command.idempotencyKey,
  });
}

export function computeNodeCreateFingerprint(
  parsed: Phase4bMcpNodeCreateCommand,
  binding: McpAuthenticatedAuthorizationBinding,
): string {
  const canonical = canonicalJson({
    operation: 'nodes.create',
    binding: snapshotMcpAuthorizationBinding(binding),
    collectionId: parsed.collectionId,
    parentId: parsed.parentId,
    afterId: parsed.afterId,
    beforeId: parsed.beforeId,
    node: parsed.node,
    expectedBaseRevisions: parsed.expectedBaseRevisions,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}


export function requireAccountSubjectId(accountSubjectId: string): string {
  if (typeof accountSubjectId !== 'string' || accountSubjectId.trim() === '') {
    throw new TypeError(
      'MCP authenticated actor requires accountSubjectId from OAuth account resolution.',
    );
  }
  return accountSubjectId;
}

function resolveCreateAdmission(
  ports: ProductCollectionCanonicalPorts,
  parsed: Phase4bMcpNodeCreateCommand,
  binding: McpAuthenticatedAuthorizationBinding,
  accountSubjectId: string,
  options: { readonly fence: boolean },
): Promise<CreateAdmissionSnapshot> {
  return loadAndAssertCreateState({
    loadCollection: (collectionId) => ports.collections.lockForUpdate(collectionId),
    getNode: (collectionId, nodeId) => ports.nodes.getNode(collectionId, nodeId),
    accessPolicy: ports.accessPolicy,
  }, parsed, binding, accountSubjectId, options);
}


export interface CreateAdmissionSnapshot {
  readonly collection: LockedCollectionRow;
  readonly parent: LockedNodeRow;
  readonly parentId: string;
  readonly appliedVisibility: 'inherit' | 'protected' | 'private';
}

export async function loadAndAssertCreateState(
  ports: CreateAdmissionPorts,
  parsed: Phase4bMcpNodeCreateCommand,
  binding: McpAuthenticatedAuthorizationBinding,
  accountSubjectId: string,
  options: { readonly fence: boolean },
): Promise<CreateAdmissionSnapshot> {
  const locked = await ports.loadCollection(parsed.collectionId);
  if (!locked || locked.deletedAt !== null) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'policy_denied',
      'nodes.create target collection is not available.',
    );
  }
  const parentId = parsed.parentId ?? locked.rootNodeId;
  const appliedVisibility = phase4bMcpResolvedCreateVisibility(
    parsed.node.visibility,
    locked.visibility,
  );
  const parent = await ports.getNode(
    parsed.collectionId,
    parentId,
  );
  if (
    !parent
    || parent.collectionId !== parsed.collectionId
    || parent.deletedAt !== null
    || parent.kind !== 'folder'
  ) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'parent_invalid',
      'nodes.create parent must be a live folder or root in the same collection.',
      nodeCreateHint('parentId'),
    );
  }
  if (options.fence !== true) {
    return Object.freeze({ collection: locked, parent, parentId, appliedVisibility });
  }

  assertExpectedRevisions(
    parsed,
    parsed.expectedBaseRevisions,
    locked,
    parent,
  );

  const decision = await authorizeCapability(ports.accessPolicy, {
    collectionId: parsed.collectionId,
    actor: {
      principalId: binding.principalId,
      subjectId: accountSubjectId,
      kind: 'account',
    },
    capability: 'create_node',
    expectedPolicyRevision: parsed.expectedBaseRevisions[`policy.${parsed.collectionId}`],
  });
  if (decision.outcome !== 'allow') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      decision.reasonCategory === 'policy_revision_mismatch' ? 'stale_revision' : 'policy_denied',
      'Current policy denied nodes.create inside the canonical transaction.',
    );
  }
  return Object.freeze({ collection: locked, parent, parentId, appliedVisibility });
}

async function assertCurrentPolicyForReplay(
  ports: ProductCollectionCanonicalPorts,
  parsed: Phase4bMcpNodeCreateCommand,
  binding: McpAuthenticatedAuthorizationBinding,
  accountSubjectId: string,
): Promise<void> {
  const decision = await authorizeCapability(ports.accessPolicy, {
    collectionId: parsed.collectionId,
    actor: {
      principalId: binding.principalId,
      subjectId: accountSubjectId,
      kind: 'account',
    },
    capability: 'create_node',
  });
  if (decision.outcome !== 'allow') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'policy_denied',
      'Current policy denied nodes.create receipt replay.',
    );
  }
}

function assertExpectedRevisions(
  input: Phase4bMcpNodeCreateCommand,
  expected: Readonly<Record<string, string>>,
  locked: LockedCollectionRow,
  parent: LockedNodeRow,
): void {
  for (const [key, expectedRevision] of Object.entries(expected)) {
    if (key === `children.${parent.id}`) {
      if (parent.childrenRevision !== expectedRevision) {
        throw new Phase4bMcpLowRiskNodeCreateError(
          'stale_revision',
          'nodes.create parent children revision is stale.',
        );
      }
      continue;
    }
    if (key === `content.${input.collectionId}`) {
      if (locked.contentRevision !== expectedRevision) {
        throw new Phase4bMcpLowRiskNodeCreateError(
          'stale_revision',
          'nodes.create collection content revision is stale.',
        );
      }
      continue;
    }
    if (key === `policy.${input.collectionId}`) {
      if (locked.policyRevision !== expectedRevision) {
        throw new Phase4bMcpLowRiskNodeCreateError(
          'stale_revision',
          'nodes.create collection policy revision is stale.',
        );
      }
      continue;
    }
    throw new Phase4bMcpLowRiskNodeCreateError(
      'authoritative_state_invalid',
      'nodes.create expected revision key is unsupported.',
    );
  }
}


function toNodeCreateInput(
  node: McpNodeCreatePayload,
  visibility: 'inherit' | 'protected' | 'private',
): NodeCreateInput {
  return { ...node, tags: [...node.tags], visibility };
}

export function assertScope(scope: readonly string[]): void {
  if (
    !Array.isArray(scope)
    || scope.some((entry) => typeof entry !== 'string' || entry.length === 0)
    || !scope.includes(PHASE4B_MCP_LOW_RISK_NODE_CREATE_SCOPE)
  ) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'scope_invalid',
      'nodes.create requires the current nodes:write scope.',
    );
  }
}

