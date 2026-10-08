/**
 * E4 trusted-client auto-approval and Undo.
 * A missing policy is manual. set_visibility and any other irreversible
 * operation still wait for the owner.
 */
import { randomUUID } from 'node:crypto';
import type { McpAuthenticatedAuthorizationBinding, McpPlanCommitResult } from '@know-n/colp/mcp';
import {
  CollectionVersionNotFoundError,
  NodeConflictError,
  createCollectionVersion,
  restoreCollectionVersion,
  type CollectionVersionCause,
  type RestoreCollectionVersionPorts,
} from '../collections/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import type { Phase4bMcpPlannedChange } from './change-plan-planner.js';

export type AgentPolicyName = 'manual' | 'trusted';

const REVERSIBLE_OPERATION_TYPES = new Set([
  'create_node',
  'update_node',
  'move_node',
  'reorder',
  'reorder_children',
  'delete_subtree',
  'create_annotation',
  'update_annotation',
]);

export interface AgentPlanPolicyReceipt {
  readonly planId: string;
  readonly clientId: string;
  readonly approvedBy: 'policy';
  readonly versionId: string;
  readonly collectionId: string;
  readonly cause: string;
}

export interface AutoApproveTrustedPlanActions {
  readonly approve: (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Promise<void>;
  readonly commit: (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
    idempotencyKey: string,
  ) => Promise<McpPlanCommitResult>;
}

export interface AutoApproveTrustedPlanDeps {
  readonly readPolicy: (principalId: string, clientId: string) => Promise<AgentPolicyName>;
  readonly captureVersion: (input: Readonly<{
    principalId: string;
    subjectId: string;
    collectionId: string;
    cause: `agent-plan:${string}`;
  }>) => Promise<{ readonly versionId: string }>;
  readonly saveReceipt: (receipt: AgentPlanPolicyReceipt) => Promise<void>;
  readonly audit: (input: Readonly<{
    planId: string;
    principalId: string;
    collectionId: string;
    versionId: string;
    cause: string;
    risk: string;
    operationsDigest: string;
  }>) => Promise<void>;
}

export type AutoApproveTrustedPlan = (
  planned: Phase4bMcpPlannedChange,
  binding: McpAuthenticatedAuthorizationBinding,
  actions: AutoApproveTrustedPlanActions,
) => Promise<Phase4bMcpPlannedChange>;

export function planOperationsAreReversible(operations: readonly unknown[]): boolean {
  if (operations.length === 0) return false;
  return operations.every((operation) => {
    if (typeof operation !== 'object' || operation === null) return false;
    const type = (operation as { readonly type?: unknown }).type;
    return typeof type === 'string' && REVERSIBLE_OPERATION_TYPES.has(type);
  });
}

export function collectionIdFromPlan(planned: Phase4bMcpPlannedChange): string | undefined {
  for (const operation of planned.operations) {
    if (typeof operation !== 'object' || operation === null) continue;
    const collectionId = (operation as { readonly collectionId?: unknown }).collectionId;
    if (typeof collectionId === 'string' && collectionId.length > 0) return collectionId;
  }
  for (const key of Object.keys(planned.baseRevisions)) {
    if (key.startsWith('content.')) return key.slice('content.'.length);
  }
  return undefined;
}

export function policyCommitIdempotencyKey(planId: string): string {
  const key = `policy:${planId}`;
  return key.length <= 512 ? key : `policy:${planId.slice(0, 500)}`;
}

export function createAutoApproveTrustedPlan(
  deps: AutoApproveTrustedPlanDeps,
): AutoApproveTrustedPlan {
  return async (planned, binding, actions) => {
    const policy = await deps.readPolicy(binding.principalId, binding.clientId);
    if (policy !== 'trusted') return planned;
    // A trusted client may only auto-commit when the current request carries
    // the explicit commit capability. Older callers do not expose scopes on
    // the binding, so absence is intentionally fail-closed and leaves the
    // plan in the normal owner-approval flow.
    const scopes = (binding as unknown as { readonly scopes?: readonly string[] }).scopes;
    if (!Array.isArray(scopes) || !scopes.includes('changes:commit')) return planned;
    if (!planOperationsAreReversible(planned.operations)) return planned;
    const collectionId = collectionIdFromPlan(planned);
    if (collectionId === undefined) return planned;
    const subjectId = requireMcpAccountSubjectId();
    const cause = `agent-plan:${planned.planId}` as const;
    const captured = await deps.captureVersion({
      principalId: binding.principalId,
      subjectId,
      collectionId,
      cause,
    });
    if (planned.requiresApproval) await actions.approve(planned.planId, binding);
    await actions.commit(planned.planId, binding, policyCommitIdempotencyKey(planned.planId));
    await deps.saveReceipt({
      planId: planned.planId,
      clientId: binding.clientId,
      approvedBy: 'policy',
      versionId: captured.versionId,
      collectionId,
      cause,
    });
    await deps.audit({
      planId: planned.planId,
      principalId: binding.principalId,
      collectionId,
      versionId: captured.versionId,
      cause,
      risk: planned.risk,
      operationsDigest: planned.operationsDigest,
    });
    return Object.freeze({
      ...planned,
      requiresApproval: false,
      mode: 'ready',
      status: 'consumed',
      approvedBy: 'policy',
      versionId: captured.versionId,
    });
  };
}

export type AgentPlanUndoCode =
  | 'not_found'
  | 'newer_version'
  | 'newer_changes'
  | 'sync_tombstone_conflict'
  | 'restore_failed';

export class AgentPlanUndoError extends Error {
  readonly code: AgentPlanUndoCode;

