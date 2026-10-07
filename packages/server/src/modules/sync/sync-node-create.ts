import type { ProblemCode } from '@know-n/colp/server';
import { preserveExtensions } from '@know-n/colp/schema';
import { validateNodeCreateRequestUrlHashSemantics } from '@know-n/colp/semantic';
import type { CreateNodeOperationPayload, Operation } from '@know-n/colp/types';
import {
  assertValidHttpUrlNoUserInfo,
  assertValidNodeDescription,
  assertValidNodeTags,
  assertValidNodeTitle,
  assertValidNodeVisibility,
  type JsonObject,
  type ResourceOwnedFields,
  validBookmarkPinExtension,
} from '../collections/index.js';
import {
  isSyncCreateFolderRoleAllowList,
  type SyncCreateFolderRoleAllowList,
} from './sync-mount-roles.js';

export interface SyncNodeCreateCapability {
  readonly managedBookmarkWrites: boolean;
}

export type SyncNodeCreateFolderRole = 'managed-bookmarks' | SyncCreateFolderRoleAllowList;

export interface CanonicalSyncNodeCreate {
  readonly collectionId: string;
  readonly operationId: string;
  readonly replicaId: string;
  readonly sequence: number;
  readonly parentId: string;
  readonly relativePosition: Readonly<{ readonly afterId?: string; readonly beforeId?: string }>;
  readonly fields: ResourceOwnedFields;
  readonly folderRole: SyncNodeCreateFolderRole | null;
}

export class SyncNodeCreateError extends Error {
  constructor(public readonly code: ProblemCode) {
    super(`Sync Node create denied: ${code}`);
    this.name = 'SyncNodeCreateError';
  }
}

function deny(code: ProblemCode): never {
  throw new SyncNodeCreateError(code);
}

/** Maps one schema-validated COLP create into resource-owned canonical fields only. */
export function mapSyncNodeCreateOperation(
  operation: Operation,
  capability: SyncNodeCreateCapability,
): Readonly<CanonicalSyncNodeCreate> {
  if (operation.type !== 'create_node') deny('unsupported_operation');
  const payload = operation.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) deny('invalid_document');
  const create = payload as Record<string, unknown>;
  const node = create.node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) deny('invalid_document');
  const candidate = node as Record<string, unknown>;
  if (candidate.kind === 'alias') deny('unsupported_operation');
  if (!['folder', 'bookmark', 'separator'].includes(String(candidate.kind))) deny('invalid_document');
  const kind = candidate.kind as 'folder' | 'bookmark' | 'separator';
  const collectionId = operation.collectionId;
  const parentId = create.parentId;
  if (typeof collectionId !== 'string' || collectionId.length < 1
      || typeof parentId !== 'string' || parentId.length < 1) deny('invalid_document');

  const folderRole = readCreateFolderRole(kind, candidate.folderRole, capability);

  let title: string | null = null;
  let url: string | null = null;
  try {
    if (kind === 'folder' || kind === 'bookmark') {
      title = assertValidNodeTitle(candidate.title as string);
    } else if (candidate.title !== undefined || candidate.url !== undefined) {
      deny('invalid_document');
    }
    if (kind === 'bookmark') {
      url = assertValidHttpUrlNoUserInfo(candidate.url as string);
    } else if (candidate.url !== undefined) {
      deny('invalid_document');
    }
    const description = assertValidNodeDescription(
      candidate.description === undefined ? null : candidate.description as string | null,
    );
    const tags = assertValidNodeTags(
      candidate.tags === undefined ? [] : candidate.tags as readonly string[],
    );
    const visibility = assertValidNodeVisibility(
      candidate.visibility === undefined ? 'inherit' : candidate.visibility as string,
    );
    if (candidate.canonicalUrl !== undefined) {
      assertValidHttpUrlNoUserInfo(candidate.canonicalUrl as string);
      if (kind !== 'bookmark') deny('invalid_document');
    }
    // F022: create path enforces the same urlHash contract as update —
    // urlHash is Bookmark-only and must be SHA-256 over the preserved url bytes.
    if (candidate.urlHash !== undefined) {
      if (kind !== 'bookmark') deny('invalid_document');
      const semantic = validateNodeCreateRequestUrlHashSemantics(
        create as unknown as CreateNodeOperationPayload,
      );
      if (!semantic.valid) deny('invalid_document');
    }
    const preserved = preserveExtensions(
      (candidate.extensions ?? {}) as Record<string, unknown>,
      { surface: 'sync-server', path: '/payload/node' },
    );
    if (preserved.removals.length !== 0) deny('invalid_document');
    if (!validBookmarkPinExtension(kind, preserved.extensions)) deny('invalid_document');
    const kindFields: JsonObject = {
      kind,
      title,
      url,
      description,
      tags: [...tags],
      visibility,
      ...(folderRole ? { folderRole } : {}),
      ...(candidate.canonicalUrl === undefined ? {} : { canonicalUrl: candidate.canonicalUrl as string }),
      ...(candidate.urlHash === undefined ? {} : { urlHash: candidate.urlHash as string }),
    };
    const afterId = create.afterId;
    const beforeId = create.beforeId;
    if (afterId !== undefined && afterId !== null && (typeof afterId !== 'string' || afterId.length < 1)) {
      deny('invalid_document');
    }
    if (beforeId !== undefined && beforeId !== null && (typeof beforeId !== 'string' || beforeId.length < 1)) {
      deny('invalid_document');
    }
    return Object.freeze({
      collectionId,
      operationId: operation.opId,
      replicaId: operation.replicaId,
      sequence: operation.sequence,
      parentId,
      relativePosition: Object.freeze({
        ...(typeof afterId === 'string' ? { afterId } : {}),
        ...(typeof beforeId === 'string' ? { beforeId } : {}),
      }),
      fields: Object.freeze({
        kindFields: Object.freeze(kindFields),
        extensions: preserved.extensions as JsonObject,
      }),
      folderRole,
    });
  } catch (error) {
    if (error instanceof SyncNodeCreateError) throw error;
    deny('invalid_document');
  }
}

function readCreateFolderRole(
  kind: 'folder' | 'bookmark' | 'separator',
  raw: unknown,
  capability: SyncNodeCreateCapability,
): SyncNodeCreateFolderRole | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') deny('invalid_document');
  if (raw === 'managed-bookmarks') {
    if (kind !== 'folder') deny('invalid_document');
    if (!capability.managedBookmarkWrites) deny('node_read_only');
    return 'managed-bookmarks';
  }
  if (kind !== 'folder' || !isSyncCreateFolderRoleAllowList(raw)) deny('invalid_document');
  return raw;
}
