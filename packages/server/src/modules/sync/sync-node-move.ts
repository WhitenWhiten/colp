import type { ProblemCode } from '@know-n/colp/server';
import type { Operation } from '@know-n/colp/types';

const MOVE_PAYLOAD_KEYS = new Set([
  'newParentId', 'afterId', 'beforeId',
  'baseSourceParentRevision', 'baseTargetParentRevision',
]);

export interface TrustedSyncMoveNode {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string | null;
  readonly revision: string;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly isRoot: boolean;
  readonly deleted: boolean;
}

export interface TrustedSyncMoveParent {
  readonly id: string;
  readonly collectionId: string;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly childrenRevision: string;
  readonly isRoot: boolean;
  readonly deleted: boolean;
}

export interface TrustedSyncNodeMoveFacts {
  readonly node: TrustedSyncMoveNode;
  readonly sourceParent: TrustedSyncMoveParent;
  readonly targetParent: TrustedSyncMoveParent;
  /** Target-to-root ancestry loaded from canonical parent links in the transaction. */
  readonly targetAncestorIds: readonly string[];
}

export interface CanonicalSyncNodeMove {
  readonly targetId: string;
  readonly expectedCurrentRevision: string;
  readonly sourceParentId: string;
  readonly newParentId: string;
  readonly relativePosition: Readonly<{ readonly afterId?: string; readonly beforeId?: string }>;
}

export class SyncNodeMoveError extends Error {
  constructor(public readonly code: ProblemCode) {
    super(`Sync Node move denied: ${code}`);
    this.name = 'SyncNodeMoveError';
  }
}

function deny(code: ProblemCode): never {
  throw new SyncNodeMoveError(code);
}

/** Validates one move against transaction-bound Node, Parent and ancestry facts. */
export function evaluateSyncNodeMove(
  operation: Operation,
  facts: TrustedSyncNodeMoveFacts,
): Readonly<CanonicalSyncNodeMove> {
  if (operation.type !== 'move_node') deny('unsupported_operation');
  const collectionId = operation.collectionId;
  const targetId = operation.targetId;
  const baseRevision = operation.baseRevision;
  const payload = operation.payload;
  if (typeof collectionId !== 'string' || collectionId.length < 1
      || typeof targetId !== 'string' || targetId.length < 1
      || typeof baseRevision !== 'string' || baseRevision.length < 1
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    deny('invalid_document');
  }
  const move = payload as unknown as Record<string, unknown>;
  if (Object.keys(move).some((key) => !MOVE_PAYLOAD_KEYS.has(key))) deny('invalid_document');
  const newParentId = move.newParentId;
  const sourceRevision = move.baseSourceParentRevision;
  const targetRevision = move.baseTargetParentRevision;
  const afterId = move.afterId;
  const beforeId = move.beforeId;
  if (typeof newParentId !== 'string' || newParentId.length < 1
      || typeof sourceRevision !== 'string' || sourceRevision.length < 1
      || typeof targetRevision !== 'string' || targetRevision.length < 1
      || (afterId !== undefined && afterId !== null
        && (typeof afterId !== 'string' || afterId.length < 1))
      || (beforeId !== undefined && beforeId !== null
        && (typeof beforeId !== 'string' || beforeId.length < 1))) {
    deny('invalid_document');
  }
  if (afterId === targetId || beforeId === targetId || (afterId !== null && afterId !== undefined
      && afterId === beforeId)) deny('position_context_stale');

  const { node, sourceParent, targetParent } = facts;
  if (node.collectionId !== collectionId || node.id !== targetId
      || sourceParent.collectionId !== collectionId || targetParent.collectionId !== collectionId) {
    deny('resource_not_found');
  }
  if (node.deleted) deny('resource_not_found');
  if (node.isRoot || node.parentId === null) deny('invalid_document');
  if (node.parentId !== sourceParent.id || targetParent.id !== newParentId) deny('resource_not_found');
  if (sourceParent.deleted || sourceParent.kind !== 'folder'
      || targetParent.deleted || targetParent.kind !== 'folder') deny('invalid_document');
  if (node.revision !== baseRevision) deny('revision_conflict');
  if (sourceParent.childrenRevision !== sourceRevision
      || targetParent.childrenRevision !== targetRevision) deny('position_context_stale');
  if (newParentId === targetId || (node.kind === 'folder' && facts.targetAncestorIds.includes(targetId))) {
    deny('invalid_document');
  }
  if (facts.targetAncestorIds[0] !== newParentId
      || new Set(facts.targetAncestorIds).size !== facts.targetAncestorIds.length) {
    deny('invalid_document');
  }

  return Object.freeze({
    targetId,
    expectedCurrentRevision: node.revision,
    sourceParentId: sourceParent.id,
    newParentId,
    relativePosition: Object.freeze({
      ...(typeof afterId === 'string' ? { afterId } : {}),
      ...(typeof beforeId === 'string' ? { beforeId } : {}),
    }),
  });
}
