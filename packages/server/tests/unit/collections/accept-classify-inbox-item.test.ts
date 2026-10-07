import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  CLASSIFY_INBOX_ACCEPT_COMMAND_SCOPE,
  ClassifyInboxAcceptError,
  CollectionPreconditionError,
  NodeConflictError,
  acceptClassifyInboxFingerprint,
  acceptClassifyInboxItem,
  parseClassifyInboxAcceptBody,
  type AcceptClassifyInboxItemPorts,
  type ClassifyInboxAcceptInsertResult,
  type ClassifyInboxAcceptSnapshot,
  type LockedCollectionRow,
  type LockedNodeRow,
  type MoveCollectionNodeResult,
  type ProductCollectionCanonicalPorts,
} from '../../../src/modules/collections/index.js';
import { createMemoryProductCommandReceiptPort } from '../../support/product-http-harness.js';

const NOW = new Date('2026-08-24T08:00:00.000Z');
const NODE_ID = 'node-bookmark';
const FOLDER_ID = 'fld-spacing';
const ROOT_ID = 'root-classify';
const COLLECTION_ID = 'col-classify-inbox';
const PRINCIPAL = 'acct-owner';
const SUBJECT = 'subject-owner';
const IF_MATCH = '"rev-bookmark"';

function eligibleSnapshot(
  overrides: Partial<ClassifyInboxAcceptSnapshot> = {},
): ClassifyInboxAcceptSnapshot {
  return {
    nodeId: NODE_ID,
    collectionId: COLLECTION_ID,
    isOwner: true,
    kind: 'bookmark',
    softDeleted: false,
    url: 'https://system.example.com/essay',
    parentKind: 'root',
    parentId: ROOT_ID,
    resourceRevision: 'rev-bookmark',
    sidecarStatus: null,
    ...overrides,
  };
}

