/**
 * Shared memory-port fixtures for P1-06 editor page-query unit tests.
 * Extracted so each `editor-page-query-*.test.ts` file stays under the 600-line
 * granularity limit. Memory ports simulate the snapshot adapter contract
 * (sorted live rows, exclusive after, limit+1); they do not reimplement
 * application query, byte-budget, or authorization rules.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type {
  AccessPolicyFactsPort,
  CollectionVisibility,
  MembershipRole,
  ResourcePolicyFacts,
} from '../../../src/modules/access-policy/index.js';
import { canonicalJson } from '../../../src/modules/commands/index.js';
import {
  createProductEditorCursorSigner,
  formatUtcDateTime,
  getCollectionEditorPage,
  strongEntityTag,
  type CollectionEditorSnapshot,
  type EditableNodeView,
  type EditorCollectionRow,
  type EditorLiveNodeRow,
  type EditorPage,
  type EditorRootNodeRow,
  type GetCollectionEditorPageInput,
  type GetCollectionEditorPagePorts,
  type LockedCollectionRow,
  type ProductEditorCursorAfter,
  type ProductEditorCursorPayload,
} from '../../../src/modules/collections/index.js';

export const NOW = new Date('2026-07-22T12:00:00.000Z');
export const COLLECTION_ID = 'col-editor-0001';
export const ROOT_ID = 'root-editor-0001';
export const CONTENT_REV = 'content-rev-aaaa';
export const POLICY_REV = 'policy-rev-bbbb';
export const RESOURCE_REV = 'resource-rev-cccc';
export const CHILDREN_REV = 'children-rev-dddd';

export const PRINCIPAL_OWNER = 'principal-owner';
export const SUBJECT_OWNER = 'subject-owner';
export const PRINCIPAL_STRANGER = 'principal-stranger';
export const SUBJECT_STRANGER = 'subject-stranger';
export const PRINCIPAL_VIEWER = 'principal-viewer';
export const SUBJECT_VIEWER = 'subject-viewer';

export const CURSOR_KEY = 'product-editor-cursor-test-key-v1';
export const EDITOR_PRODUCT_ORIGIN = 'https://known.example';
export const EDITOR_ICON_OBJECT_ID = '01234567-89ab-4cde-8f01-23456789abcd';

// ---------------------------------------------------------------------------
// Memory state
// ---------------------------------------------------------------------------

export interface MemoryMembership {
  collectionId: string;
  subjectId: string;
  role: MembershipRole;
}

export interface MemoryState {
  now: Date;
  collection: EditorCollectionRow | null;
  root: EditorRootNodeRow | null;
  nodes: EditorLiveNodeRow[];
  memberships: MemoryMembership[];
  cursorKey: string;
  productOrigin: string;
  iconObjectIds: Map<string, string>;
  iconLookupCalls: number;
}

export function createState(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    now: new Date(NOW),
    collection: null,
    root: null,
    nodes: [],
    memberships: [],
    cursorKey: CURSOR_KEY,
    productOrigin: 'https://known.example',
    iconObjectIds: new Map(),
    iconLookupCalls: 0,
    ...overrides,
  };
}

export function seedOwnedCollection(
  state: MemoryState,
  options: {
    collectionId?: string;
    rootId?: string;
    title?: string;
    visibility?: CollectionVisibility;
    contentRevision?: string;
    policyRevision?: string;
    ownerSubjectId?: string;
    deleted?: boolean;
  } = {},
): { collectionId: string; rootId: string } {
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const rootId = options.rootId ?? ROOT_ID;
  const createdAt = new Date(state.now);
  state.collection = {
    id: collectionId,
    kind: 'bookmarks',
    title: options.title ?? 'Editor Tree',
    summary: null,
    visibility: options.visibility ?? 'private',
    rootNodeId: rootId,
    resourceRevision: RESOURCE_REV,
    contentRevision: options.contentRevision ?? CONTENT_REV,
    policyRevision: options.policyRevision ?? POLICY_REV,
    createdAt,
    updatedAt: createdAt,
    deletedAt: options.deleted ? createdAt : null,
  };
  state.root = {
    id: rootId,
    collectionId,
    title: options.title ?? 'Editor Tree',
    description: null,
    tags: [],
    resourceRevision: RESOURCE_REV,
    childrenRevision: CHILDREN_REV,
    createdAt,
    updatedAt: createdAt,
  };
  state.memberships.push({
    collectionId,
    subjectId: options.ownerSubjectId ?? SUBJECT_OWNER,
    role: 'owner',
  });
  return { collectionId, rootId };
}

export function addFolder(
  state: MemoryState,
  input: {
    id: string;
    parentId: string;
    positionToken: string;
    title?: string;
    description?: string | null;
    collectionId?: string;
  },
): void {
  const collectionId = input.collectionId ?? COLLECTION_ID;
  const createdAt = new Date(state.now);
  state.nodes.push({
    id: input.id,
    collectionId,
    parentId: input.parentId,
    kind: 'folder',
    title: input.title ?? input.id,
    url: null,
    description: input.description ?? null,
    tags: [],
    positionToken: input.positionToken,
    resourceRevision: `rev-${input.id}`,
    childrenRevision: `ch-${input.id}`,
    createdAt,
    updatedAt: createdAt,
  });
}

export function addBookmark(
  state: MemoryState,
  input: {
    id: string;
    parentId: string;
    positionToken: string;
    title?: string;
    description?: string | null;
    url?: string;
    tags?: string[];
    collectionId?: string;
    pinned?: boolean;
  },
): void {
  const collectionId = input.collectionId ?? COLLECTION_ID;
  const createdAt = new Date(state.now);
  state.nodes.push({
    ...(input.pinned ? { pinned: true } : {}),
    id: input.id,
    collectionId,
    parentId: input.parentId,
    kind: 'bookmark',
    title: input.title ?? input.id,
    url: input.url ?? 'https://example.com/',
    description: input.description ?? null,
    tags: input.tags ?? [],
    positionToken: input.positionToken,
    resourceRevision: `rev-${input.id}`,
    childrenRevision: `ch-${input.id}`,
    createdAt,
    updatedAt: createdAt,
  });
}

/** Stable bytewise comparator: (parentId, positionToken, id). */
export function compareLiveNodes(a: EditorLiveNodeRow, b: EditorLiveNodeRow): number {
  if (a.parentId < b.parentId) return -1;
  if (a.parentId > b.parentId) return 1;
  if (a.positionToken < b.positionToken) return -1;
  if (a.positionToken > b.positionToken) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function sortedNodes(state: MemoryState, collectionId: string): EditorLiveNodeRow[] {
  return state.nodes
    .filter((n) => n.collectionId === collectionId)
    .slice()
    .sort(compareLiveNodes);
}

export function isAfter(node: EditorLiveNodeRow, after: ProductEditorCursorAfter): boolean {
  if (node.parentId > after.parentKey) return true;
  if (node.parentId < after.parentKey) return false;
  if (node.positionToken > after.positionKey) return true;
  if (node.positionToken < after.positionKey) return false;
  return node.id > after.nodeId;
}

// ---------------------------------------------------------------------------
// Memory ports
// ---------------------------------------------------------------------------

export function lockedRowFromEditorState(
  state: MemoryState,
  collectionId: string,
): LockedCollectionRow | null {
  if (!state.collection || state.collection.id !== collectionId) {
    return null;
  }
  const collection = state.collection;
  return {
    id: collection.id,
    ownerSubjectId: SUBJECT_OWNER,
    title: collection.title,
    summary: collection.summary,
    kind: collection.kind,
    visibility: collection.visibility,
    allowSearchIndexing: collection.allowSearchIndexing ?? false,
    publicationSlug: collection.publicationSlug ?? null,
    publishedAt: collection.publishedAt ?? null,
    rootNodeId: collection.rootNodeId,
    resourceRevision: collection.resourceRevision,
    contentRevision: collection.contentRevision,
    policyRevision: collection.policyRevision,
    commitOrdinal: 0n,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
    deletedAt: collection.deletedAt,
  };
}

export function createMemoryPorts(state: MemoryState): GetCollectionEditorPagePorts {
  const accessPolicy: AccessPolicyFactsPort = {
    async loadCollectionFacts(input) {
      if (!state.collection || state.collection.id !== input.collectionId) {
        return null;
      }
      const membership = state.memberships.find(
        (m) => m.collectionId === input.collectionId && m.subjectId === input.actorSubjectId,
      );
      const facts: ResourcePolicyFacts = {
        collectionId: state.collection.id,
        ownerSubjectId: SUBJECT_OWNER,
        visibility: state.collection.visibility,
        policyRevision: state.collection.policyRevision,
        membershipRole: membership?.role ?? null,
        deleted: state.collection.deletedAt !== null,
      };
      return facts;
    },
  };

  return {
    clock: {
      now: async () => new Date(state.now),
    },
    collections: {
      async lockForShare(collectionId) {
        return lockedRowFromEditorState(state, collectionId);
      },
    },
    accessPolicy,
    cursorSigner: createProductEditorCursorSigner({ current: { id: 'test-v1', key: state.cursorKey } }),
    productOrigin: state.productOrigin,
    bookmarkIcons: {
      async findObjectIdsByNodeIds(nodeIds) {
        state.iconLookupCalls += 1;
        const result = new Map<string, string>();
        if (nodeIds.length === 0) return result;
        for (const id of nodeIds) {
          const objectId = state.iconObjectIds.get(id);
          if (objectId) result.set(id, objectId);
        }
        return result;
      },
    },
    loadSnapshot: {
      async loadCollectionEditorSnapshot(input) {
        if (!state.collection || state.collection.id !== input.collectionId) {
          return null;
        }
        if (!state.root || state.root.collectionId !== input.collectionId) {
          return null;
        }
        let rows = sortedNodes(state, input.collectionId);
        if (input.after) {
          rows = rows.filter((n) => isAfter(n, input.after!));
        }
        // Adapter returns limit+1 so application can detect hasMore on item budget.
        const page = rows.slice(0, input.limit + 1).map((n) => ({ ...n }));
        const snapshot: CollectionEditorSnapshot = {
          collection: { ...state.collection },
          root: { ...state.root },
          nodes: page,
        };
        return snapshot;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function ownerInput(
  overrides: Partial<GetCollectionEditorPageInput> = {},
): GetCollectionEditorPageInput {
  return {
    actor: {
      principalId: PRINCIPAL_OWNER,
      subjectId: SUBJECT_OWNER,
    },
    collectionId: COLLECTION_ID,
    ...overrides,
  };
}

export async function query(
  state: MemoryState,
  input: GetCollectionEditorPageInput = ownerInput(),
): Promise<EditorPage> {
  return getCollectionEditorPage(createMemoryPorts(state), input);
}

export function expectedEditableNode(row: EditorLiveNodeRow): EditableNodeView {
  const common = {
    id: row.id,
    collectionId: row.collectionId,
    parentId: row.parentId,
    position: row.positionToken,
    title: row.title,
    description: row.description,
    tags: Array.isArray(row.tags)
      ? row.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    visibility: row.visibility ?? 'inherit',
    revision: row.resourceRevision,
    etag: strongEntityTag(row.resourceRevision),
    readOnly: false as const,
    readOnlyReason: null,
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  };
  if (row.kind === 'folder') {
    return {
      ...common,
      kind: 'folder',
      folderRole: null,
      childrenRevision: row.childrenRevision,
      childrenEtag: strongEntityTag(row.childrenRevision),
    };
  }
  assert.ok(row.url);
  // LP-04: read views always carry previewImage; null without a link preview port.
  return { ...common, kind: 'bookmark', url: row.url, iconUrl: null, previewImage: null,
    ...(row.pinned ? { pinned: true as const } : {}) };
}

export function expectCode(error: unknown, code: string): void {
  assert.ok(error instanceof Error, `expected Error, got ${String(error)}`);
  assert.equal((error as { code?: string }).code, code);
}

export function tamperCursor(cursor: string): string {
  assert.ok(cursor.length > 4, 'cursor too short to tamper');
  const chars = cursor.split('');
  const idx = chars.length - 1;
  chars[idx] = chars[idx] === 'A' ? 'B' : 'A';
  const tampered = chars.join('');
  assert.notEqual(tampered, cursor);
  return tampered;
}

/** Manually forge a signed-looking token with wrong purpose (outside production signer). */
export function forgeWrongPurposeCursor(key: string, base: ProductEditorCursorPayload): string {
  const forged = {
    ...base,
    purpose: 'publication-cursor',
  };
  const canonical = canonicalJson(forged);
  const body = Buffer.from(canonical, 'utf8').toString('base64url');
  const signed = `test-v1.${body}`;
  const signature = createHmac('sha256', key).update(signed, 'utf8').digest('base64url');
  return `${signed}.${signature}`;
}
