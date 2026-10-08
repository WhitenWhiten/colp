import type { ProblemCode } from '@know-n/colp/server';
import type { Operation } from '@know-n/colp/types';

const DELETE_PAYLOAD_KEYS = new Set(['reason']);
const MAX_DELETE_REASON_BYTES = 4_096;

export interface TrustedSyncDeleteNode {
  readonly id: string;
  readonly collectionId: string;
  readonly revision: string;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly isRoot: boolean;
  readonly deleted: boolean;
}

export interface CanonicalSyncNodeDelete {
  readonly collectionId: string;
  readonly targetId: string;
  readonly expectedCurrentRevision: string;
  readonly scope: 'single' | 'subtree';
}

export class SyncNodeDeleteError extends Error {
  constructor(public readonly code: ProblemCode) {
    super(`Sync Node delete denied: ${code}`);
    this.name = 'SyncNodeDeleteError';
  }
}

function deny(code: ProblemCode): never {
  throw new SyncNodeDeleteError(code);
}

/** Maps a schema-validated delete to a closed intent; subtree membership remains server-owned. */
export function evaluateSyncNodeDelete(
  operation: Operation,
  current: TrustedSyncDeleteNode,
): Readonly<CanonicalSyncNodeDelete> {
  if (operation.type !== 'delete_node' && operation.type !== 'delete_subtree') {
    deny('unsupported_operation');
  }
  if (typeof operation.collectionId !== 'string' || operation.collectionId.length < 1
      || typeof operation.targetId !== 'string' || operation.targetId.length < 1
      || typeof operation.baseRevision !== 'string' || operation.baseRevision.length < 1
      || !operation.payload || typeof operation.payload !== 'object'
      || Array.isArray(operation.payload)) {
    deny('invalid_document');
  }
  const payload = operation.payload as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !DELETE_PAYLOAD_KEYS.has(key))) deny('invalid_document');
  if (payload.reason !== undefined) {
    if (typeof payload.reason !== 'string') deny('invalid_document');
    if (Buffer.byteLength(payload.reason, 'utf8') > MAX_DELETE_REASON_BYTES) deny('payload_too_large');
  }
  if (current.collectionId !== operation.collectionId || current.id !== operation.targetId
      || current.deleted) deny('resource_not_found');
  if (current.isRoot) deny('invalid_document');
  if (current.revision !== operation.baseRevision) deny('revision_conflict');
  if (operation.type === 'delete_subtree' && current.kind !== 'folder') deny('invalid_document');

  return Object.freeze({
    collectionId: operation.collectionId,
    targetId: operation.targetId,
    expectedCurrentRevision: current.revision,
    scope: operation.type === 'delete_subtree' ? 'subtree' as const : 'single' as const,
  });
}