  constructor(code: AgentPlanUndoCode, message: string) {
    super(message);
    this.name = 'AgentPlanUndoError';
    this.code = code;
  }
}

export const SYNC_TOMBSTONE_UNDO_MESSAGE =
  'Undo refused because a sync tombstone conflicts with the saved tree. The collection was not changed.';

export const NEWER_VERSION_UNDO_MESSAGE =
  'A newer collection version exists. Undo was refused. Retry with force=true to restore this version anyway.';

export const NEWER_CHANGES_UNDO_MESSAGE =
  'The collection changed after this plan. Undo would also revert those changes, so it was refused. Retry with force=true to restore the saved version anyway.';

export async function undoAgentPlanVersion(
  ports: RestoreCollectionVersionPorts,
  input: Readonly<{
    principalId: string;
    subjectId: string;
    collectionId: string;
    versionId: string;
    commandId?: string;
    force: boolean;
    /**
     * Content revision recorded inside the plan's commit transaction. Null
     * when none was recorded; Undo then needs force.
     */
    committedContentRevision: string | null;
  }>,
): Promise<{ readonly versionId: string; readonly noop: boolean }> {
  const listed = await ports.versions.list(input.principalId, input.collectionId, { limit: 50 });
  const target = listed.find((version) => version.versionId === input.versionId)
    ?? await ports.versions.getById(input.principalId, input.collectionId, input.versionId);
  if (!target) {
    throw new AgentPlanUndoError('not_found', 'The saved collection version was not found.');
  }
  if (!input.force) {
    const newer = listed.some((version) => isNewerVersion(version, target));
    if (newer) throw new AgentPlanUndoError('newer_version', NEWER_VERSION_UNDO_MESSAGE);
  }
  const locked = await ports.versions.lockOwnedLive(input.collectionId, input.subjectId);
  if (!locked) throw new AgentPlanUndoError('not_found', 'The collection was not found.');
  // Sync and web edits do not create versions, so the version check above
  // cannot see them. The live revision must still be the one this plan left.
  if (!input.force && locked.contentRevision !== input.committedContentRevision) {
    throw new AgentPlanUndoError('newer_changes', NEWER_CHANGES_UNDO_MESSAGE);
  }
  try {
    const outcome = await restoreCollectionVersion(ports, {
      actor: { principalId: input.principalId, subjectId: input.subjectId },
      commandId: input.commandId ?? randomUUID(),
      collectionId: input.collectionId,
      versionId: input.versionId,
      ifMatch: locked.contentRevision,
      cause: 'undo',
    });
    if (outcome.kind !== 'succeeded') {
      throw new AgentPlanUndoError(
        'restore_failed',
        'Undo could not restore the saved collection version. The collection was not changed.',
      );
    }
    return { versionId: outcome.receipt.versionId, noop: outcome.receipt.noop };
  } catch (error) {
    if (error instanceof AgentPlanUndoError) throw error;
    if (error instanceof CollectionVersionNotFoundError) {
      throw new AgentPlanUndoError('not_found', 'The saved collection version was not found.');
    }
    if (error instanceof NodeConflictError) {
      throw new AgentPlanUndoError('sync_tombstone_conflict', SYNC_TOMBSTONE_UNDO_MESSAGE);
    }
    throw error;
  }
}

function isNewerVersion(
  version: { readonly versionId: string; readonly createdAt: Date },
  target: { readonly versionId: string; readonly createdAt: Date },
): boolean {
  if (version.versionId === target.versionId) return false;
  const created = version.createdAt.getTime() - target.createdAt.getTime();
  if (created > 0) return true;
  return created === 0 && version.versionId > target.versionId;
}

export async function captureAgentPlanCollectionVersion(
  execute: <Result>(
    work: (ports: RestoreCollectionVersionPorts) => Promise<Result>,
  ) => Promise<Result>,
  input: Readonly<{
    principalId: string;
    subjectId: string;
    collectionId: string;
    cause: CollectionVersionCause;
  }>,
): Promise<{ readonly versionId: string }> {
  return execute(async (ports) => {
    const locked = await ports.versions.lockOwnedLive(input.collectionId, input.subjectId);
    if (!locked) throw new CollectionVersionNotFoundError('The collection was not found.');
    const outcome = await createCollectionVersion(ports, {
      actor: { principalId: input.principalId, subjectId: input.subjectId },
      commandId: randomUUID(),
      collectionId: input.collectionId,
      ifMatch: locked.contentRevision,
      label: 'Before agent plan',
      cause: input.cause,
    });
    if (outcome.kind !== 'succeeded') {
      throw new Error(`Agent plan version capture did not succeed (${outcome.kind}).`);
    }
    return { versionId: outcome.version.versionId };
  });
}
