import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import {
  NodeConflictError,
  deleteCollectionNode,
  deleteCollectionNodeCommandScope,
  strongEntityTag,
  type DeleteCollectionNodeInput,
  type NodeWritePort,
  type ProductCollectionCanonicalPorts,
} from '../../../src/modules/collections/index.js';
import {
  COMMAND_A,
  FINGERPRINT_A,
  PRINCIPAL_OWNER,
  SUBJECT_OWNER,
  createMemoryPorts,
  createState,
  type MemoryState,
} from '../../support/memory-collections-write-ports.js';

const COLLECTION_ID = 'col-empty-folder-exists-1';
const ROOT_ID = 'root-empty-folder-exists-1';
const FOLDER_EMPTY = 'folder-empty-exists-1';
const FOLDER_NONEMPTY = 'folder-nonempty-exists-1';
const CHILD = 'bookmark-child-exists-1';

function seed(state: MemoryState): void {
  const now = new Date(state.now);
  state.collections.set(COLLECTION_ID, {
    id: COLLECTION_ID,
    ownerSubjectId: SUBJECT_OWNER,
    title: 'Empty folder exists',
    summary: 'seed',
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: ROOT_ID,
    resourceRevision: 'collection-resource-rev',
    contentRevision: 'collection-content-rev',
    policyRevision: 'collection-policy-rev',
    commitOrdinal: 2n,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  state.memberships.push({ collectionId: COLLECTION_ID, subjectId: SUBJECT_OWNER, role: 'owner' });
  state.nodes.set(ROOT_ID, {
    id: ROOT_ID, collectionId: COLLECTION_ID, parentId: null, kind: 'folder', isRoot: true,
    title: 'Root', url: null, description: null, tags: [], visibility: 'inherit',
    positionToken: null, resourceRevision: 'root-res', childrenRevision: 'root-ch',
    createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
  });
  state.nodes.set(FOLDER_EMPTY, {
    id: FOLDER_EMPTY, collectionId: COLLECTION_ID, parentId: ROOT_ID, kind: 'folder', isRoot: false,
    title: 'Empty', url: null, description: null, tags: [], visibility: 'inherit',
    positionToken: 'a', resourceRevision: 'empty-res', childrenRevision: 'empty-ch',
    createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
  });
  state.nodes.set(FOLDER_NONEMPTY, {
    id: FOLDER_NONEMPTY, collectionId: COLLECTION_ID, parentId: ROOT_ID, kind: 'folder', isRoot: false,
    title: 'Full', url: null, description: null, tags: [], visibility: 'inherit',
    positionToken: 'b', resourceRevision: 'full-res', childrenRevision: 'full-ch',
    createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
  });
  state.nodes.set(CHILD, {
    id: CHILD, collectionId: COLLECTION_ID, parentId: FOLDER_NONEMPTY, kind: 'bookmark', isRoot: false,
    title: 'Child', url: 'https://example.com/', description: null, tags: [], visibility: 'inherit',
    positionToken: 'a', resourceRevision: 'child-res', childrenRevision: 'child-ch',
    createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
  });
}

function input(nodeId: string, ifMatch: string): DeleteCollectionNodeInput {
  return {
    actor: { principalId: PRINCIPAL_OWNER, principalType: 'account', subjectId: SUBJECT_OWNER },
    command: {
      commandId: COMMAND_A,
      fingerprint: FINGERPRINT_A,
      commandScope: deleteCollectionNodeCommandScope(COLLECTION_ID, nodeId),
    },
    collectionId: COLLECTION_ID,
    nodeId,
    ifMatch,
    recursive: false,
    ifContentMatch: null,
  };
}

function withChildrenProbe(
  ports: ProductCollectionCanonicalPorts,
  hasLiveChildren: NodeWritePort['hasLiveChildren'],
): { ports: ProductCollectionCanonicalPorts; readonly siblingCalls: number } {
  const probe = { siblingCalls: 0 };
  return {
    ports: {
      ...ports,
      nodes: {
        ...ports.nodes,
        hasLiveChildren,
        async listLiveSiblingPositions(collectionId, parentId) {
          probe.siblingCalls += 1;
          return ports.nodes.listLiveSiblingPositions(collectionId, parentId);
        },
      },
    },
    get siblingCalls() { return probe.siblingCalls; },
  };
}

test('non-empty folder uses hasLiveChildren and does not list every sibling', async () => {
  const state = createState();
  seed(state);
  const wrapped = withChildrenProbe(createMemoryPorts(state), async () => true);
  await assert.rejects(
    () => deleteCollectionNode(wrapped.ports, input(FOLDER_NONEMPTY, strongEntityTag('full-res'))),
    (error: unknown) => error instanceof NodeConflictError && error.code === 'folder_not_empty',
  );
  assert.equal(wrapped.siblingCalls, 0);
  assert.equal(state.nodes.get(FOLDER_NONEMPTY)!.deletedAt, null);
  assert.equal(state.nodes.get(CHILD)!.deletedAt, null);
});

test('empty folder uses hasLiveChildren and still soft-deletes without listing siblings', async () => {
  const state = createState();
  seed(state);
  const wrapped = withChildrenProbe(createMemoryPorts(state), async () => false);
  const deleted = await deleteCollectionNode(
    wrapped.ports,
    input(FOLDER_EMPTY, strongEntityTag('empty-res')),
  );
  assert.equal(deleted.kind, 'deleted');
  assert.equal(wrapped.siblingCalls, 0);
  assert.ok(state.nodes.get(FOLDER_EMPTY)!.deletedAt);
});

test('folder emptiness falls back to listLiveSiblingPositions when hasLiveChildren is omitted', async () => {
  const state = createState();
  seed(state);
  const wrapped = withChildrenProbe(createMemoryPorts(state), undefined);
  await assert.rejects(
    () => deleteCollectionNode(wrapped.ports, input(FOLDER_NONEMPTY, strongEntityTag('full-res'))),
    (error: unknown) => error instanceof NodeConflictError && error.code === 'folder_not_empty',
  );
  assert.equal(wrapped.siblingCalls, 1);
});

test('Postgres live-child probe is an EXISTS with LIMIT 1', async () => {
  const source = await readFile(
    new URL('../../../src/infrastructure/collections/repositories.ts', import.meta.url),
    'utf8',
  );
  const method = source.slice(source.indexOf('async hasLiveChildren'));
  assert.match(method, /SELECT EXISTS/);
  assert.match(method, /LIMIT 1/);
  assert.match(method, /parent_id = \$\{parentId\}/);
  assert.match(method, /deleted_at IS NULL/);
});