function lockedCollection(): LockedCollectionRow {
  return {
    id: COLLECTION_ID,
    ownerSubjectId: SUBJECT,
    title: 'Library',
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: ROOT_ID,
    resourceRevision: 'col-rev',
    contentRevision: 'col-cv',
    policyRevision: 'col-pv',
    commitOrdinal: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function lockedNode(id: string, overrides: Partial<LockedNodeRow> = {}): LockedNodeRow {
  return {
    id,
    collectionId: COLLECTION_ID,
    parentId: id === ROOT_ID ? null : ROOT_ID,
    kind: id === NODE_ID ? 'bookmark' : 'folder',
    isRoot: id === ROOT_ID,
    title: id,
    url: id === NODE_ID ? 'https://system.example.com/essay' : null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: 'A',
    resourceRevision: `rev-${id}`,
    childrenRevision: `cr-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function memoryPorts(initial: ClassifyInboxAcceptSnapshot | null, options: {
  readonly folder?: LockedNodeRow | null;
  readonly move?: AcceptClassifyInboxItemPorts['move'];
} = {}): {
  readonly ports: AcceptClassifyInboxItemPorts;
  readonly writes: string[];
  readonly moveCalls: Array<Parameters<AcceptClassifyInboxItemPorts['move']>[1]>;
} {
  const receipts = new Map();
  const writes: string[] = [];
  const moveCalls: Array<Parameters<AcceptClassifyInboxItemPorts['move']>[1]> = [];
  let snapshot = initial;
  const folder = options.folder === undefined
    ? lockedNode(FOLDER_ID, { kind: 'folder', isRoot: false, parentId: ROOT_ID })
    : options.folder;
  const collection: ProductCollectionCanonicalPorts = {
    receipts: createMemoryProductCommandReceiptPort(new Map()),
    clock: { now: async () => NOW },
    collections: {
      async lockForUpdate(collectionId) {
        if (snapshot === null || snapshot.collectionId !== collectionId) return null;
        return lockedCollection();
      },
    },
    nodes: {
      async getNode(collectionId, nodeId) {
        if (snapshot === null || snapshot.collectionId !== collectionId) return null;
        if (nodeId === FOLDER_ID) return folder;
        if (nodeId === ROOT_ID) return lockedNode(ROOT_ID);
        if (nodeId === snapshot.nodeId) {
          return lockedNode(snapshot.nodeId, {
            parentId: snapshot.parentId,
            resourceRevision: snapshot.resourceRevision,
            kind: 'bookmark',
            isRoot: false,
          });
        }
        return null;
      },
      readParentAncestry: async () => [],
      listLiveSiblingPositions: async () => [],
    },
    accessPolicy: { loadCollectionFacts: async () => null },
    canonical: {
      execute: async () => { throw new Error('canonical.execute must not run when move is injected'); },
      bootstrapOwnedCollection: async () => {
        throw new Error('bootstrapOwnedCollection must not run');
      },
    },
  };
  const ports: AcceptClassifyInboxItemPorts = {
    receipts: createMemoryProductCommandReceiptPort(receipts),
    inbox: {
      async loadEligibilitySnapshot(query) {
        if (snapshot === null) return null;
        if (snapshot.nodeId !== query.nodeId) return null;
        if (query.ownerSubjectId !== SUBJECT) return null;
        return snapshot;
      },
      async insertAccepted(query) {
        if (snapshot === null || snapshot.nodeId !== query.nodeId) return 'blocked';
        if (snapshot.sidecarStatus === 'accepted') return 'already_accepted';
        if (snapshot.sidecarStatus === 'skipped') return 'blocked';
        snapshot = {
          ...snapshot,
          sidecarStatus: 'accepted',
          parentId: query.suggestionId,
          parentKind: 'folder',
        };
        writes.push(query.nodeId);
        return 'inserted' satisfies ClassifyInboxAcceptInsertResult;
      },
    },
    clock: { now: async () => NOW },
    collection,
    vocabulary: {existingTags: async (_id,tags) => tags},
    move: async (movePorts, input) => {
      moveCalls.push(input);
      if (options.move) return options.move(movePorts, input);
      return { kind: 'moved' } as MoveCollectionNodeResult;
    },
  };
  return { ports, writes, moveCalls };
}

function actorInput(commandId: string, extra: {
  readonly nodeId?: string;
  readonly suggestionId?: string;
  readonly ifMatch?: string;
} = {}) {
  return {
    actor: { principalId: PRINCIPAL, subjectId: SUBJECT },
    commandId,
    nodeId: extra.nodeId ?? NODE_ID,
    ifMatch: extra.ifMatch ?? IF_MATCH,
    body: { suggestionId: extra.suggestionId ?? FOLDER_ID },
  };
}

test('parseClassifyInboxAcceptBody requires suggestionId only', () => {
  assert.deepEqual(parseClassifyInboxAcceptBody({ suggestionId: FOLDER_ID }), { suggestionId: FOLDER_ID });
  assert.throws(
    () => parseClassifyInboxAcceptBody({}),
    (error: unknown) => error instanceof ClassifyInboxAcceptError && error.code === 'invalid_document',
  );
  assert.throws(
    () => parseClassifyInboxAcceptBody({ suggestionId: FOLDER_ID, extra: true }),
    (error: unknown) => error instanceof ClassifyInboxAcceptError && error.code === 'invalid_document',
  );
});

test('fingerprint and command scope are distinct from skip and link-health', () => {
  const left = acceptClassifyInboxFingerprint(NODE_ID, FOLDER_ID, IF_MATCH);
  const right = acceptClassifyInboxFingerprint(NODE_ID, 'other-folder', IF_MATCH);
  assert.notEqual(left, right);
  assert.equal(acceptClassifyInboxFingerprint(NODE_ID, FOLDER_ID, IF_MATCH), left);
  assert.equal(CLASSIFY_INBOX_ACCEPT_COMMAND_SCOPE, 'collections:classify-inbox-accept:v1');
  assert.equal(CLASSIFY_INBOX_ACCEPT_COMMAND_SCOPE.includes('skip'), false);
  assert.equal(CLASSIFY_INBOX_ACCEPT_COMMAND_SCOPE.includes('link-health'), false);
});

test('eligible accept calls move once, writes sidecar, and returns accepted receipt', async () => {
  const { ports, writes, moveCalls } = memoryPorts(eligibleSnapshot());
  const result = await acceptClassifyInboxItem(ports, actorInput(randomUUID()));
  assert.equal(result.kind, 'succeeded');
  if (result.kind !== 'succeeded') return;
  assert.deepEqual(result.receipt, { nodeId: NODE_ID, decision: 'accepted', folderId: FOLDER_ID });
  assert.deepEqual(writes, [NODE_ID]);
  assert.equal(moveCalls.length, 1);
  assert.equal(moveCalls[0]?.newParentId, FOLDER_ID);
  assert.equal(moveCalls[0]?.afterId, null);
  assert.equal(moveCalls[0]?.beforeId, null);
  assert.equal(moveCalls[0]?.command.commandScope?.includes('classify-inbox-accept'), false);
});

test('same Known-Command-Id replays the first receipt without a second move or sidecar', async () => {
  const { ports, writes, moveCalls } = memoryPorts(eligibleSnapshot());
  const commandId = randomUUID();
  const first = await acceptClassifyInboxItem(ports, actorInput(commandId));
  const replay = await acceptClassifyInboxItem(ports, actorInput(commandId));
  assert.equal(first.kind, 'succeeded');
  assert.equal(replay.kind, 'replay');
  if (first.kind !== 'succeeded' || replay.kind !== 'replay') return;
  assert.equal(replay.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString('utf8')), first.receipt);
  assert.deepEqual(writes, [NODE_ID]);
  assert.equal(moveCalls.length, 1);
});

test('already accepted and still in that folder is 200 without another move', async () => {
  const { ports, writes, moveCalls } = memoryPorts(eligibleSnapshot({
    sidecarStatus: 'accepted',
    parentKind: 'folder',
    parentId: FOLDER_ID,
  }));
  const result = await acceptClassifyInboxItem(ports, actorInput(randomUUID()));
  assert.equal(result.kind, 'succeeded');
  if (result.kind !== 'succeeded') return;
  assert.deepEqual(result.receipt, { nodeId: NODE_ID, decision: 'accepted', folderId: FOLDER_ID });
  assert.deepEqual(writes, []);
  assert.equal(moveCalls.length, 0);
});

test('wrong suggestionId, skipped, missing, and foreign nodes conceal as resource_not_found', async () => {
  const wrongFolder = memoryPorts(eligibleSnapshot());
  await assert.rejects(
    () => acceptClassifyInboxItem(wrongFolder.ports, actorInput(randomUUID(), { suggestionId: 'fld-missing' })),
    (error: unknown) => error instanceof ClassifyInboxAcceptError && error.code === 'resource_not_found',
  );
  assert.deepEqual(wrongFolder.writes, []);
  assert.equal(wrongFolder.moveCalls.length, 0);

  const skipped = memoryPorts(eligibleSnapshot({ sidecarStatus: 'skipped' }));
  await assert.rejects(
    () => acceptClassifyInboxItem(skipped.ports, actorInput(randomUUID())),
    (error: unknown) => error instanceof ClassifyInboxAcceptError && error.code === 'resource_not_found',
  );
  assert.equal(skipped.moveCalls.length, 0);

  const missing = memoryPorts(null);
  await assert.rejects(
    () => acceptClassifyInboxItem(missing.ports, actorInput(randomUUID())),
    (error: unknown) => error instanceof ClassifyInboxAcceptError && error.code === 'resource_not_found',
  );

  const foreign = memoryPorts(eligibleSnapshot());
  await assert.rejects(
    () => acceptClassifyInboxItem(foreign.ports, {
      actor: { principalId: PRINCIPAL, subjectId: 'subject-stranger' },
      commandId: randomUUID(),
      nodeId: NODE_ID,
      ifMatch: IF_MATCH,
      body: { suggestionId: FOLDER_ID },
    }),
    (error: unknown) => error instanceof ClassifyInboxAcceptError && error.code === 'resource_not_found',
  );
  assert.equal(foreign.moveCalls.length, 0);
});

test('move failure leaves no sidecar', async () => {
  const { ports, writes } = memoryPorts(eligibleSnapshot(), {
    move: async () => {
      throw new NodeConflictError('revision_conflict', 'source parent children revision does not match');
    },
  });
  await assert.rejects(
    () => acceptClassifyInboxItem(ports, actorInput(randomUUID())),
    (error: unknown) => error instanceof NodeConflictError && error.code === 'revision_conflict',
  );
  assert.deepEqual(writes, []);
});

test('stale If-Match on an already accepted item is CollectionPreconditionError', async () => {
  const { ports, moveCalls } = memoryPorts(eligibleSnapshot({
    sidecarStatus: 'accepted',
    parentKind: 'folder',
    parentId: FOLDER_ID,
  }));
  await assert.rejects(
    () => acceptClassifyInboxItem(ports, actorInput(randomUUID(), { ifMatch: '"stale-rev"' })),
    (error: unknown) => error instanceof CollectionPreconditionError,
  );
  assert.equal(moveCalls.length, 0);
});

test('move replay after a crash still upserts the accepted sidecar', async () => {
  const { ports, writes, moveCalls } = memoryPorts(eligibleSnapshot({
    parentKind: 'folder',
    parentId: FOLDER_ID,
  }), {
    move: async () => ({
      kind: 'replay',
      status: 200,
      body: new Uint8Array(),
      stableHeaders: {},
      mediaType: 'application/json',
      contractVersion: '1.0.0',
    }) as MoveCollectionNodeResult,
  });
  const result = await acceptClassifyInboxItem(ports, actorInput(randomUUID()));
  assert.equal(result.kind, 'succeeded');
  if (result.kind !== 'succeeded') return;
  assert.deepEqual(result.receipt, { nodeId: NODE_ID, decision: 'accepted', folderId: FOLDER_ID });
  assert.deepEqual(writes, [NODE_ID]);
  assert.equal(moveCalls.length, 1);
});

test('optional addTags is closed, bounded and fingerprinted without changing legacy intent',()=>{
  assert.deepEqual(parseClassifyInboxAcceptBody({suggestionId:FOLDER_ID,addTags:['AI','ai']}),{suggestionId:FOLDER_ID,addTags:['AI','ai']});
  for(const addTags of [null,['AI','AI'],['a','b','c','d'],['x'.repeat(65)]])assert.throws(()=>parseClassifyInboxAcceptBody({suggestionId:FOLDER_ID,addTags}));
  const legacy=acceptClassifyInboxFingerprint(NODE_ID,FOLDER_ID,IF_MATCH);
  assert.equal(legacy,acceptClassifyInboxFingerprint(NODE_ID,FOLDER_ID,IF_MATCH,undefined));
  assert.notEqual(legacy,acceptClassifyInboxFingerprint(NODE_ID,FOLDER_ID,IF_MATCH,[]));
  assert.notEqual(acceptClassifyInboxFingerprint(NODE_ID,FOLDER_ID,IF_MATCH,['AI']),acceptClassifyInboxFingerprint(NODE_ID,FOLDER_ID,IF_MATCH,['ai']));
});
