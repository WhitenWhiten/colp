import type { StrictNode } from '../types/index.js';

export type GuardedNodeKind = Exclude<StrictNode['kind'], 'root'>;

/**
 * Adapter-visible payload for one ordinary Node mutation accepted by the Core
 * write guard.
 *
 * Mutation IDs (`nodeId`, `parentId`, `collectionId`, sibling anchors,
 * `childIds`, etc.) must be **non-empty strings**. This boundary does **not**
 * enforce the protocol Wire OpaqueId grammar
 * (`isOpaqueId` / `^[A-Za-z0-9._~-]{1,128}$`). Wire-level OpaqueId validation
 * belongs at schema/publisher decode or in `hooks.validate` before planning.
 */
export type GuardedNodeWriteMutation =
  | {
      readonly kind: 'create-node';
      readonly nodeId: string;
      readonly collectionId: string;
      readonly nodeKind: GuardedNodeKind;
      readonly parentId: string;
    }
  | { readonly kind: 'update-node'; readonly nodeId: string }
  | {
      readonly kind: 'move-node';
      readonly nodeId: string;
      readonly parentId: string;
      /** Sibling identities participate in authorization, not mutation. */
      readonly afterId?: string | null;
      readonly beforeId?: string | null;
    }
  | { readonly kind: 'reparent-node' | 'restore-node'; readonly nodeId: string; readonly parentId: string }
  | { readonly kind: 'reorder-children'; readonly parentId: string; readonly childIds: readonly string[] }
  | { readonly kind: 'delete-node' | 'delete-subtree'; readonly nodeId: string };

/**
 * Snapshot and validate a guarded Node mutation boundary payload.
 *
 * Accepts adapter-visible non-empty string IDs only. Does **not** enforce Wire
 * OpaqueId grammar; adapters that need wire OpaqueId checks must perform them
 * in `hooks.validate` (or upstream at schema/publisher decode) before planning.
 */
export function snapshotGuardedNodeMutation(mutation: GuardedNodeWriteMutation): GuardedNodeWriteMutation {
  if (mutation === null || typeof mutation !== 'object') {
    throw new TypeError('Guarded Node mutation must be an object.');
  }
  switch (mutation.kind) {
    case 'create-node':
      assertMutationIds(mutation.nodeId, mutation.collectionId, mutation.parentId);
      if (!['folder', 'bookmark', 'separator', 'alias'].includes(mutation.nodeKind)) {
        throw new TypeError('create-node requires a non-Root Node kind.');
      }
      return Object.freeze({
        kind: mutation.kind,
        nodeId: mutation.nodeId,
        collectionId: mutation.collectionId,
        nodeKind: mutation.nodeKind,
        parentId: mutation.parentId,
      });
    case 'move-node': {
      assertMutationIds(mutation.nodeId, mutation.parentId);
      if ((mutation.afterId !== undefined && mutation.afterId !== null && !isNonEmptyId(mutation.afterId))
        || (mutation.beforeId !== undefined && mutation.beforeId !== null && !isNonEmptyId(mutation.beforeId))
        || (mutation.afterId !== undefined && mutation.afterId !== null
          && mutation.afterId === mutation.beforeId)) {
        throw new TypeError('move-node sibling anchors are invalid.');
      }
      return Object.freeze({
        kind: mutation.kind,
        nodeId: mutation.nodeId,
        parentId: mutation.parentId,
        ...(mutation.afterId === undefined ? {} : { afterId: mutation.afterId }),
        ...(mutation.beforeId === undefined ? {} : { beforeId: mutation.beforeId }),
      });
    }
    case 'reparent-node':
    case 'restore-node':
      assertMutationIds(mutation.nodeId, mutation.parentId);
      return Object.freeze({ kind: mutation.kind, nodeId: mutation.nodeId, parentId: mutation.parentId });
    case 'update-node':
    case 'delete-node':
    case 'delete-subtree':
      assertMutationIds(mutation.nodeId);
      return Object.freeze({ kind: mutation.kind, nodeId: mutation.nodeId });
    case 'reorder-children': {
      assertMutationIds(mutation.parentId);
      if (!Array.isArray(mutation.childIds) || mutation.childIds.some((id) => !isNonEmptyId(id))) {
        throw new TypeError('reorder-children requires an array of non-empty child IDs.');
      }
      if (new Set(mutation.childIds).size !== mutation.childIds.length) {
        throw new TypeError('reorder-children child IDs must be unique.');
      }
      return Object.freeze({
        kind: mutation.kind,
        parentId: mutation.parentId,
        childIds: Object.freeze([...mutation.childIds]),
      });
    }
    default:
      throw new TypeError('Unknown guarded Node mutation kind.');
  }
}

/** True when both sequences represent the same unique string ID set. */
export function sameStringIdSet(actualIds: readonly string[], expectedIds: readonly string[]): boolean {
  if (actualIds.length !== expectedIds.length) return false;
  const expected = new Set(expectedIds);
  if (expected.size !== expectedIds.length) return false;
  const actual = new Set(actualIds);
  if (actual.size !== actualIds.length) return false;
  if (actual.size !== expected.size) return false;
  for (const id of actual) {
    if (!expected.has(id)) return false;
  }
  return true;
}

/** True when an ID list is empty-string / non-string / contains duplicates. */
export function malformedStringIdSet(ids: readonly string[]): boolean {
  return ids.some((id) => !isNonEmptyId(id)) || new Set(ids).size !== ids.length;
}

/**
 * True when `value` is a non-empty string ID.
 *
 * This is the Core guarded-write ID check only. It does **not** enforce Wire
 * OpaqueId grammar (`isOpaqueId`). Wire-level OpaqueId validation belongs at
 * schema/publisher decode or `hooks.validate` before planning.
 */
export function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertMutationIds(...values: readonly unknown[]): void {
  if (values.some((value) => !isNonEmptyId(value))) {
    throw new TypeError('Guarded Node mutation IDs must be non-empty strings.');
  }
}
