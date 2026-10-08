/**
 * P1-08 createCollectionNode application unit tests (in-memory ports).
 *
 * Production surface (contract names; align with create/update-collection-metadata):
 *   createCollectionNode(ports, input)
 *     → created | replay | in_progress | reused | expired
 *   createCollectionNodeCommandScope(collectionId)
 *     -> collection:{collectionId}:node:create
 *   Capability: create_node (owner/editor; viewer deny; non-member conceal)
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { MembershipRole } from '../../../src/modules/access-policy/index.js';
import {
  CollectionAuthorizationError,
  NODE_CREATED_EVENT_TYPE,
  NodeConflictError,
  createCollectionNode,
  createCollectionNodeCommandScope,
  type CreateCollectionNodeInput,
  type CreateCollectionNodeResult,
  type LockedCollectionRow,
  type SiblingPositionRow,
} from '../../../src/modules/collections/index.js';
import { SnapshotTreeCapacityError } from '../../../src/modules/collections/domain/index.js';
import {
  COMMAND_A,
  COMMAND_B,
  COMMAND_C,
  FINGERPRINT_A,
  FINGERPRINT_B,
  NOW,
  PRINCIPAL_EDITOR,
  PRINCIPAL_OWNER,
  PRINCIPAL_STRANGER,
  PRINCIPAL_VIEWER,
  SUBJECT_EDITOR,
  SUBJECT_OWNER,
  SUBJECT_STRANGER,
  SUBJECT_VIEWER,
  completedReceipt,
  createMemoryPorts,
  createState,
  expectCode,
  type MemoryState,
  type MutableCollection,
  type MutableNode,
} from '../../support/memory-collections-write-ports.js';

const COLLECTION_ID = 'col-node-0001';
const ROOT_ID = 'root-node-0001';
const FOLDER_ID = 'folder-node-0001';
const BOOKMARK_ID = 'bookmark-node-0001';
const SIBLING_A = 'sibling-a-0001';
const SIBLING_B = 'sibling-b-0001';
const SIBLING_C = 'sibling-c-0001';
const NEW_NODE_ID = 'new-node-0001';
const RESOURCE_REV = 'resource-rev-node-1';
const CONTENT_REV = 'content-rev-node-1';
const POLICY_REV = 'policy-rev-node-1';
const ROOT_CHILDREN_REV = 'root-children-rev-1';
const FOLDER_CHILDREN_REV = 'folder-children-rev-1';
const OPERATION_ID = 'op-node-create-1';

function seedCollection(
  state: MemoryState,
  options: {
    collectionId?: string;
    ownerSubjectId?: string;
    visibility?: LockedCollectionRow['visibility'];
    resourceRevision?: string;
    contentRevision?: string;
    policyRevision?: string;
    commitOrdinal?: bigint;
    deletedAt?: Date | null;
    memberships?: Array<{ subjectId: string; role: MembershipRole }>;
  } = {},
): MutableCollection {
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const ownerSubjectId = options.ownerSubjectId ?? SUBJECT_OWNER;
  const createdAt = new Date(state.now);
  const row: MutableCollection = {
    id: collectionId,
    ownerSubjectId,
    title: 'Node Create Collection',
    summary: 'seed',
    kind: 'bookmarks',
    visibility: options.visibility ?? 'private',
    rootNodeId: ROOT_ID,
    resourceRevision: options.resourceRevision ?? RESOURCE_REV,
    contentRevision: options.contentRevision ?? CONTENT_REV,
    policyRevision: options.policyRevision ?? POLICY_REV,
    commitOrdinal: options.commitOrdinal ?? 1n,
    createdAt,
    updatedAt: createdAt,
    deletedAt: options.deletedAt ?? null,
  };
  state.collections.set(collectionId, row);
  state.memberships.push({
    collectionId,
    subjectId: ownerSubjectId,
    role: 'owner',
  });
  for (const m of options.memberships ?? []) {
    state.memberships.push({
      collectionId,
      subjectId: m.subjectId,
      role: m.role,
    });
  }

  // Root always present for parent validation.
  state.nodes.set(ROOT_ID, {
    id: ROOT_ID,
    collectionId,
    parentId: null,
    kind: 'folder',
    isRoot: true,
    title: 'Root',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: null,
    resourceRevision: 'root-resource-rev',
    childrenRevision: ROOT_CHILDREN_REV,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });

  return row;
}

function seedFolder(
  state: MemoryState,
  options: {
    id?: string;
    parentId?: string;
    positionToken?: string;
    deletedAt?: Date | null;
    collectionId?: string;
  } = {},
): MutableNode {
  const id = options.id ?? FOLDER_ID;
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const createdAt = new Date(state.now);
  const row: MutableNode = {
    id,
    collectionId,
    parentId: options.parentId ?? ROOT_ID,
    kind: 'folder',
    isRoot: false,
    title: 'Folder',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: options.positionToken ?? 'U',
    resourceRevision: 'folder-resource-rev',
    childrenRevision: FOLDER_CHILDREN_REV,
    createdAt,
    updatedAt: createdAt,
    deletedAt: options.deletedAt ?? null,
  };
  state.nodes.set(id, row);
  return row;
}

function seedBookmark(
  state: MemoryState,
  options: {
    id?: string;
    parentId?: string;
    positionToken?: string;
    collectionId?: string;
  } = {},
): MutableNode {
  const id = options.id ?? BOOKMARK_ID;
  const collectionId = options.collectionId ?? COLLECTION_ID;
  const createdAt = new Date(state.now);
  const row: MutableNode = {
    id,
    collectionId,
    parentId: options.parentId ?? ROOT_ID,
    kind: 'bookmark',
    isRoot: false,
    title: 'Bookmark',
    url: 'https://example.com/',
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: options.positionToken ?? 'V',
    resourceRevision: 'bookmark-resource-rev',
    childrenRevision: 'bookmark-children-unused',
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  state.nodes.set(id, row);
  return row;
}

function seedSiblingsUnderRoot(state: MemoryState): void {
  // Ordered A < B < C by position_token
  seedFolder(state, { id: SIBLING_A, positionToken: 'a' });
  seedFolder(state, { id: SIBLING_B, positionToken: 'm' });
  seedFolder(state, { id: SIBLING_C, positionToken: 'z' });
}

function folderCreate(
  overrides: Partial<{
    title: string;
    description: string | null;
    tags: readonly string[];
    visibility: 'inherit' | 'protected' | 'private';
  }> = {},
) {
  return {
    kind: 'folder' as const,
    title: overrides.title ?? 'New Folder',
    description: overrides.description === undefined ? null : overrides.description,
    tags: overrides.tags ?? [],
    visibility: overrides.visibility ?? 'inherit',
  };
}

function bookmarkCreate(
  overrides: Partial<{
    title: string;
    url: string;
    description: string | null;
    tags: readonly string[];
    visibility: 'inherit' | 'protected' | 'private';
  }> = {},
) {
  return {
    kind: 'bookmark' as const,
    title: overrides.title ?? 'New Bookmark',
    url: overrides.url ?? 'https://example.com/page',
    description: overrides.description === undefined ? null : overrides.description,
    tags: overrides.tags ?? [],
    visibility: overrides.visibility ?? 'inherit',
  };
}

function baseInput(overrides: Partial<CreateCollectionNodeInput> = {}): CreateCollectionNodeInput {
  const collectionId = overrides.collectionId ?? COLLECTION_ID;
  return {
    actor: {
      principalId: PRINCIPAL_OWNER,
      principalType: 'account',
      subjectId: SUBJECT_OWNER,
      ...overrides.actor,
    },
    command: {
      commandId: COMMAND_A,
      fingerprint: FINGERPRINT_A,
      commandScope: createCollectionNodeCommandScope(collectionId),
      ...overrides.command,
    },
    collectionId,
    parentId: overrides.parentId ?? ROOT_ID,
    afterId: overrides.afterId === undefined ? null : overrides.afterId,
    beforeId: overrides.beforeId === undefined ? null : overrides.beforeId,
    node: overrides.node ?? folderCreate(),
    nodeId: overrides.nodeId ?? NEW_NODE_ID,
    operationId: overrides.operationId ?? OPERATION_ID,
  };
}

function assertCreated(
  outcome: CreateCollectionNodeResult,
): Extract<CreateCollectionNodeResult, { kind: 'created' }> {
  assert.equal(outcome.kind, 'created', `expected created, got ${outcome.kind}`);
  return outcome as Extract<CreateCollectionNodeResult, { kind: 'created' }>;
}

// ---------------------------------------------------------------------------
// Union discrimination
// ---------------------------------------------------------------------------

describe('createCollectionNode: Folder/Bookmark union', () => {
  test('S-04 website create delegates admission to canonical and propagates capacity refusal', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);
    let admitted = false;
    ports.canonical.execute = async input => {
      admitted = true;
      assert.equal(input.mutation.action, 'create');
      assert.equal(input.mutation.target.resourceId, NEW_NODE_ID);
      throw new SnapshotTreeCapacityError();
    };
    await assert.rejects(
      createCollectionNode(ports, baseInput({ node: bookmarkCreate() })),
      (error: unknown) => error instanceof SnapshotTreeCapacityError && error.code === 'payload_too_large',
    );
    assert.equal(admitted, true);
    assert.equal(state.nodes.has(NEW_NODE_ID), false);
  });

  test('creates folder under root with folderRole null and childrenRevision', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);

    const created = assertCreated(
      await createCollectionNode(ports, baseInput({ node: folderCreate({ title: 'Docs' }) })),
    );

    assert.equal(created.node.kind, 'folder');
    if (created.node.kind !== 'folder') return;
    assert.equal(created.node.folderRole, null);
    assert.equal(created.node.title, 'Docs');
    assert.equal(created.node.parentId, ROOT_ID);
    assert.equal(typeof created.node.position, 'string');
    assert.ok(created.node.position.length >= 1);
    assert.equal(typeof created.node.childrenRevision, 'string');
    assert.equal(created.parent.id, ROOT_ID);
    assert.notEqual(created.parent.childrenRevision, ROOT_CHILDREN_REV);

    const stored = state.nodes.get(created.node.id);
    assert.ok(stored);
    assert.equal(stored!.kind, 'folder');
    assert.equal(stored!.url, null);
    assert.equal(stored!.isRoot, false);
  });

  test('creates bookmark with required url and no childrenRevision field', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);

    const created = assertCreated(
      await createCollectionNode(
        ports,
        baseInput({
          node: bookmarkCreate({
            title: 'RFC',
            url: 'https://www.rfc-editor.org/rfc/rfc7396',
          }),
        }),
      ),
    );

    assert.equal(created.node.kind, 'bookmark');
    if (created.node.kind !== 'bookmark') return;
    assert.equal(created.node.url, 'https://www.rfc-editor.org/rfc/rfc7396');
    assert.equal(created.node.parentId, ROOT_ID);
    assert.equal('childrenRevision' in created.node, false);
    assert.equal(Object.hasOwn(created.node, 'iconUrl'), true);
    assert.equal(created.node.iconUrl, null);
    assert.ok(state.iconLookupCalls >= 1, 'create must project iconUrl via the icon lookup helper');
    assert.doesNotMatch(JSON.stringify(created.node), /favicon\.im|duckduckgo/i);

    const stored = state.nodes.get(created.node.id);
    assert.ok(stored);
    assert.equal(stored!.kind, 'bookmark');
    assert.equal(stored!.url, 'https://www.rfc-editor.org/rfc/rfc7396');
  });
});

// ---------------------------------------------------------------------------
// URL safety
// ---------------------------------------------------------------------------

describe('createCollectionNode: URL safety', () => {
  test('rejects userinfo, file:, javascript:, relative, overlong urls', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);

    const cases: Array<{ label: string; url: string }> = [
      { label: 'userinfo', url: 'https://user:pass@example.com/path' },
      { label: 'userinfo host@', url: 'https://user@example.com/' },
      { label: 'file scheme', url: 'file:///etc/passwd' },
      { label: 'javascript scheme', url: 'javascript:alert(1)' },
      { label: 'relative', url: '/relative/path' },
      { label: 'protocol-relative', url: '//example.com/path' },
      { label: 'overlong', url: `https://example.com/${'x'.repeat(4100)}` },
    ];

    for (const sample of cases) {
      await assert.rejects(
        () =>
          createCollectionNode(
            ports,
            baseInput({
              command: {
                commandId: COMMAND_A,
                fingerprint: FINGERPRINT_A + sample.label,
              },
              node: bookmarkCreate({ url: sample.url }),
              nodeId: `node-${sample.label}`,
              operationId: `op-${sample.label}`,
            }),
          ),
        (error: unknown) => {
          expectCode(error, 'invalid_node_url');
          return true;
        },
      );
    }

    assert.equal(state.operations.length, 0);
    assert.equal(
      [...state.nodes.values()].filter((n) => n.kind === 'bookmark').length,
      0,
    );
  });

  test('accepts absolute http/https without rewriting case/query/fragment', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);
    const raw = 'HTTP://Example.COM/Path?q=1#frag';

    const created = assertCreated(
      await createCollectionNode(ports, baseInput({ node: bookmarkCreate({ url: raw }) })),
    );

    assert.equal(created.node.kind, 'bookmark');
    if (created.node.kind === 'bookmark') {
      assert.equal(created.node.url, raw);
    }
  });
});

// ---------------------------------------------------------------------------
// Parent validation
// ---------------------------------------------------------------------------

describe('createCollectionNode: parent scope/kind/deleted', () => {
  test('parent may be root or folder in same collection', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state, { id: FOLDER_ID, parentId: ROOT_ID, positionToken: 'U' });
    const ports = createMemoryPorts(state);

    const underRoot = assertCreated(
      await createCollectionNode(
        ports,
        baseInput({
          parentId: ROOT_ID,
          nodeId: 'child-root',
          operationId: 'op-under-root',
          command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
        }),
      ),
    );
    assert.equal(underRoot.node.parentId, ROOT_ID);

    const underFolder = assertCreated(
      await createCollectionNode(
        ports,
        baseInput({
          parentId: FOLDER_ID,
          nodeId: 'child-folder',
          operationId: 'op-under-folder',
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
        }),
      ),
    );
    assert.equal(underFolder.node.parentId, FOLDER_ID);
  });

  test('reject bookmark parent', async () => {
    const state = createState();
    seedCollection(state);
    seedBookmark(state, { id: BOOKMARK_ID, parentId: ROOT_ID });
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => createCollectionNode(ports, baseInput({ parentId: BOOKMARK_ID })),
      (error: unknown) => {
        expectCode(error, 'invalid_node_parent');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('reject deleted parent', async () => {
    const state = createState();
    seedCollection(state);
    seedFolder(state, { id: FOLDER_ID, deletedAt: new Date(NOW) });
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => createCollectionNode(ports, baseInput({ parentId: FOLDER_ID })),
      (error: unknown) => {
        expectCode(error, 'invalid_node_parent');
        return true;
      },
    );
  });

  test('reject parent in wrong collection', async () => {
    const state = createState();
    seedCollection(state, { collectionId: COLLECTION_ID });
    // Parent lives only in another collection id
    const otherCol = 'other-col-0001';
    state.nodes.set(FOLDER_ID, {
      id: FOLDER_ID,
      collectionId: otherCol,
      parentId: 'other-root',
      kind: 'folder',
      isRoot: false,
      title: 'Foreign',
      url: null,
      description: null,
      tags: [],
      visibility: 'inherit',
      positionToken: 'U',
      resourceRevision: 'x',
      childrenRevision: 'y',
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      deletedAt: null,
    });
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => createCollectionNode(ports, baseInput({ parentId: FOLDER_ID })),
      (error: unknown) => {
        expectCode(error, 'invalid_node_parent');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

describe('createCollectionNode: position allocation', () => {
  test('first child under empty parent', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);

    const created = assertCreated(await createCollectionNode(ports, baseInput()));
    assert.equal(typeof created.node.position, 'string');
    assert.ok((created.node.position as string).length >= 1);
  });

  test('after anchor places strictly after', async () => {
    const state = createState();
    seedCollection(state);
    seedSiblingsUnderRoot(state);
    const ports = createMemoryPorts(state);

    const created = assertCreated(
      await createCollectionNode(
        ports,
        baseInput({ afterId: SIBLING_A, beforeId: null }),
      ),
    );
    const pos = created.node.position as string;
    assert.ok(pos > 'a', `expected ${pos} > a`);
  });

  test('before anchor places strictly before', async () => {
    const state = createState();
    seedCollection(state);
    seedSiblingsUnderRoot(state);
    const ports = createMemoryPorts(state);

    const created = assertCreated(
      await createCollectionNode(
        ports,
        baseInput({ afterId: null, beforeId: SIBLING_C }),
      ),
    );
    const pos = created.node.position as string;
    assert.ok(pos < 'z', `expected ${pos} < z`);
  });

  test('between adjacent anchors places strictly between', async () => {
    const state = createState();
    seedCollection(state);
    seedSiblingsUnderRoot(state);
    const ports = createMemoryPorts(state);

    const created = assertCreated(
      await createCollectionNode(
        ports,
        baseInput({ afterId: SIBLING_A, beforeId: SIBLING_B }),
      ),
    );
    const pos = created.node.position as string;
    assert.ok(pos > 'a' && pos < 'm', `expected a < ${pos} < m`);
  });

  test('reject non-adjacent after+before pair', async () => {
    const state = createState();
    seedCollection(state);
    seedSiblingsUnderRoot(state);
    const ports = createMemoryPorts(state);

    // A and C have B between them → not adjacent
    await assert.rejects(
      () =>
        createCollectionNode(
          ports,
          baseInput({ afterId: SIBLING_A, beforeId: SIBLING_C }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof NodeConflictError);
        assert.equal(error.code, 'position_context_stale');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });

  test('delegates placement reads to canonical without listing every sibling', async () => {
    const state = createState();
    seedCollection(state);
    seedSiblingsUnderRoot(state);
    const basePorts = createMemoryPorts(state);
    let fullSiblingReads = 0;
    const ports = {
      ...basePorts,
      nodes: {
        ...basePorts.nodes,
        async listLiveSiblingPositions(): Promise<readonly SiblingPositionRow[]> {
          fullSiblingReads += 1;
          throw new Error('Product create must not list all live sibling positions');
        },
      },
    };

    const created = assertCreated(await createCollectionNode(ports, baseInput({
      afterId: SIBLING_A,
      beforeId: SIBLING_B,
    })));
    assert.equal(created.kind, 'created');
    assert.equal(fullSiblingReads, 0);
  });

  test('sibling positions are unique under the same parent', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);

    const first = assertCreated(
      await createCollectionNode(
        ports,
        baseInput({
          nodeId: 'n1',
          operationId: 'op1',
          command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
        }),
      ),
    );
    const second = assertCreated(
      await createCollectionNode(
        ports,
        baseInput({
          nodeId: 'n2',
          operationId: 'op2',
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
        }),
      ),
    );

    assert.notEqual(first.node.position, second.node.position);
    const positions = [...state.nodes.values()]
      .filter((n) => n.parentId === ROOT_ID && n.positionToken)
      .map((n) => n.positionToken);
    assert.equal(new Set(positions).size, positions.length);
  });
});

// ---------------------------------------------------------------------------
// Field authority / limits
// ---------------------------------------------------------------------------

describe('createCollectionNode: field authority and limits', () => {
  test('body cannot set id/position/revision/collectionId on node payload', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);

    for (const evil of [
      { ...folderCreate(), id: 'client-id' },
      { ...folderCreate(), position: 'Z' },
      { ...folderCreate(), revision: 'r' },
      { ...folderCreate(), collectionId: 'other' },
      { ...folderCreate(), resourceRevision: 'r' },
      { ...folderCreate(), parentId: ROOT_ID },
    ] as const) {
      await assert.rejects(
        () =>
          createCollectionNode(
            ports,
            baseInput({
              node: evil as unknown as CreateCollectionNodeInput['node'],
              command: {
                commandId: COMMAND_A,
                fingerprint: FINGERPRINT_A + JSON.stringify(evil),
              },
            }),
          ),
        (error: unknown) => {
          expectCode(error, 'invalid_node_input');
          return true;
        },
      );
    }
    assert.equal(state.operations.length, 0);
  });

  test('blank title rejected; overlong title/description/tags rejected', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);

    await assert.rejects(
      () => createCollectionNode(ports, baseInput({ node: folderCreate({ title: '   ' }) })),
      (error: unknown) => {
        expectCode(error, 'invalid_node_title');
        return true;
      },
    );

    await assert.rejects(
      () =>
        createCollectionNode(
          ports,
          baseInput({ node: folderCreate({ title: 't'.repeat(513) }) }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_title');
        return true;
      },
    );

    await assert.rejects(
      () =>
        createCollectionNode(
          ports,
          baseInput({
            node: folderCreate({ description: 'd'.repeat(20_001) }),
          }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_description');
        return true;
      },
    );

    await assert.rejects(
      () =>
        createCollectionNode(
          ports,
          baseInput({
            node: folderCreate({ tags: Array.from({ length: 65 }, (_, i) => `t${i}`) }),
          }),
        ),
      (error: unknown) => {
        expectCode(error, 'invalid_node_tags');
        return true;
      },
    );

    assert.equal(state.operations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('createCollectionNode: authorization', () => {
  test('owner and editor allowed; viewer denied; stranger concealed', async () => {
    const state = createState();
    seedCollection(state, {
      memberships: [
        { subjectId: SUBJECT_EDITOR, role: 'editor' },
        { subjectId: SUBJECT_VIEWER, role: 'viewer' },
      ],
    });
    const ports = createMemoryPorts(state);

    assertCreated(
      await createCollectionNode(
        ports,
        baseInput({
          actor: {
            principalId: PRINCIPAL_OWNER,
            principalType: 'account',
            subjectId: SUBJECT_OWNER,
          },
          nodeId: 'n-owner',
          operationId: 'op-owner',
          command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A },
        }),
      ),
    );

    assertCreated(
      await createCollectionNode(
        ports,
        baseInput({
          actor: {
            principalId: PRINCIPAL_EDITOR,
            principalType: 'account',
            subjectId: SUBJECT_EDITOR,
          },
          nodeId: 'n-editor',
          operationId: 'op-editor',
          command: { commandId: COMMAND_B, fingerprint: FINGERPRINT_B },
        }),
      ),
    );

    await assert.rejects(
      () =>
        createCollectionNode(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_VIEWER,
              principalType: 'account',
              subjectId: SUBJECT_VIEWER,
            },
            nodeId: 'n-viewer',
            operationId: 'op-viewer',
            command: { commandId: COMMAND_C, fingerprint: FINGERPRINT_A },
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'deny');
        return true;
      },
    );

    await assert.rejects(
      () =>
        createCollectionNode(
          ports,
          baseInput({
            actor: {
              principalId: PRINCIPAL_STRANGER,
              principalType: 'account',
              subjectId: SUBJECT_STRANGER,
            },
            nodeId: 'n-stranger',
            operationId: 'op-stranger',
            command: {
              commandId: 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb',
              fingerprint: FINGERPRINT_B,
            },
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'conceal');
        return true;
      },
    );
  });

  test('policy revision mismatch after lock denies', async () => {
    const state = createState();
    seedCollection(state);
    const base = createMemoryPorts(state);
    const ports = {
      ...base,
      accessPolicy: {
        async loadCollectionFacts(input: Parameters<typeof base.accessPolicy.loadCollectionFacts>[0]) {
          const facts = await base.accessPolicy.loadCollectionFacts(input);
          if (!facts) return null;
          return { ...facts, policyRevision: 'stale-policy-rev' };
        },
      },
    };

    await assert.rejects(
      () => createCollectionNode(ports, baseInput()),
      (error: unknown) => {
        assert.ok(error instanceof CollectionAuthorizationError);
        assert.equal(error.outcome, 'deny');
        assert.equal(error.reasonCategory, 'policy_revision_mismatch');
        return true;
      },
    );
    assert.equal(state.operations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Revisions + operation/audit/outbox
// ---------------------------------------------------------------------------

describe('createCollectionNode: revisions and side effects', () => {
  test('node resource + parent children + content advance; op/audit/outbox once', async () => {
    const state = createState();
    seedCollection(state, {
      contentRevision: CONTENT_REV,
      policyRevision: POLICY_REV,
      commitOrdinal: 3n,
    });
    const ports = createMemoryPorts(state);

    const created = assertCreated(await createCollectionNode(ports, baseInput()));

    const collection = state.collections.get(COLLECTION_ID)!;
    assert.notEqual(collection.contentRevision, CONTENT_REV);
    assert.equal(collection.policyRevision, POLICY_REV); // inherit visibility
    assert.equal(collection.commitOrdinal, 4n);
    assert.equal(created.commitOrdinal, 4n);
    assert.equal(created.fence.contentRevision, collection.contentRevision);
    assert.equal(created.fence.policyRevision, POLICY_REV);

    const node = state.nodes.get(created.node.id)!;
    assert.ok(node.resourceRevision.length > 0);

    const parent = state.nodes.get(ROOT_ID)!;
    assert.notEqual(parent.childrenRevision, ROOT_CHILDREN_REV);
    assert.equal(created.parent.childrenRevision, parent.childrenRevision);

    assert.equal(state.resourceRevisions.length, 1);
    assert.equal(state.resourceRevisions[0]!.resourceId, created.node.id);
    assert.equal(state.contentRevisions.length, 1);
    // Folder create: (1) new folder's initial children ledger + (2) parent children advance
    assert.equal(state.childrenRevisions.length, 2);
    const childrenRevisionParentIds = state.childrenRevisions.map((row) => row.parentId);
    assert.ok(childrenRevisionParentIds.includes(ROOT_ID));
    assert.ok(childrenRevisionParentIds.includes(created.node.id));
    assert.equal(state.policyRevisions.length, 0);

    assert.equal(state.operations.length, 1);
    assert.equal(state.operations[0]!.operationType, 'resource.create');
    assert.equal(state.operations[0]!.actorPrincipalId, PRINCIPAL_OWNER);

    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0]!.eventType, 'resource.create');

    assert.equal(state.outbox.length, 1);
    assert.equal(state.outbox[0]!.eventType, NODE_CREATED_EVENT_TYPE);
    assert.equal(state.outbox[0]!.handlerMode, 'projection_latest_only');
  });

  test('non-inherit visibility advances policy revision', async () => {
    const state = createState();
    seedCollection(state, { policyRevision: POLICY_REV, commitOrdinal: 1n });
    const ports = createMemoryPorts(state);

    const created = assertCreated(
      await createCollectionNode(
        ports,
        baseInput({ node: folderCreate({ visibility: 'private' }) }),
      ),
    );

    assert.equal(created.node.visibility, 'private');
    assert.notEqual(created.fence.policyRevision, POLICY_REV);
    assert.equal(
      state.collections.get(COLLECTION_ID)!.policyRevision,
      created.fence.policyRevision,
    );
    assert.equal(state.policyRevisions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Command admission
// ---------------------------------------------------------------------------

describe('createCollectionNode: command admission', () => {
  test('exact command retry → replay, no double insert', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);
    const input = baseInput();

    const first = assertCreated(await createCollectionNode(ports, input));
    const product = completedReceipt(state);
    const nodeCount = state.nodes.size;
    const opCount = state.operations.length;
    const ledgerCount = state.ledger.length;

    const second = await createCollectionNode(ports, input);
    assert.equal(second.kind, 'replay');
    if (second.kind !== 'replay') return;

    assert.equal(second.status, 201);
    assert.equal(second.status, product.status);
    assert.deepEqual(second.stableHeaders, product.stableHeaders);
    assert.deepEqual(
      Buffer.from(second.body).toString('hex'),
      Buffer.from(product.body).toString('hex'),
    );

    assert.equal(state.nodes.size, nodeCount);
    assert.equal(state.operations.length, opCount);
    assert.equal(state.ledger.length, ledgerCount);
    void first;
  });

  test('same command_id different fingerprint → reused without writes', async () => {
    const state = createState();
    seedCollection(state);
    const ports = createMemoryPorts(state);

    assertCreated(
      await createCollectionNode(
        ports,
        baseInput({ command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_A } }),
      ),
    );
    const after = {
      nodes: state.nodes.size,
      operations: state.operations.length,
      commit: state.collections.get(COLLECTION_ID)!.commitOrdinal,
    };

    const reused = await createCollectionNode(
      ports,
      baseInput({
        node: folderCreate({ title: 'Different intent' }),
        command: { commandId: COMMAND_A, fingerprint: FINGERPRINT_B },
      }),
    );
    assert.equal(reused.kind, 'reused');
    assert.equal(state.nodes.size, after.nodes);
    assert.equal(state.operations.length, after.operations);
    assert.equal(state.collections.get(COLLECTION_ID)!.commitOrdinal, after.commit);
  });

  test('in_progress claim returns without domain writes', async () => {
    const state = createState({ forceInProgress: true });
    seedCollection(state);
    const ports = createMemoryPorts(state);

    const outcome = await createCollectionNode(ports, baseInput());
    assert.equal(outcome.kind, 'in_progress');
    assert.equal(state.operations.length, 0);
    assert.equal(state.ledger.length, 0);
  });
});
